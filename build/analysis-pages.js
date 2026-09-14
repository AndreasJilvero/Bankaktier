// Builds the /analys/ section of the self-hosted site: one static page per stock with
// its full LLM-written analysis, plus an index page listing all of them with verdicts.
// Also merges each stock's verdict into data.json so the main table can show a badge.
// Run after fetch-data.js and analyze-stocks.js.
const fs = require('fs');
const path = require('path');

const COUNTRY_LABEL = { SE: 'Sverige', DK: 'Danmark', FI: 'Finland', NO: 'Norge' };
const COUNTRY_FLAG = { SE: '🇸🇪', DK: '🇩🇰', FI: '🇫🇮', NO: '🇳🇴' };
const VERDICT_LABEL = { Buy: 'Köp', Neutral: 'Neutral', Sell: 'Sälj' };
const VERDICT_CLASS = { Buy: 'verdict-buy', Neutral: 'verdict-neutral', Sell: 'verdict-sell' };

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtPrice(v, currency) {
  if (v == null) return '';
  return v.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (currency ? ` ${currency}` : '');
}

function fmtNum(v, decimals) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toLocaleString('sv-SE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtPct(v, decimals) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const s = v.toLocaleString('sv-SE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return (v > 0 ? '+' : '') + s + '%';
}
function fmtMcap(v) {
  if (v === null || v === undefined) return '—';
  return (v / 1e9).toLocaleString('sv-SE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' Mdkr';
}

// Full metric set for the stock's analysis page — includes everything shown in the main
// table plus the columns moved off it (Beta, utdelningsandel, marginaler) to keep the
// table itself scannable without a wide horizontal scroll. Rendered as small labeled
// tiles grouped by theme in a responsive grid (several per row) rather than one long
// single-column table, so related metrics (e.g. all valuation multiples) sit together
// and the section doesn't dominate the page vertically.
function renderMetricsTable(stock) {
  const rec = stock.recommendations;
  const recText = rec
    ? `${rec.strongBuy + rec.buy} köp / ${rec.hold} behåll / ${rec.sell + rec.strongSell} sälj`
    : '—';
  // Each row pairs two groups so every row totals 6 tiles (2x3 or 4x2 split as needed).
  const rows = [
    [
      {
        title: 'Kurs & utveckling',
        tiles: [
          ['Kurs', `${fmtNum(stock.price, 2)} ${stock.currency}`],
          ['Idag', fmtPct(stock.changeToday, 2)],
          ['3 månader', fmtPct(stock.change3m, 2)],
          ['12 månader', fmtPct(stock.change12m, 2)],
          ['52v-intervall', stock.fiftyTwoWeekLow != null && stock.fiftyTwoWeekHigh != null ? `${fmtNum(stock.fiftyTwoWeekLow, 0)}–${fmtNum(stock.fiftyTwoWeekHigh, 0)}` : '—'],
          ['Beta', stock.beta != null ? fmtNum(stock.beta, 2) : '—'],
        ],
      },
    ],
    [
      {
        title: 'Värdering',
        tiles: [
          ['Börsvärde', fmtMcap(stock.marketCap)],
          ['P/E', stock.trailingPE != null ? fmtNum(stock.trailingPE, 1) : '—'],
          ['P/E prognos', stock.forwardPE != null ? fmtNum(stock.forwardPE, 1) : '—'],
          ['P/B', stock.priceToBook != null ? fmtNum(stock.priceToBook, 2) : '—'],
        ],
      },
      {
        title: 'Utdelning',
        tiles: [
          ['Direktavkastning', stock.dividendYield != null ? fmtNum(stock.dividendYield, 2) + '%' : '—'],
          ['Utdelningsandel', stock.payoutRatio != null ? fmtNum(stock.payoutRatio, 0) + '%' : '—'],
        ],
      },
    ],
    [
      {
        title: 'Analytiker',
        tiles: [
          ['Riktkurs (snitt)', stock.targetMeanPrice != null ? `${Math.round(stock.targetMeanPrice)} ${stock.currency}` : '—'],
          ['Uppsida', fmtPct(stock.upside, 1)],
          ['Rekommendationer', recText],
        ],
      },
      {
        title: 'Lönsamhet',
        tiles: [
          ['ROE', stock.returnOnEquity != null ? fmtNum(stock.returnOnEquity, 1) + '%' : '—'],
          ['Rörelsemarginal', stock.operatingMargin != null ? fmtNum(stock.operatingMargin, 1) + '%' : '—'],
          ['Nettomarginal', stock.netMargin != null ? fmtNum(stock.netMargin, 1) + '%' : '—'],
        ],
      },
    ],
  ];
  return rows.map((row) => `<div class="metrics-row">
    ${row.map((g) => `<div class="metrics-group">
      <h3 class="metrics-group-title">${esc(g.title)}</h3>
      <div class="metrics-grid">
        ${g.tiles.map(([label, value]) => `<div class="metric-tile"><span class="metric-label">${esc(label)}</span><span class="metric-value">${esc(value)}</span></div>`).join('\n        ')}
      </div>
    </div>`).join('\n    ')}
  </div>`).join('\n  ');
}

// Analysis text is plain prose from the LLM (Swedish, no markdown expected) — split
// into paragraphs on blank lines and escape, rather than trusting it as pre-formed HTML.
function renderParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('\n');
}

