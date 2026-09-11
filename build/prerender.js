// Builds the self-hosted standalone page: wraps the Artifact-style app.html fragment
// in a full <html> document with SEO metadata, and injects a server-rendered <tbody>
// (market-cap sorted, build-time prices/fundamentals) so crawlers and no-JS visitors
// see real content immediately. The client script re-renders over this on load and
// takes over from there (sorting, checkboxes, chart, live prices where allowed).
const fs = require('fs');
const path = require('path');

const CAT_LABEL = { storbank: 'Storbank', nisch: 'Nischbank' };

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

function renderRow(s) {
  const avanzaUrl = `https://www.avanza.se/aktier/handla.html/screener?free_text_search=${encodeURIComponent(s.name)}`;
  const nordnetUrl = `https://www.nordnet.se/marknaden/aktiekurser?query=${encodeURIComponent(s.name)}`;
  return `
          <tr data-id="${esc(s.id)}">
            <td class="col-check"><input type="checkbox" checked aria-label="Visa ${esc(s.name)} i diagrammet"></td>
            <th class="col-name" scope="row">
              <div class="name-cell">
                <span>${esc(s.name)}</span>
                <span class="full">${esc(s.fullName)}</span>
                <span class="cat-pill ${esc(s.category)}">${esc(CAT_LABEL[s.category] || s.category)}</span>
              </div>
            </th>
            <td><div class="price-cell"><span class="p num" id="price-${esc(s.id)}">${fmtNum(s.price, 2)} ${esc(s.currency)}</span></div></td>
            <td class="num ${pctClass(s.changeToday)}" id="today-${esc(s.id)}">${fmtPct(s.changeToday, 2)}</td>
            <td class="num ${pctClass(s.change3m)}">${fmtPct(s.change3m, 2)}</td>
            <td class="num ${pctClass(s.change12m)}">${fmtPct(s.change12m, 2)}</td>
            <td class="num">${fmtMcap(s.marketCap)}</td>
            <td class="num">${s.dividendYield != null ? fmtNum(s.dividendYield, 2) + '%' : '—'}</td>
            <td class="num">${s.payoutRatio != null ? fmtNum(s.payoutRatio, 0) + '%' : '—'}</td>
            <td class="num">${s.trailingPE != null ? fmtNum(s.trailingPE, 1) : '—'}</td>
            <td class="num">${s.forwardPE != null ? fmtNum(s.forwardPE, 1) : '—'}</td>
            <td class="num">${s.priceToBook != null ? fmtNum(s.priceToBook, 2) : '—'}</td>
            <td class="buy-cell">
              <button class="buy-btn" type="button">Köp</button>
              <div class="buy-menu">
                <a href="${esc(avanzaUrl)}" target="_blank" rel="noopener"><span class="broker-dot avanza"></span>Avanza</a>
                <a href="${esc(nordnetUrl)}" target="_blank" rel="noopener"><span class="broker-dot nordnet"></span>Nordnet</a>
              </div>
            </td>
          </tr>`;
}

function buildStandaloneSite(data, { siteUrl } = {}) {
  const fragmentPath = path.join(__dirname, 'app.html');
  let fragment = fs.readFileSync(fragmentPath, 'utf8');

  const stocksSorted = data.stocks.slice().sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  const rowsHtml = stocksSorted.map(renderRow).join('\n');
  const totalMcap = data.stocks.reduce((sum, s) => sum + (s.marketCap || 0), 0);
  const buildStamp = new Date(data.generatedAt).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' });

  fragment = fragment.replace(
    '<tbody id="tbody"></tbody>',
    `<tbody id="tbody">${rowsHtml}\n        </tbody>`
  );
  fragment = fragment.replace(
    '<span class="index-count" id="indexCount">8 av 8</span>',
    `<span class="index-count" id="indexCount">${data.stocks.length} av ${data.stocks.length}</span>`
  );
  fragment = fragment.replace(
    '<span class="index-count" id="indexMcap">—</span>',
    `<span class="index-count" id="indexMcap">${fmtMcap(totalMcap)}</span>`
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
  const title = titleMatch ? titleMatch[1] : 'Bankindex Sverige';
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

  const head = `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">${canonical}
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Bankindex Sverige">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${siteUrl ? `<meta property="og:url" content="${esc(siteUrl)}">\n` : ''}<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Dataset',
  name: 'Bankindex Sverige — svenska bankaktier',
  description,
  creator: { '@type': 'Organization', name: 'Bankindex Sverige' },
  variableMeasured: ['Aktiekurs', 'P/E-tal', 'P/B-tal', 'Direktavkastning', 'Utdelningsandel', 'Börsvärde'],
  dateModified: data.generatedAt,
}, null, 2)}
</script>
${headExtras}
</head>
<body>
`;

  return `${head}${bodyContent}\n</body>\n</html>\n`;
}

module.exports = { buildStandaloneSite };
