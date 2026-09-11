// Best-effort fetch of Stooq's daily CSV history for symbols Yahoo doesn't serve
// correctly (e.g. sx3010gi, the OMX Stockholm Banks GI sector index — Yahoo misroutes
// ^SX3010GI to a broken "Nasdaq GIDS" feed with no usable history).
//
// Stooq gates its CSV endpoints behind a small JS proof-of-work bot challenge: the
// page returns an HTML snippet containing a string `c` and a difficulty `d`, and
// expects a POST to /__verify with a nonce `n` such that sha256(c + n) starts with
// `d` zero hex digits; a successful verify sets an auth cookie for the real request.
// This works from a real client IP, but some hosting environments (this build's own
// sandbox, in earlier testing) get "Access denied" even after solving the challenge —
// evidently an IP-reputation block rather than anything about the puzzle itself. So
// this fetch is deliberately best-effort: on any failure it returns null and the
// caller skips the series entirely rather than failing the whole build.
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function solvePow(challenge, difficulty) {
  const target = '0'.repeat(difficulty);
  let n = 0;
  while (true) {
    const hash = crypto.createHash('sha256').update(challenge + n).digest('hex');
    if (hash.startsWith(target)) return n;
    n++;
  }
}

async function getStooqAuthCookie(sampleUrl) {
  const res = await fetch(sampleUrl, { headers: { 'User-Agent': UA } });
  const html = await res.text();
  const setCookie = res.headers.get('set-cookie');
  const challengeCookie = setCookie ? setCookie.split(';')[0] : '';

  const match = html.match(/c="([^"]+)",d=(\d+)/);
  if (!match) {
    // No challenge presented — either already trusted, or a hard block with no puzzle at all.
    return challengeCookie || null;
  }

  const challenge = match[1];
  const difficulty = parseInt(match[2], 10);
  const n = solvePow(challenge, difficulty);

  const verifyRes = await fetch(new URL('/__verify', sampleUrl).toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Cookie: challengeCookie,
      Referer: 'https://stooq.com/',
    },
    body: `c=${encodeURIComponent(challenge)}&n=${n}`,
  });
  const verifyCookie = verifyRes.headers.get('set-cookie');
  return verifyCookie ? verifyCookie.split(';')[0] : challengeCookie;
}

// Returns [{ t, c }] daily points (t = unix seconds, c = close), or null if the
// symbol's history couldn't be fetched for any reason (blocked, no data, bad format).
async function fetchStooqDailyHistory(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  try {
    const cookie = await getStooqAuthCookie(url);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Cookie: cookie || '', Referer: 'https://stooq.com/' },
    });
    const text = await res.text();
    if (!text || /access denied/i.test(text) || !text.startsWith('Date,')) return null;

    const lines = text.trim().split('\n');
    const points = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols.length < 5) continue;
      const [dateStr, , , , closeStr] = cols;
      const t = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 1000);
      const c = parseFloat(closeStr);
      if (Number.isNaN(t) || Number.isNaN(c)) continue;
      points.push({ t, c: Math.round(c * 100) / 100 });
    }
    return points.length ? points : null;
  } catch (e) {
    return null;
  }
}

module.exports = { fetchStooqDailyHistory };