// Compact, single-row shared header for every page this module renders (the /analys/
// index and each per-stock page): site name, a link to the analyses index, and the two
// live index prices — matching build/app.html's IDs closely enough to reuse its
// Yahoo-proxy live-fetch pattern.
function siteHeader() {
  return `<header class="site-header">
    <a class="brand" href="../">Bankaktier Norden</a>
    <a class="site-nav-link" href="./">Alla analyser</a>
    <span class="site-index"><span class="site-index-label">OMXS30</span><span class="num" id="bannerOmx">—</span></span>
    <span class="site-index"><span class="site-index-label">Bankindex</span><span class="num" id="bannerBanks">—</span></span>
  </header>`;
}

// Minimal, self-contained port of app.html's live index-banner fetch (same Cloudflare
// Worker proxy, same Yahoo symbols) — kept deliberately small since these are otherwise
// fully static pages with no other client-side JS.
const SITE_BANNER_SCRIPT = `<script>
(function(){
  var YAHOO_PROXY_URL = 'https://bankaktier-yahoo-proxy.suboptimalprime.workers.dev';
  function isArtifactSandbox(){
    return /\\.claude(usercontent)?\\.(ai|com)$/i.test(location.hostname) || location.hostname === 'claude.site';
  }
  function fetchYahooQuote(symbol){
    var url = YAHOO_PROXY_URL + '/?symbol=' + encodeURIComponent(symbol);
    return fetch(url, { cache: 'no-store' }).then(function(r){
      if (!r.ok) throw new Error('proxy returned ' + r.status);
      return r.json();
    }).then(function(data){
      if (data.error || typeof data.price !== 'number') throw new Error(data.error || 'no price');
      return data;
    });
  }
  function fmtPct(v){
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    var s = Math.round(v * 100) / 100;
    return (s > 0 ? '+' : '') + s.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  }
  function pctClass(v){ return v > 0 ? 'up' : (v < 0 ? 'down' : ''); }
  if (isArtifactSandbox()) return;
  var omxEl = document.getElementById('bannerOmx');
  var banksEl = document.getElementById('bannerBanks');
  if (!omxEl || !banksEl) return;
  fetchYahooQuote('^OMX').then(function(d){
    omxEl.textContent = fmtPct(d.changePercent);
    omxEl.className = 'banner-value num ' + pctClass(d.changePercent);
  }).catch(function(){});
  fetchYahooQuote('^SX3010GI').then(function(d){
    banksEl.textContent = fmtPct(d.changePercent);
    banksEl.className = 'banner-value num ' + pctClass(d.changePercent);
  }).catch(function(){});
})();
</script>`;

