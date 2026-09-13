// Orchestrates the full nightly build: fetch fresh prices/fundamentals, run the LLM
// analysis pass (skipped gracefully if ANTHROPIC_API_KEY isn't set), merge each stock's
// verdict into data.json, then render the standalone site (main page + /analys/ pages).
//
// fetch-data.js and analyze-stocks.js are run as separate processes (not required as
// modules) because each calls process.exit() on completion/failure, which would kill
// this orchestrator too if they ran in-process.
//
// Run with: node build/build-site.js  (this replaces calling fetch-data.js directly)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function runStep(scriptName) {
  execFileSync(process.execPath, [path.join(__dirname, scriptName)], { stdio: 'inherit' });
}

async function main() {
  console.log('=== Step 1: fetch prices and fundamentals ===');
  runStep('fetch-data.js');

  console.log('\n=== Step 2: LLM stock analysis ===');
  runStep('analyze-stocks.js');

  console.log('\n=== Step 3: merge verdicts and render site ===');
  const dataPath = path.join(__dirname, 'data.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const analysesPath = path.join(__dirname, 'analyses.json');
  const analysesData = fs.existsSync(analysesPath)
    ? JSON.parse(fs.readFileSync(analysesPath, 'utf8'))
    : { generatedAt: null, analyses: {} };

  for (const stock of data.stocks) {
    const a = analysesData.analyses[stock.id];
    stock.verdict = a ? a.verdict : null;
    stock.analysisUrl = a ? `analys/${stock.id}.html` : null;
  }
  fs.writeFileSync(dataPath, JSON.stringify(data));

  const { buildStandaloneSite } = require('./prerender');
  const { buildAnalysisPages } = require('./analysis-pages');

  const siteDir = path.join(__dirname, 'site');
  fs.mkdirSync(path.join(siteDir, 'analys'), { recursive: true });
  const siteUrl = process.env.SITE_URL || '';

  const html = buildStandaloneSite(data, { siteUrl });
  fs.writeFileSync(path.join(siteDir, 'index.html'), html);
  fs.copyFileSync(dataPath, path.join(siteDir, 'data.json'));

  const analysisPages = buildAnalysisPages(data, analysesData, { siteUrl });
  for (const [relPath, pageHtml] of Object.entries(analysisPages)) {
    const fullPath = path.join(siteDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, pageHtml);
  }

  const origin = siteUrl ? siteUrl.replace(/\/+$/, '') : '';
  fs.writeFileSync(
    path.join(siteDir, 'robots.txt'),
    `User-agent: *\nAllow: /\n${origin ? `\nSitemap: ${origin}/sitemap.xml\n` : ''}`
  );
  if (origin) {
    const analysisUrls = Object.keys(analysisPages)
      .map((relPath) => `  <url>\n    <loc>${origin}/${relPath.replace(/index\.html$/, '')}</loc>\n    <lastmod>${data.generatedAt.slice(0, 10)}</lastmod>\n    <changefreq>daily</changefreq>\n  </url>`)
      .join('\n');
    fs.writeFileSync(
      path.join(siteDir, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${origin}/</loc>\n    <lastmod>${data.generatedAt.slice(0, 10)}</lastmod>\n    <changefreq>daily</changefreq>\n  </url>\n${analysisUrls}\n</urlset>\n`
    );
  }

  console.log(`Wrote build/site/index.html + ${Object.keys(analysisPages).length} analysis pages + data.json + robots.txt${origin ? ' + sitemap.xml' : ''}.`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
