// Nightly LLM analysis: for each bank stock, ask Claude (with web search) to write a
// short analysis covering current valuation vs. peers, forward estimates, and national
// macro context, then return a Buy/Neutral/Sell verdict — all in a single call using
// output_config.format to force the final response into strict JSON alongside the
// web_search tool. Writes build/analyses.json, consumed by fetch-data.js (verdict badge
// in the table) and analysis-pages.js (the /analys/ pages).
//
// Requires ANTHROPIC_API_KEY. Skipped entirely (with a clear log line, not a failure)
// if the key isn't set, so local builds and PRs without the secret still work.
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const COUNTRY_NAME = { SE: 'Sverige', DK: 'Danmark', FI: 'Finland', NO: 'Norge' };
const MODEL = 'claude-opus-5';

const ANALYSIS_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      analysis: {
        type: 'string',
        description: 'The full analysis text in Swedish, 5-10 sentences, no markdown formatting.',
      },
      verdict: { type: 'string', enum: ['Buy', 'Neutral', 'Sell'] },
    },
    required: ['analysis', 'verdict'],
    additionalProperties: false,
  },
};

function fmtMetric(v, suffix) {
  return v == null ? 'okänt' : v + (suffix || '');
}

// Peers = other tracked banks, preferring same country (a Swedish investor comparing
// SEB mainly cares how it stacks up against Swedbank/Handelsbanken, not a Danish
// regional bank) but falling back to the full Nordic set when a country has too few
// banks tracked to make a meaningful in-country comparison.
function selectPeers(stock, allStocks) {
  const others = allStocks.filter((s) => s.id !== stock.id);
  const sameCountry = others.filter((s) => s.country === stock.country);
  const pool = sameCountry.length >= 3 ? sameCountry : others;
  return pool
    .slice()
    .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))
    .slice(0, 6);
}

function formatPeerLine(peer) {
  return `${peer.name} (${COUNTRY_NAME[peer.country] || peer.country}): P/E ${fmtMetric(peer.trailingPE)}, P/B ${fmtMetric(peer.priceToBook)}, ROE ${fmtMetric(peer.returnOnEquity, '%')}`;
}

function buildPrompt(stock, peers) {
  const countryName = COUNTRY_NAME[stock.country] || stock.country;
  return `Du analyserar bankaktien ${stock.fullName} (${stock.name}), noterad i ${countryName} (${stock.yahoo}), för en investerare som överväger att lägga till den i sin portfölj.

Nuvarande nyckeltal (hämtade vid byggtillfället, ${new Date().toISOString().slice(0, 10)}):
- Kurs: ${stock.price} ${stock.currency} (idag ${stock.changeToday > 0 ? '+' : ''}${stock.changeToday}%, 3 mån ${stock.change3m}%, 12 mån ${stock.change12m}%)
- Börsvärde: ${(stock.marketCap / 1e9).toFixed(1)} miljarder ${stock.currency}
- P/E (historiskt): ${fmtMetric(stock.trailingPE)}, P/E (prognos): ${fmtMetric(stock.forwardPE)}
- P/B: ${fmtMetric(stock.priceToBook)}
- ROE: ${fmtMetric(stock.returnOnEquity, '%')}
- Rörelsemarginal: ${fmtMetric(stock.operatingMargin, '%')}, nettomarginal: ${fmtMetric(stock.netMargin, '%')}
- Direktavkastning: ${fmtMetric(stock.dividendYield, '%')}, utdelningsandel: ${fmtMetric(stock.payoutRatio, '%')}
- Analytikernas snittriktkurs: ${stock.targetMeanPrice ? Math.round(stock.targetMeanPrice) + ' ' + stock.currency : 'okänt'} (${stock.upside != null ? (stock.upside > 0 ? '+' : '') + stock.upside.toFixed(1) + '%' : 'okänt'} mot nuvarande kurs, baserat på ${stock.analystCount ?? '?'} analytiker)
- Rekommendationer: ${stock.recommendations ? `${stock.recommendations.strongBuy + stock.recommendations.buy} köp, ${stock.recommendations.hold} behåll, ${stock.recommendations.sell + stock.recommendations.strongSell} sälj` : 'okänt'}
- Beta: ${fmtMetric(stock.beta)}

Jämförbara nordiska bankaktier (samma källa, samma tidpunkt):
${peers.map((p) => `- ${formatPeerLine(p)}`).join('\n')}

Använd webbsökning för att ta reda på det senaste kring bolaget (senaste kvartalsrapport, analytikerkommentarer) och makroläget i ${countryName} (styrränta, inflation, bostadsmarknad, tillväxtutsikter) i den mån det påverkar banksektorn där.

Skriv en analys på svenska, 5-10 meningar, som täcker:
1. Nuvarande värdering jämfört med de nordiska konkurrenterna ovan — är aktien billigare eller dyrare än sektorn givet dess lönsamhet (ROE, marginaler), inte bara i absoluta tal
2. Prognoser och förväntad utveckling (analytikerkonsensus, vinsttillväxt)
3. Makroläget i ${countryName} på nationell nivå och hur det påverkar bankens affär

Avsluta analysen med en tydlig sammanfattande mening om huvudargumentet för eller emot aktien. Skriv rakt och konkret, undvik disclaimers och floskler. Sätt sedan ett samlat betyg (Buy/Neutral/Sell) som sammanfattar helhetsbilden.`;
}

