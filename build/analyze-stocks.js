// Nightly LLM analysis: for each bank stock, ask Gemini (with Google Search grounding) to
// write a short analysis covering current valuation vs. peers, forward estimates, and
// national macro context, then return a Buy/Neutral/Sell verdict. Writes
// build/analyses.json, consumed by fetch-data.js (verdict badge in the table) and
// analysis-pages.js (the /analys/ pages).
//
// Requires GEMINI_API_KEY. Skipped entirely (with a clear log line, not a failure) if the
// key isn't set, so local builds and PRs without the secret still work.
//
// Previously used Claude with the web_search_20260209 tool. That tool bundles automatic
// code-execution-based "dynamic filtering": against this script's real prompt (peer table +
// long instructions), Claude drove web_search from inside an auto-spawned code_execution
// environment, batched several queries, hit an internal rate limit, and retried — each
// retry a full extra paid round trip. That retry storm caused a 2026-09-13 incident (1.7M
// tokens for 25 stocks, draining the account's funds) and later "Request timed out"
// GitHub Actions failures. Switched to Gemini for fresher news/grounding and to sidestep
// that whole failure class.
const fs = require('fs');
const path = require('path');
const { GoogleGenAI, Type } = require('@google/genai');

const COUNTRY_NAME = { SE: 'Sverige', DK: 'Danmark', FI: 'Finland', NO: 'Norge' };
// Flash rather than Pro: this is a factual comparison/summarization task (peer valuation,
// search-result summary, verdict), not open-ended reasoning, and the cost difference is
// real — see MAX_TOTAL_TOKENS below. gemini-2.5-flash was retired for new API keys as of
// this writing; 3.6 is the current Flash-tier model.
const MODEL = 'gemini-3.6-flash';

// Hard, token-denominated safety net for the whole run, independent of any specific bug.
// This aborts the ENTIRE run, not just one stock, the moment cumulative usage crosses the
// threshold, so a repeat of a runaway-cost failure mode costs at most this many tokens
// instead of running unchecked to completion. ~300k tokens is comfortably above what 25
// grounded Flash calls need normally. Raise it deliberately if that stops being true.
const MAX_TOTAL_TOKENS = 300000;

const ANALYSIS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    analysis: {
      type: Type.STRING,
      description: 'The full analysis text in Swedish, 5-10 sentences, no markdown formatting.',
    },
    verdict: { type: Type.STRING, enum: ['Buy', 'Neutral', 'Sell'] },
  },
  required: ['analysis', 'verdict'],
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

function buildPrompt(stock, peers, previous) {
  const countryName = COUNTRY_NAME[stock.country] || stock.country;
  // The previous analysis is given as PRIVATE context only, to help the model calibrate
  // (e.g. notice drift or confirm a thesis still holds) — never as something the output
  // text may reference. There is no page anywhere that shows a reader the previous
  // analysis or verdict, so a line like "sedan förra analysen har..." makes no sense to a
  // reader and reads as broken. The new text must stand alone as if it's the only analysis
  // this stock has ever had.
  const previousBlock = previous
    ? `\n[Intern bakgrundsinfo, ej för läsaren — använd bara för att kalibrera din egen bedömning] Vid en tidigare intern bedömning (${previous.generatedAt.slice(0, 10)}) blev betyget ${previous.verdict}, med följande resonemang:\n"${previous.text}"\nDetta är bara referens för dig; ingen läsare har sett det. Skriv den nya analysen som ett helt fristående, självständigt dokument — nämn ALDRIG att det finns en tidigare analys, jämför inte explicit med den, och skriv inte fraser som "sedan förra analysen", "tidigare bedömning" eller liknande. Använd i stället bara den tidigare bedömningen för att göra din nya, fristående analys mer konsekvent och välkalibrerad om inget väsentligt förändrats.\n`
    : '';
  return `Du analyserar bankaktien ${stock.fullName} (${stock.name}), noterad i ${countryName} (${stock.yahoo}), för en investerare som överväger att lägga till den i sin portfölj.
${previousBlock}

Nuvarande nyckeltal (hämtade vid byggtillfället ${new Date().toISOString().slice(0, 10)} — dessa marginal-/ROE-siffror bygger på en generisk mall som inte alltid stämmer väl överens med hur banker faktiskt rapporterar, så de kan vara missvisande):
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

Använd webbsökning för att ta reda på det senaste kring bolaget (senaste kvartalsrapport, analytikerkommentarer) och makroläget i ${countryName} (styrränta, inflation, bostadsmarknad, tillväxtutsikter, samt politiska/regulatoriska faktorer som bankskatter, ny bankreglering, politisk stabilitet och kommande val som kan påverka banksektorn) i den mån det påverkar banksektorn där. Kontrollera samtidigt bankens egna rapporterade ROE och K/I-tal (kostnad/intäkt) från senaste kvartalsrapporten eller bokslutskommunikén — om dessa avviker väsentligt (mer än några procentenheter) från nyckeltalen ovan, använd de bankrapporterade siffrorna istället i din analys. Skriv analysen som om dessa rapporterade siffror är de riktiga nyckeltalen — nämn ALDRIG varifrån nyckeltalen ovan kommer, att en avstämning gjorts, eller att en siffra "avvek" eller "korrigerats"; presentera bara det korrekta talet rakt av, precis som med alla andra nyckeltal i analysen.

Skriv en analys på svenska, 5-10 meningar, som täcker:
1. Nuvarande värdering jämfört med de nordiska konkurrenterna ovan — är aktien billigare eller dyrare än sektorn givet dess lönsamhet (ROE, marginaler), inte bara i absoluta tal
2. Prognoser och förväntad utveckling (analytikerkonsensus, vinsttillväxt)
3. Makroläget i ${countryName} på nationell nivå och hur det påverkar bankens affär, inklusive politiska/regulatoriska faktorer där relevant (t.ex. bankskatter, ny reglering, politisk risk)

Avsluta analysen med en tydlig sammanfattande mening om huvudargumentet för eller emot aktien. Skriv rakt och konkret, undvik disclaimers och floskler. Skriv analysen som om det vore den allra första och enda analysen som någonsin gjorts av aktien — nämn aldrig tidigare analyser, bedömningar eller att betyget har ändrats eller kvarstår sedan förut.

Ge också din egen riktkurs (ett konkret pris i ${stock.currency}, ej ett intervall) på 12 månaders sikt baserat på din analys ovan — detta är ditt eget estimat, inte analytikerkonsensus.

Lista också 2-5 av de mest relevanta och färska nyhetskällorna du hittade via webbsökningen (kvartalsrapporter, pressmeddelanden, nyhetsartiklar om bolaget — inte generella börssidor eller kurshistorik). För varje källa, ange den exakta domänen du hittade den på (t.ex. "sebgroup.com", "di.se", "reuters.com" — samma domän som visas i sökresultaten) och en kort, konkret rubrik på svenska som beskriver vad källan handlar om.

Svara ENDAST med ett JSON-objekt på formen {"analysis": "...", "verdict": "Buy" | "Neutral" | "Sell", "priceTarget": <tal, ej sträng>, "sources": [{"domain": "...", "title": "..."}]} — ingen markdown, ingen kodblocksmarkering, ingen extra text före eller efter.`;
}

