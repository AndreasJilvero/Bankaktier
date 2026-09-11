// Build-time data fetch: history + fundamentals for all bank stocks + OMXS30.
//
// Price history is cached in build/history.sqlite (see history-db.js). On first run
// (or for a symbol never seen before) this does a full 5-year backfill; on later runs
// it only asks Yahoo for days after the last stored timestamp, then appends. This keeps
// daily/cron runs cheap and avoids re-downloading years of history every time.
//
// Run with: node build/fetch-data.js
const fs = require('fs');
const path = require('path');
const historyDb = require('./history-db');

const STOCKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'stocks.json'), 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const BACKFILL_RANGE = '5y';
const OUTPUT_WINDOW_DAYS = 5 * 366; // keep data.json trimmed to ~5 years even as the DB grows past that

async function getCookieAndCrumb() {
  const res1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
  const cookieHeader = (res1.headers.get('set-cookie') || '').split(';')[0];
  const res2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookieHeader },
  });
  const crumb = await res2.text();
  return { cookieHeader, crumb };
}

async function fetchChart(symbol, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&events=div`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`chart fetch failed for ${symbol}: ${JSON.stringify(json?.chart?.error)}`);
  return result;
}

async function fetchSummary(symbol, cookieHeader, crumb) {
  const modules = 'summaryDetail,defaultKeyStatistics,price,financialData,recommendationTrend';
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookieHeader } });
  const json = await res.json();
  const result = json?.quoteSummary?.result?.[0];
  if (!result) throw new Error(`summary fetch failed for ${symbol}: ${JSON.stringify(json?.quoteSummary?.error)}`);
  return result;
}

function raw(field) {
  return field && typeof field === 'object' && 'raw' in field ? field.raw : field ?? null;
}

// Yahoo's raw feed occasionally mixes reporting currencies (e.g. book value in EUR
// vs. a SEK share price) or returns stale/garbage forward estimates. Sanity-bound
// bank valuation multiples rather than surface numbers that are obviously broken.
function sane(value, min, max) {
  if (value == null || typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function extractPointsAndDividends(chartResult) {
  const ts = chartResult.timestamp || [];
  const closes = chartResult.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] == null) continue;
    points.push({ t: ts[i], c: Math.round(closes[i] * 100) / 100 });
  }
  const dividends = [];
  const divEvents = chartResult.events?.dividends;
  if (divEvents) {
    for (const key of Object.keys(divEvents)) {
      dividends.push({ t: divEvents[key].date, amount: divEvents[key].amount });
    }
    dividends.sort((a, b) => a.t - b.t);
  }
  return { points, dividends };
}

function pctChangeOverDays(points, days) {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  const targetT = last.t - days * 86400;
  let ref = points[0];
  for (const p of points) {
    if (p.t <= targetT) ref = p;
    else break;
  }
  if (!ref || ref.c === 0) return null;
  return Math.round(((last.c - ref.c) / ref.c) * 10000) / 100;
}

// Fetch just enough from Yahoo to fill the gap since the last stored point, then
// merge with what's already in the DB. Falls back to a full backfill for new symbols.
async function syncSymbolHistory(db, symbol) {
  const lastT = historyDb.lastTimestamp(db, symbol);
  const nowT = Math.floor(Date.now() / 1000);
  const daysSinceLast = lastT ? Math.ceil((nowT - lastT) / 86400) : Infinity;

  let range;
  if (!lastT) {
    range = BACKFILL_RANGE;
  } else if (daysSinceLast <= 5) {
    range = '5d';
  } else if (daysSinceLast <= 30) {
    range = '1mo';
  } else if (daysSinceLast <= 90) {
    range = '3mo';
  } else {
    range = BACKFILL_RANGE; // been too long, just re-backfill the window
  }

  const chart = await fetchChart(symbol, range);
  const { points, dividends } = extractPointsAndDividends(chart);
  historyDb.upsertPrices(db, symbol, points);
  historyDb.upsertDividends(db, symbol, dividends);

  return { meta: chart.meta, fetchedNewPoints: points.length, wasBackfill: !lastT };
}

async function main() {
  const db = historyDb.open();

  console.log('Fetching Yahoo cookie/crumb...');
  const { cookieHeader, crumb } = await getCookieAndCrumb();
  console.log('Crumb acquired.');

  const stocksOut = [];
  const cutoffT = Math.floor(Date.now() / 1000) - OUTPUT_WINDOW_DAYS * 86400;

  for (const stock of STOCKS) {
    process.stdout.write(`Syncing ${stock.name} (${stock.yahoo})... `);
    const [{ meta, fetchedNewPoints, wasBackfill }, summary] = await Promise.all([
      syncSymbolHistory(db, stock.yahoo),
      fetchSummary(stock.yahoo, cookieHeader, crumb).catch((e) => {
        console.warn(`\n  summary failed for ${stock.yahoo}: ${e.message}`);
        return null;
      }),
    ]);
    console.log(wasBackfill ? `backfilled ${fetchedNewPoints} pts` : `+${fetchedNewPoints} pts since last run`);

    const points = historyDb.getHistory(db, stock.yahoo, cutoffT);
    const dividends = historyDb.getDividends(db, stock.yahoo, cutoffT);

    const sd = summary?.summaryDetail || {};
    const ks = summary?.defaultKeyStatistics || {};
    const fd = summary?.financialData || {};
    const rt = summary?.recommendationTrend?.trend?.[0] || {};

    const trailingDivSum = (() => {
      if (!dividends.length) return null;
      const cutoff = Math.floor(Date.now() / 1000) - 366 * 86400;
      const sum = dividends.filter((d) => d.t >= cutoff).reduce((a, d) => a + d.amount, 0);
      return sum > 0 ? Math.round(sum * 100) / 100 : null;
    })();

    stocksOut.push({
      id: stock.id,
      name: stock.name,
      fullName: stock.fullName,
      category: stock.category,
      yahoo: stock.yahoo,
      tradingview: stock.tradingview,
      currency: meta.currency,
      price: meta.regularMarketPrice,
      asOf: meta.regularMarketTime,
      changeToday: raw(sd.regularMarketPrice) != null && raw(sd.regularMarketPreviousClose)
        ? Math.round(((meta.regularMarketPrice - raw(sd.regularMarketPreviousClose)) / raw(sd.regularMarketPreviousClose)) * 10000) / 100
        : (meta.regularMarketChangePercent != null ? Math.round(meta.regularMarketChangePercent * 100) / 100 : null),
      change3m: pctChangeOverDays(points, 91),
      change12m: pctChangeOverDays(points, 365),
      marketCap: raw(sd.marketCap),
      trailingPE: sane(raw(sd.trailingPE), 0, 100),
      forwardPE: sane(raw(sd.forwardPE), 0, 100),
      priceToBook: sane(raw(ks.priceToBook), 0, 15),
      dividendYield: raw(sd.dividendYield) != null ? Math.round(raw(sd.dividendYield) * 10000) / 100 : (trailingDivSum ? Math.round((trailingDivSum / meta.regularMarketPrice) * 10000) / 100 : null),
      dividendRate: raw(sd.dividendRate) ?? trailingDivSum,
      payoutRatio: sane(raw(sd.payoutRatio) != null ? Math.round(raw(sd.payoutRatio) * 10000) / 100 : null, 0, 300),
      returnOnEquity: sane(raw(fd.returnOnEquity) != null ? Math.round(raw(fd.returnOnEquity) * 10000) / 100 : null, -100, 100),
      targetMeanPrice: raw(fd.targetMeanPrice),
      analystCount: raw(fd.numberOfAnalystOpinions),
      upside: raw(fd.targetMeanPrice) != null && meta.regularMarketPrice
        ? Math.round(((raw(fd.targetMeanPrice) - meta.regularMarketPrice) / meta.regularMarketPrice) * 10000) / 100
        : null,
      recommendations: (rt.buy != null || rt.hold != null || rt.sell != null) ? {
        strongBuy: raw(rt.strongBuy) || 0,
        buy: raw(rt.buy) || 0,
        hold: raw(rt.hold) || 0,
        sell: raw(rt.sell) || 0,
        strongSell: raw(rt.strongSell) || 0,
      } : null,
      fiftyTwoWeekHigh: raw(sd.fiftyTwoWeekHigh),
      fiftyTwoWeekLow: raw(sd.fiftyTwoWeekLow),
      profitMargin: raw(fd.profitMargins) != null ? Math.round(raw(fd.profitMargins) * 10000) / 100 : null,
      beta: sane(raw(ks.beta), -3, 5),
    });

    await new Promise((r) => setTimeout(r, 300));
  }

  process.stdout.write('Syncing OMXS30 index... ');
  const omxSync = await syncSymbolHistory(db, '^OMX');
  console.log(omxSync.wasBackfill ? `backfilled ${omxSync.fetchedNewPoints} pts` : `+${omxSync.fetchedNewPoints} pts since last run`);
  // OMXS30 and the bank sector index (OMXSTO:SX3010GI) are now plotted directly by the
  // embedded TradingView chart, not computed client-side, so their history no longer
  // needs to ship in data.json — still kept in the SQLite cache in case that changes.

  const output = {
    generatedAt: new Date().toISOString(),
    stocks: stocksOut,
  };

  fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(output));
  console.log(`Done. Wrote build/data.json (${stocksOut.length} stocks). History DB: ${historyDb.DB_PATH}`);

  const { buildStandaloneSite } = require('./prerender');
  const siteDir = path.join(__dirname, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  const siteUrl = process.env.SITE_URL || '';
  const html = buildStandaloneSite(output, { siteUrl });
  fs.writeFileSync(path.join(siteDir, 'index.html'), html);
  fs.copyFileSync(path.join(__dirname, 'data.json'), path.join(siteDir, 'data.json'));

  const origin = siteUrl ? siteUrl.replace(/\/+$/, '') : '';
  fs.writeFileSync(
    path.join(siteDir, 'robots.txt'),
    `User-agent: *\nAllow: /\n${origin ? `\nSitemap: ${origin}/sitemap.xml\n` : ''}`
  );
  if (origin) {
    fs.writeFileSync(
      path.join(siteDir, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${origin}/</loc>\n    <lastmod>${output.generatedAt.slice(0, 10)}</lastmod>\n    <changefreq>daily</changefreq>\n  </url>\n</urlset>\n`
    );
  }

  console.log(`Wrote build/site/index.html (pre-rendered, ${stocksOut.length} rows) + data.json + robots.txt${origin ? ' + sitemap.xml' : ''}.`);

  db.close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
