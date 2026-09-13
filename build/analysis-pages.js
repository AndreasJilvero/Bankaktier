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

function pageShell({ title, description, siteUrl, bodyHtml, canonicalPath }) {
  const canonical = siteUrl ? `<link rel="canonical" href="${esc(siteUrl.replace(/\/+$/, ''))}${canonicalPath}">` : '';
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical}
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Bankaktier Norden">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
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
  body{margin:0; background:var(--paper); color:var(--ink); font-family:'IBM Plex Sans', system-ui, sans-serif; padding-inline:20px; padding-block:24px 60px;}
  .wrap{max-width:760px; margin:0 auto;}
  h1,h2{font-family:'Source Serif 4', Georgia, serif; text-wrap:balance; margin:0;}
  a{color:var(--spruce-deep);}
  .breadcrumb{font-size:0.82rem; color:var(--ink-soft); margin-block-end:18px;}
  .breadcrumb a{color:var(--ink-soft); text-decoration:underline;}
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
  article{background:var(--paper-raised); border:1px solid var(--line); border-radius:10px; padding:22px 26px; box-shadow:var(--shadow); font-size:1rem; line-height:1.7;}
  article p{margin:0 0 14px;}
  article p:last-child{margin-bottom:0;}
  .meta{margin-block-start:16px; font-size:0.78rem; color:var(--ink-soft); font-family:'IBM Plex Mono', monospace;}
  .disclaimer{margin-block-start:20px; font-size:0.78rem; color:var(--ink-soft); line-height:1.6;}
  .index-list{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px;}
  .index-list li{border-bottom:1px solid var(--line-soft);}
  .index-list a{
    display:flex; justify-content:space-between; align-items:center; gap:12px; padding:14px 4px;
    text-decoration:none; color:var(--ink);
  }
  .index-list a:hover{color:var(--spruce-deep);}
  .index-name{font-weight:600;}
  .index-country{font-size:0.8rem; color:var(--ink-soft); font-weight:400;}
  .empty-note{color:var(--ink-soft); font-size:0.92rem; padding:20px 0;}
  :focus-visible{outline:2px solid var(--spruce); outline-offset:2px;}
</style>
</head>
<body>
<div class="wrap">
${bodyHtml}
</div>
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
    .sort((a, b) => (b.stock.marketCap || 0) - (a.stock.marketCap || 0));

  const indexBody = `
  <header class="page-head">
    <h1>Aktieanalyser</h1>
    <p class="sub">AI-genererade analyser av nordiska bankaktier, uppdaterade varje natt. Täcker värdering, prognoser och makroläge per land.</p>
  </header>
  ${indexRows.length ? `<ul class="index-list">
    ${indexRows.map((a) => `<li><a href="./${esc(a.id)}.html"><span class="index-name">${COUNTRY_FLAG[a.stock.country] || ''} ${esc(a.stock.name)} <span class="index-country">${esc(COUNTRY_LABEL[a.stock.country] || a.stock.country)}</span></span><span class="verdict-badge ${VERDICT_CLASS[a.verdict] || 'verdict-neutral'}">${esc(VERDICT_LABEL[a.verdict] || a.verdict)}</span></a></li>`).join('\n    ')}
  </ul>` : `<p class="empty-note">Inga analyser genererade ännu.</p>`}
  <p class="disclaimer">Analyserna skapas automatiskt av en AI-modell (Claude) baserat på nyckeltal och webbsökning, och uppdateras varje natt. De är inte investeringsrådgivning och kan innehålla felaktigheter — verifiera alltid själv innan du fattar investeringsbeslut.</p>
  <p class="breadcrumb" style="margin-top:24px;"><a href="../">&larr; Tillbaka till tabellen</a></p>
`;

  pages['analys/index.html'] = pageShell({
    title: 'Aktieanalyser — Bankaktier Norden',
    description: 'AI-genererade analyser av nordiska bankaktier: värdering, prognoser och makroläge, uppdaterade varje natt.',
    siteUrl,
    canonicalPath: '/analys/',
    bodyHtml: indexBody,
  });

  // Per-stock pages
  for (const [id, a] of Object.entries(analyses)) {
    const stock = stocksById[id];
    if (!stock) continue;
    const generated = a.generatedAt ? new Date(a.generatedAt).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const body = `
  <p class="breadcrumb"><a href="../">Bankaktier Norden</a> &rsaquo; <a href="./">Analyser</a> &rsaquo; ${esc(stock.name)}</p>
  <header class="page-head">
    <h1>${COUNTRY_FLAG[stock.country] || ''} ${esc(stock.name)}</h1>
    <p class="sub">${esc(stock.fullName)} &middot; ${esc(COUNTRY_LABEL[stock.country] || stock.country)}</p>
    <span class="verdict-badge ${VERDICT_CLASS[a.verdict] || 'verdict-neutral'}">${esc(VERDICT_LABEL[a.verdict] || a.verdict)}</span>
  </header>
  <article>
    ${renderParagraphs(a.text)}
  </article>
  <p class="meta">${generated ? `Genererad ${esc(generated)} av Claude (Anthropic), med webbsökning.` : ''}</p>
  <p class="disclaimer">Den här analysen är automatiskt skapad av en AI-modell och är inte investeringsrådgivning. Nyckeltal och webbresultat kan vara föråldrade eller felaktiga — verifiera alltid själv innan du fattar investeringsbeslut.</p>
`;
    pages[`analys/${id}.html`] = pageShell({
      title: `${stock.name} — analys och riktkurs`,
      description: a.text.slice(0, 155).replace(/\s+\S*$/, '') + '…',
      siteUrl,
      canonicalPath: `/analys/${id}.html`,
      bodyHtml: body,
    });
  }

  return pages;
}

module.exports = { buildAnalysisPages };