// Gemini's grounding tool (googleSearch) and structured output (responseSchema) cannot be
// combined in one request — the API drops or rejects the schema when a tool is present. So
// this asks for JSON via prompt instructions instead (see buildPrompt's final paragraph)
// and parses the model's text manually, tolerating a ```json fence if the model adds one.
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`no JSON object found in response text: ${text.slice(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

// The model can write down whatever URL it likes in its JSON output, and there is no
// guarantee that string points anywhere real (or anywhere at all) — LLMs are known to
// invent plausible-looking URLs. So we never trust a model-typed URL. Instead, the model
// reports which DOMAIN it found each item on (e.g. "sebgroup.com"), and this matches that
// against groundingChunks — the actual search results Gemini's web_search tool used,
// which the API returns alongside the response. Only sources with a real, resolvable
// grounding chunk make it into the page; anything the model claims but that has no
// matching chunk is silently dropped rather than shown as a possibly-fake link.
async function resolveSources(reportedSources, groundingChunks) {
  if (!Array.isArray(reportedSources) || !Array.isArray(groundingChunks)) return [];

  const chunksByDomain = new Map();
  for (const chunk of groundingChunks) {
    const uri = chunk?.web?.uri;
    const title = chunk?.web?.title;
    if (!uri || !title) continue;
    const domain = title.replace(/^www\./, '').toLowerCase();
    if (!chunksByDomain.has(domain)) chunksByDomain.set(domain, []);
    chunksByDomain.get(domain).push(uri);
  }

  const resolved = [];
  const usedUris = new Set();
  for (const src of reportedSources) {
    const domain = (src?.domain || '').replace(/^www\./, '').toLowerCase();
    const candidates = chunksByDomain.get(domain);
    if (!domain || !candidates || !src?.title) continue;
    const redirectUri = candidates.find((u) => !usedUris.has(u));
    if (!redirectUri) continue;

    // Google's grounding redirect URL works but isn't a URL a reader would trust or
    // want to see in a link preview — follow it (HEAD, one hop) to get the real article
    // URL. If the fetch fails for any reason, skip this source rather than publish an
    // opaque redirect link.
    try {
      const res = await fetch(redirectUri, { method: 'HEAD', redirect: 'manual' });
      const finalUrl = res.headers.get('location');
      if (!finalUrl) continue;
      usedUris.add(redirectUri);
      resolved.push({ title: src.title, url: finalUrl, domain });
    } catch {
      // Skip — an unresolvable link is worse than no link.
    }
    if (resolved.length >= 5) break;
  }
  return resolved;
}

async function analyzeStock(ai, stock, peers, previous) {
  const prompt = buildPrompt(stock, peers, previous);
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      maxOutputTokens: 8000,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error(`empty response for ${stock.id} (finishReason: ${response.candidates?.[0]?.finishReason})`);
  }

  const parsed = extractJson(text);
  if (!parsed || !parsed.analysis || !['Buy', 'Neutral', 'Sell'].includes(parsed.verdict)) {
    throw new Error(`invalid structured output for ${stock.id}: ${JSON.stringify(parsed)}`);
  }

  const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
  const sources = await resolveSources(parsed.sources, groundingChunks);
  const priceTarget = typeof parsed.priceTarget === 'number' && Number.isFinite(parsed.priceTarget)
    ? parsed.priceTarget
    : null;

  const usage = response.usageMetadata || {};
  return {
    verdict: parsed.verdict,
    sources,
    priceTarget,
    text: parsed.analysis.trim(),
    prompt,
    rawResponse: text,
    model: MODEL,
    tokens: {
      input: usage.promptTokenCount || 0,
      output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
    },
  };
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const outputPath = path.join(__dirname, 'analyses.json');

  if (!apiKey) {
    console.log('GEMINI_API_KEY not set — skipping LLM analysis.');
    if (!fs.existsSync(outputPath)) {
      fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: null, analyses: {} }));
    }
    return;
  }

  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
  const ai = new GoogleGenAI({ apiKey });

  const existing = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    : { generatedAt: null, analyses: {} };
  const analyses = { ...existing.analyses };

  // Analysis (with web search + grounding) is the most expensive part of the nightly
  // build, and valuations/macro context don't meaningfully change day to day — so instead
  // of re-running all 25 stocks every night, each night: (a) any stock with no analysis
  // yet at all gets one immediately, so the site is never missing data for long, and (b)
  // on top of that, one random already-analyzed stock is refreshed, so every stock's
  // analysis still gets refreshed roughly every ~25 nights (about a month) without ever
  // bursting to a full-batch cost on a single night.
  //
  // ANALYZE_ALL=1 overrides this and analyzes every stock in one run. This is a manual,
  // one-time escape hatch (e.g. `ANALYZE_ALL=1 node build/analyze-stocks.js`) — it is NOT
  // wired into the nightly workflow, specifically because an "always analyze everything"
  // default is what caused the 2026-09-13 cost incident this file's other safeguards exist
  // to prevent. Use it deliberately, not as a standing setting.
  const analyzeAll = process.env.ANALYZE_ALL === '1';
  const neverAnalyzed = data.stocks.filter((s) => !analyses[s.id]);
  const alreadyAnalyzed = data.stocks.filter((s) => analyses[s.id]);
  let stocksToAnalyze;
  if (analyzeAll) {
    stocksToAnalyze = data.stocks;
    console.log(`ANALYZE_ALL=1 — analyzing all ${stocksToAnalyze.length} stocks in this run.`);
  } else {
    const randomRefresh = alreadyAnalyzed.length
      ? [alreadyAnalyzed[Math.floor(Math.random() * alreadyAnalyzed.length)]]
      : [];
    stocksToAnalyze = [...neverAnalyzed, ...randomRefresh];
    if (stocksToAnalyze.length === 0) {
      console.log('No stocks to analyze tonight — skipping LLM analysis run.');
      return;
    }
    console.log(`Analyzing ${neverAnalyzed.length} never-analyzed stock(s)${randomRefresh.length ? ` + 1 random refresh (${randomRefresh[0].name})` : ''}.`);
  }

  // Circuit breaker: if the first few stocks all fail, stop instead of repeating the
  // same (potentially expensive) mistake across all 25 — e.g. a bad request shape or a
  // systemic API issue should fail fast, not burn budget finding out the hard way 25 times.
  const CIRCUIT_BREAKER_THRESHOLD = 4;
  let consecutiveFailures = 0;
  let totalTokensUsed = 0;

  for (const stock of stocksToAnalyze) {
    if (totalTokensUsed >= MAX_TOTAL_TOKENS) {
      console.log(`Hit the ${MAX_TOTAL_TOKENS.toLocaleString()}-token run budget (used ${totalTokensUsed.toLocaleString()}) — stopping before analyzing ${stock.name}.`);
      break;
    }
    process.stdout.write(`Analyzing ${stock.name}... `);
    try {
      const peers = selectPeers(stock, data.stocks);
      const previous = analyses[stock.id];
      const result = await analyzeStock(ai, stock, peers, previous);
      analyses[stock.id] = {
        name: stock.name,
        country: stock.country,
        verdict: result.verdict,
        text: result.text,
        sources: result.sources,
        priceTarget: result.priceTarget,
        generatedAt: new Date().toISOString(),
        priceAtAnalysis: stock.price,
        currency: stock.currency,
        debug: {
          model: result.model,
          prompt: result.prompt,
          rawResponse: result.rawResponse,
        },
      };
      totalTokensUsed += result.tokens.input + result.tokens.output;
      console.log(`${result.verdict} (${result.tokens.input.toLocaleString()} in / ${result.tokens.output.toLocaleString()} out, running total ${totalTokensUsed.toLocaleString()})`);
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
  console.log(`Wrote build/analyses.json (${Object.keys(analyses).length} analyses). Total tokens used this run: ${totalTokensUsed.toLocaleString()}.`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
