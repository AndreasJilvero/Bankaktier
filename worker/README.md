# Yahoo Finance CORS proxy (Cloudflare Worker)

Replaces the r.jina.ai third-party relay with a small proxy you control. Fetches
Yahoo Finance's chart endpoint server-side (no CORS restriction applies
server-to-server) and re-serves the fields the app needs with CORS headers that
allow the GitHub Pages origin.

## One-time setup

1. Sign up at https://dash.cloudflare.com/sign-up (free, no credit card required
   for the Workers free tier — 100,000 requests/day).
2. Install the CLI: `npm install -g wrangler`
3. Authenticate: `wrangler login` (opens a browser window to link your account)

## Deploy

From this `worker/` directory:

```
wrangler deploy
```

This prints the Worker's URL, something like:
`https://bankaktier-yahoo-proxy.<your-account-subdomain>.workers.dev`

Note: the account subdomain (e.g. "suboptimalprime") comes before ".workers.dev",
and the Worker's name (from `wrangler.toml`, "bankaktier-yahoo-proxy") comes first —
the full URL is `<worker-name>.<account-subdomain>.workers.dev`, not just
`<account-subdomain>.workers.dev` on its own.

Copy that URL — you'll need it in `build/app.html`.

## Wiring it into the app

`build/app.html` already points `YAHOO_PROXY_URL` at the deployed Worker:
`https://bankaktier-yahoo-proxy.suboptimalprime.workers.dev`. If you ever redeploy
under a different account/subdomain, update that constant to match.

## Updating allowed origins

`ALLOWED_ORIGINS` in `worker.js` is a fixed allowlist. It currently includes
`bankaktier.se` and `www.bankaktier.se` alongside the GitHub Pages URL and
localhost — **redeploy with `wrangler deploy` after editing this file** for the
change to take effect; editing the file alone does nothing until it's deployed.

## Free tier limits

100,000 requests/day, which is far more than this app needs (roughly
25 stocks × page loads/day). The Worker also caches each symbol's response for
30 seconds at Cloudflare's edge, so repeated page loads in quick succession
don't each hit Yahoo separately.