function pageShell({ title, description, siteUrl, bodyHtml, canonicalPath, noindex }) {
  const canonical = !noindex && siteUrl ? `<link rel="canonical" href="${esc(siteUrl.replace(/\/+$/, ''))}${canonicalPath}">` : '';
  const headMeta = noindex
    ? `<meta name="robots" content="noindex, nofollow">`
    : `${canonical}
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Bankaktier Norden">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">`;
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${headMeta}
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --paper:#F7F5EF; --paper-raised:#FFFFFF; --ink:#16241C; --ink-soft:#4B5750;
    --line:#DAD4C4; --line-soft:#E7E2D4; --spruce:#2B5C4B; --spruce-deep:#1D4136;
    --spruce-wash:#E7EFEA; --copper:#B5601F; --gain:#1E7A4C; --gain-wash:#E4F2E9;
    --loss:#B23B3B; --loss-wash:#F7E7E5; --neutral:#8A6B1F; --neutral-wash:#F2EBD8;
    --shadow:0 1px 2px rgba(22,36,28,0.06), 0 8px 24px -12px rgba(22,36,28,0.18);
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --paper:#141A16; --paper-raised:#1B231D; --ink:#EDEEE8; --ink-soft:#A9B2A7;
      --line:#3A4239; --line-soft:#2A3128; --spruce:#5FA98A; --spruce-deep:#7FC2A3;
      --spruce-wash:#1E2C25; --copper:#E0985A; --gain:#5FC08A; --gain-wash:#1B2A20;
      --loss:#E27A72; --loss-wash:#2E1E1C; --neutral:#D9B45C; --neutral-wash:#2E2818;
      --shadow:0 1px 2px rgba(0,0,0,0.3), 0 8px 24px -12px rgba(0,0,0,0.5);
    }
  }
  :root[data-theme="dark"]{
    --paper:#141A16; --paper-raised:#1B231D; --ink:#EDEEE8; --ink-soft:#A9B2A7;
    --line:#3A4239; --line-soft:#2A3128; --spruce:#5FA98A; --spruce-deep:#7FC2A3;
    --spruce-wash:#1E2C25; --copper:#E0985A; --gain:#5FC08A; --gain-wash:#1B2A20;
    --loss:#E27A72; --loss-wash:#2E1E1C; --neutral:#D9B45C; --neutral-wash:#2E2818;
    --shadow:0 1px 2px rgba(0,0,0,0.3), 0 8px 24px -12px rgba(0,0,0,0.5);
  }
  *{box-sizing:border-box;}
  body{margin:0; background:var(--paper); color:var(--ink); font-family:'IBM Plex Sans', system-ui, sans-serif; padding-inline:20px; padding-block:18px 40px;}
  .wrap{max-width:1180px; margin:0 auto;}
  h1,h2{font-family:'Source Serif 4', Georgia, serif; text-wrap:balance; margin:0;}
  a{color:var(--spruce-deep);}
  .breadcrumb{font-size:0.82rem; color:var(--ink-soft); margin-block-end:18px;}
  .breadcrumb a{color:var(--ink-soft); text-decoration:underline;}
  header.site-header{
    display:flex; flex-wrap:wrap; gap:8px 16px; align-items:center;
    padding-block:10px; margin-block-end:20px; border-bottom:2px solid var(--ink);
    font-size:0.86rem;
  }
  .site-header .brand{font-family:'Source Serif 4', Georgia, serif; font-weight:700; font-size:1.05rem; text-decoration:none; color:var(--ink); margin-inline-end:auto;}
  .site-nav-link{color:var(--spruce-deep); text-decoration:underline; text-underline-offset:2px; font-weight:600;}
  .site-nav-link:hover{color:var(--spruce);}
  .site-index{display:flex; align-items:baseline; gap:5px; font-family:'IBM Plex Mono', monospace;}
  .site-index-label{color:var(--ink-soft); font-size:0.72rem;}
  .site-index .num.up{color:var(--gain);}
  .site-index .num.down{color:var(--loss);}
  header.page-head{border-bottom:2px solid var(--ink); padding-block-end:16px; margin-block-end:20px;}
  header.page-head h1{font-size:clamp(1.5rem, 1.2rem + 1.4vw, 2rem); font-weight:700; line-height:1.15;}
  .page-head .sub{margin:8px 0 0; color:var(--ink-soft); font-size:0.92rem;}
  .verdict-badge{
    display:inline-flex; align-items:center; gap:6px; padding:5px 14px; border-radius:20px;
    font-size:0.82rem; font-weight:600; margin-block-start:12px;
  }
  .verdict-buy{background:var(--gain-wash); color:var(--gain);}
  .verdict-neutral{background:var(--neutral-wash); color:var(--neutral);}
  .verdict-sell{background:var(--loss-wash); color:var(--loss);}
  .analyzed-stamp{margin:8px 0 0; font-size:0.78rem; color:var(--ink-soft); font-family:'IBM Plex Mono', monospace;}
  .price-at-analysis{display:block; margin-block-start:10px; font-size:0.85rem; color:var(--ink-soft); font-family:'IBM Plex Mono', monospace;}
  article{background:var(--paper-raised); border:1px solid var(--line); border-radius:10px; padding:22px 26px; box-shadow:var(--shadow); font-size:1rem; line-height:1.7;}
  article p{margin:0 0 14px;}
  article p:last-child{margin-bottom:0;}
  .meta{margin-block-start:16px; font-size:0.78rem; color:var(--ink-soft); font-family:'IBM Plex Mono', monospace;}
  .disclaimer{margin-block-start:20px; font-size:0.78rem; color:var(--ink-soft); line-height:1.6;}
  .metrics-heading{font-size:1rem; margin-block:24px 10px;}
  .metrics-row{display:flex; flex-wrap:wrap; gap:16px; margin-block-end:14px;}
  .metrics-row .metrics-group{flex:1 1 260px;}
  .metrics-group-title{font-family:'IBM Plex Sans', system-ui, sans-serif; font-size:0.72rem; font-weight:600; letter-spacing:0.03em; text-transform:uppercase; color:var(--ink-soft); margin:0 0 6px;}
  .metrics-grid{display:grid; grid-template-columns:repeat(auto-fit, minmax(0, 1fr)); gap:8px;}
  .metric-tile{
    background:var(--paper-raised); border:1px solid var(--line); border-radius:8px; padding:8px 10px;
    display:flex; flex-direction:column; gap:2px; box-shadow:var(--shadow);
  }
  .metric-label{font-size:0.68rem; color:var(--ink-soft); line-height:1.2;}
  .metric-value{font-size:0.9rem; font-weight:600; font-family:'IBM Plex Mono', monospace;}
  .index-list{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px;}
  .index-list li{border-bottom:1px solid var(--line-soft);}
  .index-list a{
    display:flex; justify-content:space-between; align-items:center; gap:12px; padding:14px 4px;
    text-decoration:none; color:var(--ink);
  }
  .index-list a:hover{color:var(--spruce-deep);}
  .index-name{font-weight:600;}
  .index-country{font-size:0.8rem; color:var(--ink-soft); font-weight:400;}
  .index-right{display:flex; flex-direction:column; align-items:flex-end; gap:4px;}
  .index-meta{font-size:0.74rem; color:var(--ink-soft); font-family:'IBM Plex Mono', monospace;}
  .empty-note{color:var(--ink-soft); font-size:0.92rem; padding:20px 0;}
  .debug-block{background:var(--paper-raised); border:1px solid var(--line); border-radius:10px; padding:16px 18px; box-shadow:var(--shadow); margin-block-end:18px;}
  .debug-block h2{font-size:0.95rem; margin-block-end:10px;}
  .debug-block pre{white-space:pre-wrap; word-break:break-word; font-family:'IBM Plex Mono', monospace; font-size:0.82rem; line-height:1.55; margin:0; color:var(--ink);}
  :focus-visible{outline:2px solid var(--spruce); outline-offset:2px;}
