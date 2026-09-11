// Cloudflare Worker: a minimal CORS-enabled proxy for Yahoo Finance's chart endpoint.
//
// Why this exists: Yahoo's endpoints never send Access-Control-Allow-Origin, so a
// browser blocks a direct client-side fetch regardless of how the request is made —
// CORS is enforced by the responding server, not something a client can opt into.
// This Worker fetches Yahoo server-side (no CORS applies server-to-server) and
// re-serves just the fields the app needs, with CORS headers naming this app's
// origin, replacing the earlier r.jina.ai third-party relay with infrastructure you
// control.
//
// Deploy: `wrangler deploy` from this directory (see worker/README.md), or paste
// this file into the Cloudflare dashboard's Worker editor.

const ALLOWED_ORIGINS = new Set([
  'https://andreasjilvero.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

const YAHOO_HOST = 'https://query1.finance.yahoo.com';

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (!headers['Access-Control-Allow-Origin']) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const symbol = url.searchParams.get('symbol');
    if (!symbol) {
      return new Response(JSON.stringify({ error: 'Missing symbol parameter' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const yahooUrl = `${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
    let upstream;
    try {
      upstream = await fetch(yahooUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        cf: { cacheTtl: 30, cacheEverything: true }, // small cache to avoid hammering Yahoo on repeated page loads
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Upstream fetch failed' }), {
        status: 502,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    if (!upstream.ok) {
      return new Response(JSON.stringify({ error: `Upstream returned ${upstream.status}` }), {
        status: 502,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const json = await upstream.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) {
      return new Response(JSON.stringify({ error: 'No data for symbol' }), {
        status: 404,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const payload = {
      symbol: meta.symbol,
      price: meta.regularMarketPrice ?? null,
      previousClose: meta.chartPreviousClose ?? null,
      changePercent: meta.regularMarketChangePercent ?? null,
      time: meta.regularMarketTime ?? null,
      currency: meta.currency ?? null,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' },
    });
  },
};
