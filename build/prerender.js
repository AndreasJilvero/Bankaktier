// Builds the self-hosted standalone page: wraps the Artifact-style app.html fragment
// in a full <html> document with SEO metadata, and injects a server-rendered <tbody>
// (market-cap sorted, build-time prices/fundamentals) so crawlers and no-JS visitors
// see real content immediately. The client script re-renders over this on load and
// takes over from there (sorting, checkboxes, chart, live prices where allowed).
const fs = require('fs');
const path = require('path');

const CAT_LABEL = { storbank: 'Storbank', nisch: 'Nischbank' };
const COUNTRY_LABEL = { SE: 'Sverige', DK: 'Danmark', FI: 'Finland', NO: 'Norge' };
const COUNTRY_FLAG = { SE: '🇸🇪', DK: '🇩🇰', FI: '🇫🇮', NO: '🇳🇴' };
const VERDICT_LABEL = { Buy: 'Köp', Neutral: 'Neutral', Sell: 'Sälj' };
const VERDICT_CLASS = { Buy: 'verdict-buy', Neutral: 'verdict-neutral', Sell: 'verdict-sell' };

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
function pctClass(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  return v > 0 ? 'up' : v < 0 ? 'down' : '';
}

function renderRangeCell(s) {
  if (s.fiftyTwoWeekLow != null && s.fiftyTwoWeekHigh != null && s.price != null && s.fiftyTwoWeekHigh > s.fiftyTwoWeekLow) {
    const pct = Math.max(0, Math.min(100, ((s.price - s.fiftyTwoWeekLow) / (s.fiftyTwoWeekHigh - s.fiftyTwoWeekLow)) * 100));
    return `<td><div class="range-cell"><div class="range-track"><div class="range-dot" style="left:${pct.toFixed(1)}%"></div></div><div class="range-labels"><span>${fmtNum(s.fiftyTwoWeekLow, 0)}</span><span>${fmtNum(s.fiftyTwoWeekHigh, 0)}</span></div></div></td>`;
  }
  return `<td><div class="range-cell">—</div></td>`;
}

function renderRow(s) {
  return `
          <tr data-id="${esc(s.id)}">
            <td class="col-check"><input type="checkbox" aria-label="Visa ${esc(s.name)} i diagrammet"></td>
            <th class="col-name" scope="row">
              <div class="name-cell">
                <a class="name-link" href="${esc(s.analysisUrl || '#')}"><span>${COUNTRY_FLAG[s.country] || ''} ${esc(s.name)}</span></a>
                <span class="full">${esc(s.fullName)}</span>
                <span class="cat-pill ${esc(s.category)}">${esc(CAT_LABEL[s.category] || s.category)}</span>
              </div>
            </th>
            <td>${s.verdict && VERDICT_LABEL[s.verdict] ? `<a class="verdict-badge ${VERDICT_CLASS[s.verdict]}" href="${esc(s.analysisUrl || '#')}">${esc(VERDICT_LABEL[s.verdict])}</a>` : '<span class="verdict-none">—</span>'}</td>
            <td><div class="price-cell"><span class="p num" id="price-${esc(s.id)}">${fmtNum(s.price, 2)} ${esc(s.currency)}</span></div></td>
            ${renderRangeCell(s)}
            <td class="num ${pctClass(s.changeToday)}" id="today-${esc(s.id)}">${fmtPct(s.changeToday, 2)}</td>
            <td class="num ${pctClass(s.change3m)}">${fmtPct(s.change3m, 2)}</td>
            <td class="num ${pctClass(s.change12m)}">${fmtPct(s.change12m, 2)}</td>
            <td class="num">${fmtMcap(s.marketCap)}</td>
            <td class="num">${s.dividendYield != null ? fmtNum(s.dividendYield, 2) + '%' : '—'}</td>
            <td class="num">${s.trailingPE != null ? fmtNum(s.trailingPE, 1) : '—'}</td>
            <td class="num">${s.priceToBook != null ? fmtNum(s.priceToBook, 2) : '—'}</td>
          </tr>`;
}

function buildStandaloneSite(data, { siteUrl } = {}) {
  const fragmentPath = path.join(__dirname, 'app.html');
  let fragment = fs.readFileSync(fragmentPath, 'utf8');

  const stocksSorted = data.stocks.slice().sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  const rowsHtml = stocksSorted.map(renderRow).join('\n');
  const buildStamp = new Date(data.generatedAt).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' });
  const countriesPresent = [...new Set(data.stocks.map((s) => s.country))].sort((a, b) =>
    (COUNTRY_LABEL[a] || a).localeCompare(COUNTRY_LABEL[b] || b, 'sv')
  );
  const countryChipsHtml = countriesPresent
    .map((code) => `<label class="country-chip active"><input type="checkbox" checked>${COUNTRY_FLAG[code] || ''} ${esc(COUNTRY_LABEL[code] || code)}</label>`)
    .join('');

  fragment = fragment.replace(
    '<tbody id="tbody"></tbody>',
    `<tbody id="tbody">${rowsHtml}\n        </tbody>`
  );
  fragment = fragment.replace(
    '<div class="country-filter" id="countryFilter" role="group" aria-label="Filtrera på land"></div>',
    `<div class="country-filter" id="countryFilter" role="group" aria-label="Filtrera på land">${countryChipsHtml}</div>`
  );
  fragment = fragment.replace(
    '<span id="buildStamp">Byggd data: —</span>',
    `<span id="buildStamp">Byggd data: ${esc(buildStamp)}</span>`
  );

  // The Artifact fragment starts with <title>, <meta description>, font <link>s and a
  // <style> block, then the body markup (<div class="wrap">...) and finally <script>.
  // Everything up to and including </style> belongs in <head>; the rest is the body.
  const titleMatch = fragment.match(/<title>([\s\S]*?)<\/title>/);
  const descMatch = fragment.match(/<meta name="description"[^>]*>/);
  const title = titleMatch ? titleMatch[1] : 'Bankaktier Norden';
  const description = descMatch
    ? (descMatch[0].match(/content="([^"]*)"/) || [])[1] || ''
    : '';

  const styleEndIdx = fragment.indexOf('</style>');
  if (styleEndIdx === -1) throw new Error('prerender: could not find </style> in app.html fragment');
  const headExtras = fragment
    .slice(0, styleEndIdx + '</style>'.length)
    .replace(/^<title>[\s\S]*?<\/title>\s*/, '')
    .replace(/^<meta name="description"[^>]*>\s*/, '');
  const bodyContent = fragment.slice(styleEndIdx + '</style>'.length).replace(/^\s+/, '');

  const canonical = siteUrl ? `\n<link rel="canonical" href="${esc(siteUrl)}">` : '';

  const GA_MEASUREMENT_ID = 'G-Z2NJQDBKQ6';

  const head = `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA_MEASUREMENT_ID}');
</script>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">${canonical}
<meta name="google-site-verification" content="c0G8MnWs9aCoNX-YVWPjB3260fDgDIwz9y0ez4eRLzI" />
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bankaktier Norden">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${siteUrl ? `<meta property="og:url" content="${esc(siteUrl)}">\n` : ''}<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'Bankaktier Norden',
  description,
  applicationCategory: 'FinanceApplication',
  operatingSystem: 'Any (web browser)',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'SEK' },
}, null, 2)}
</script>
${headExtras}
</head>
<body>
`;

  return `${head}${bodyContent}\n</body>\n</html>\n`;
}

module.exports = { buildStandaloneSite };