</style>
</head>
<body>
<div class="wrap">
${siteHeader()}
${bodyHtml}
</div>
${SITE_BANNER_SCRIPT}
</body>
</html>
`;
}

function buildAnalysisPages(data, analysesData, { siteUrl } = {}) {
  const analyses = analysesData.analyses || {};
  const stocksById = Object.fromEntries(data.stocks.map((s) => [s.id, s]));

  const pages = {};

  // Index page
  const indexRows = Object.entries(analyses)
    .map(([id, a]) => ({ id, ...a, stock: stocksById[id] }))
    .filter((a) => a.stock)
    .sort((a, b) => a.stock.name.localeCompare(b.stock.name, 'sv'));

  const indexBody = `
  <header class="page-head">
    <h1>Aktieanalyser</h1>
    <p class="sub">Analyser av nordiska bankaktier. Täcker värdering, prognoser och makroläge per land.</p>
  </header>
  ${indexRows.length ? `<ul class="index-list">
    ${indexRows.map((a) => `<li><a href="./${esc(a.id)}.html"><span class="index-name">${COUNTRY_FLAG[a.stock.country] || ''} ${esc(a.stock.name)} <span class="index-country">${esc(COUNTRY_LABEL[a.stock.country] || a.stock.country)}</span></span><span class="index-right"><span class="verdict-badge ${VERDICT_CLASS[a.verdict] || 'verdict-neutral'}">${esc(VERDICT_LABEL[a.verdict] || a.verdict)}</span><span class="index-meta" title="Kurs vid analystillfället">${a.priceAtAnalysis != null ? `Kurs vid analys ${esc(fmtPrice(a.priceAtAnalysis, a.currency))}` + ' &middot; ' : ''}${a.generatedAt ? esc(a.generatedAt.slice(0, 10)) : ''}</span></span></a></li>`).join('\n    ')}
  </ul>` : `<p class="empty-note">Inga analyser genererade ännu.</p>`}
  <p class="disclaimer">Analyserna är inte investeringsrådgivning och kan innehålla felaktigheter — verifiera alltid själv innan du fattar investeringsbeslut.</p>