// Hard ceiling on pause_turn resumes per stock. This is a real safety limit, not a
// tuning knob: on 2026-09-13 this loop had no cap at all, and a nightly run against
// all 25 stocks ran for 52 minutes and burned through the account's funds before
// ultimately failing -- almost certainly this exact loop failing to converge when
// combining web_search with output_config.format. Each resume is a full paid API call
// (with web search), so this bounds worst-case cost per stock, not just wall time.
const MAX_TURN_RESUMES = 3;

async function analyzeStock(client, stock, peers) {
  const params = {
    model: MODEL,
    max_tokens: 2000,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
    output_config: { format: ANALYSIS_SCHEMA },
    messages: [{ role: 'user', content: buildPrompt(stock, peers) }],
  };

  let response = await client.messages.parse(params);
  let messages = params.messages;
  let resumes = 0;
  // Resume if a long tool-use turn paused before the model produced its final answer.
  while (response.stop_reason === 'pause_turn') {
    resumes += 1;
    if (resumes > MAX_TURN_RESUMES) {
      throw new Error(`gave up after ${MAX_TURN_RESUMES} pause_turn resumes for ${stock.id} — refusing to keep calling the API`);
    }
    messages = [...messages, { role: 'assistant', content: response.content }];
    response = await client.messages.parse({ ...params, messages });
  }

  const parsed = response.parsed_output;
  if (!parsed || !parsed.analysis || !['Buy', 'Neutral', 'Sell'].includes(parsed.verdict)) {
    throw new Error(`invalid structured output for ${stock.id} (stop_reason: ${response.stop_reason}): ${JSON.stringify(parsed)}`);
  }

  return { verdict: parsed.verdict, text: parsed.analysis.trim() };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const outputPath = path.join(__dirname, 'analyses.json');

  if (!apiKey) {
    console.log('ANTHROPIC_API_KEY not set — skipping LLM analysis.');
    if (!fs.existsSync(outputPath)) {
      fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: null, analyses: {} }));
    }
    return;
  }

  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
  // 90s per HTTP request (not per stock — a stock can still take longer across
  // pause_turn resumes, but each individual call is bounded so a single hung request
  // can't stall the whole nightly job indefinitely).
  const client = new Anthropic({ apiKey, timeout: 90 * 1000 });

  const existing = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    : { generatedAt: null, analyses: {} };
  const analyses = { ...existing.analyses };

  // Circuit breaker: if the first few stocks all fail, stop instead of repeating the
  // same (potentially expensive) mistake across all 25 — e.g. a bad request shape or a
  // systemic API issue should fail fast, not burn budget finding out the hard way 25 times.
  const CIRCUIT_BREAKER_THRESHOLD = 4;
  let consecutiveFailures = 0;

  for (const stock of data.stocks) {
    process.stdout.write(`Analyzing ${stock.name}... `);
    try {
      const peers = selectPeers(stock, data.stocks);
      const result = await analyzeStock(client, stock, peers);
      analyses[stock.id] = {
        name: stock.name,
        country: stock.country,
        verdict: result.verdict,
        text: result.text,
        generatedAt: new Date().toISOString(),
      };
      console.log(result.verdict);
      consecutiveFailures = 0;
    } catch (e) {
      console.log(`FAILED (${e.message})`);
      // Keep whatever analysis (if any) already existed for this stock rather than
      // dropping it — a transient API failure on one stock shouldn't erase yesterday's
      // otherwise-still-valid analysis for it.
      consecutiveFailures += 1;
      if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        console.log(`${consecutiveFailures} consecutive failures — stopping early instead of repeating the same failure across all stocks.`);
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), analyses }, null, 2));
  console.log(`Wrote build/analyses.json (${Object.keys(analyses).length} analyses).`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