`;

  pages['analys/index.html'] = pageShell({
    title: 'Aktieanalyser — Bankaktier Norden',
    description: 'Analyser av nordiska bankaktier: värdering, prognoser och makroläge.',
    siteUrl,
    canonicalPath: '/analys/',
    bodyHtml: indexBody,
  });

  // Per-stock pages
  for (const [id, a] of Object.entries(analyses)) {
    const stock = stocksById[id];
    if (!stock) continue;
    const analyzedDate = a.generatedAt ? a.generatedAt.slice(0, 10) : '';
    const body = `
  <p class="breadcrumb"><a href="../">Bankaktier Norden</a> &rsaquo; <a href="./">Analyser</a> &rsaquo; ${esc(stock.name)}</p>
  <header class="page-head">
    <h1>${COUNTRY_FLAG[stock.country] || ''} ${esc(stock.name)}</h1>
    <p class="sub">${esc(stock.fullName)} &middot; ${esc(COUNTRY_LABEL[stock.country] || stock.country)}</p>
    <span class="verdict-badge ${VERDICT_CLASS[a.verdict] || 'verdict-neutral'}">${esc(VERDICT_LABEL[a.verdict] || a.verdict)}</span>
    ${a.priceAtAnalysis != null ? `<span class="price-at-analysis">Kurs vid analys: ${esc(fmtPrice(a.priceAtAnalysis, a.currency))}</span>` : ''}
    ${analyzedDate ? `<p class="analyzed-stamp">Analyserad ${esc(analyzedDate)}</p>` : ''}
  </header>
  <article>
    ${renderParagraphs(a.text)}
  </article>
  <h2 class="metrics-heading">Nyckeltal</h2>
  ${renderMetricsTable(stock)}
  <p class="disclaimer">Den här analysen är inte investeringsrådgivning och kan innehålla felaktigheter — verifiera alltid själv innan du fattar investeringsbeslut.</p>
`;
    pages[`analys/${id}.html`] = pageShell({
      title: `${stock.name} — analys och riktkurs`,
      description: a.text.slice(0, 155).replace(/\s+\S*$/, '') + '…',
      siteUrl,
      canonicalPath: `/analys/${id}.html`,
      bodyHtml: body,
    });

    // Hidden debug page: not linked from anywhere, excluded from the sitemap (see
    // build-site.js) and marked noindex — shows the raw prompt sent to the model and its
    // raw response, for checking what actually produced a given verdict.
    if (a.debug) {
      const debugBody = `
  <header class="page-head">
    <h1>${esc(stock.name)} — LLM-indata</h1>
    <p class="sub">${analyzedDate ? `Analyserad ${esc(analyzedDate)}` : ''}${a.debug.model ? ` &middot; ${esc(a.debug.model)}` : ''}</p>
  </header>
  <div class="debug-block">
    <h2>Prompt</h2>
    <pre>${esc(a.debug.prompt || '')}</pre>
  </div>
  <div class="debug-block">
    <h2>Rått svar</h2>
    <pre>${esc(a.debug.rawResponse || '')}</pre>
  </div>
`;
      pages[`analys/${id}-ai.html`] = pageShell({
        title: `${stock.name} — LLM-indata`,
        description: '',
        siteUrl,
        canonicalPath: `/analys/${id}-ai.html`,
        bodyHtml: debugBody,
        noindex: true,
      });
    }
  }

  return pages;
}

module.exports = { buildAnalysisPages };
