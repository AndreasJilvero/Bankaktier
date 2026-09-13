// Nightly LLM analysis: for each bank stock, ask Claude (with web search) to write a
// short analysis covering current valuation, forward estimates, and macro context for
// its home country, then extract a Buy/Neutral/Sell verdict from that analysis via a
// second, tool-free structured-output call. Writes build/analyses.json, consumed by
// fetch-data.js (verdict badge in the table) and analysis-pages.js (the /analys/ pages).
//
// Requires ANTHROPIC_API_KEY. Skipped entirely (with a clear log line, not a failure)
// if the key isn't set, so local builds and PRs without the secret still work.
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const COUNTRY_NAME = { SE: 'Sverige', DK: 'Danmark', FI: 'Finland', NO: 'Norge' };
const MODEL = 'claude-opus-5';

const VERDICT_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['Buy', 'Neutral', 'Sell'] },
    },
    required: ['verdict'],
    additionalProperties: false,
  },
};

function buildResearchPrompt(stock) {
  const countryName = COUNTRY_NAME[stock.country] || stock.country;
  return `Du analyserar bankaktien ${stock.fullName} (${stock.name}), noterad i ${countryName} (${stock.yahoo}), för en investerare som överväger att lägga till den i sin portfölj.

Nuvarande nyckeltal (hämtade vid byggtillfället, ${new Date().toISOString().slice(0, 10)}):
- Kurs: ${stock.price} ${stock.currency} (idag ${stock.changeToday > 0 ? '+' : ''}${stock.changeToday}%, 3 mån ${stock.change3m}%, 12 mån ${stock.change12m}%)
- Börsvärde: ${(stock.marketCap / 1e9).toFixed(1)} miljarder ${stock.currency}
- P/E (historiskt): ${stock.trailingPE ?? 'okänt'}, P/E (prognos): ${stock.forwardPE ?? 'okänt'}
- P/B: ${stock.priceToBook ?? 'okänt'}
- ROE: ${stock.returnOnEquity ?? 'okänt'}%
- Rörelsemarginal: ${stock.operatingMargin ?? 'okänt'}%, nettomarginal: ${stock.netMargin ?? 'okänt'}%
- Direktavkastning: ${stock.dividendYield ?? 'okänt'}%, utdelningsandel: ${stock.payoutRatio ?? 'okänt'}%
- Analytikernas snittriktkurs: ${stock.targetMeanPrice ? Math.round(stock.targetMeanPrice) + ' ' + stock.currency : 'okänt'} (${stock.upside != null ? (stock.upside > 0 ? '+' : '') + stock.upside.toFixed(1) + '%' : 'okänt'} mot nuvarande kurs, baserat på ${stock.analystCount ?? '?'} analytiker)
- Rekommendationer: ${stock.recommendations ? `${stock.recommendations.strongBuy + stock.recommendations.buy} köp, ${stock.recommendations.hold} behåll, ${stock.recommendations.sell + stock.recommendations.strongSell} sälj` : 'okänt'}
- Beta: ${stock.beta ?? 'okänt'}

Använd webbsökning för att ta reda på det senaste kring bolaget (senaste kvartalsrapport, analytikerkommentarer) och makroläget i ${countryName} (styrränta, inflation, bostadsmarknad, tillväxtutsikter) i den mån det påverkar banksektorn där.

Skriv en analys på svenska, 5-10 meningar, som täcker:
1. Nuvarande värdering (är den hög/låg/rimlig jämfört med historik och sektorn givet lönsamheten)
2. Prognoser och förväntad utveckling (analytikerkonsensus, vinsttillväxt)
3. Makroläget i ${countryName} på nationell nivå och hur det påverkar bankens affär

Avsluta analysen med en tydlig sammanfattande mening om huvudargumentet för eller emot aktien. Skriv rakt och konkret, undvik disclaimers och floskler.`;
}

async function analyzeStock(client, stock) {
  const researchResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
    messages: [{ role: 'user', content: buildResearchPrompt(stock) }],
  });

  let finalResponse = researchResponse;
  let messages = [{ role: 'user', content: buildResearchPrompt(stock) }];
  // Resume if a long tool-use turn paused before finishing.
  while (finalResponse.stop_reason === 'pause_turn') {
    messages = [...messages, { role: 'assistant', content: finalResponse.content }];
    finalResponse = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
      messages,
    });
  }

  const analysisText = finalResponse.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim();

  if (!analysisText) {
    throw new Error(`empty analysis text for ${stock.id} (stop_reason: ${finalResponse.stop_reason})`);
  }

  const verdictResponse = await client.messages.parse({
    model: MODEL,
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: `Läs den här aktieanalysen och avgör om helhetsbilden är Buy, Neutral eller Sell:\n\n${analysisText}`,
      },
    ],
    output_config: { format: VERDICT_SCHEMA },
  });

  const verdict = verdictResponse.parsed_output?.verdict;
  if (!verdict || !['Buy', 'Neutral', 'Sell'].includes(verdict)) {
    throw new Error(`invalid verdict for ${stock.id}: ${JSON.stringify(verdictResponse.parsed_output)}`);
  }

  return { verdict, text: analysisText };
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
  const client = new Anthropic({ apiKey });

  const existing = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    : { generatedAt: null, analyses: {} };
  const analyses = { ...existing.analyses };

  for (const stock of data.stocks) {
    process.stdout.write(`Analyzing ${stock.name}... `);
    try {
      const result = await analyzeStock(client, stock);
      analyses[stock.id] = {
        name: stock.name,
        country: stock.country,
        verdict: result.verdict,
        text: result.text,
        generatedAt: new Date().toISOString(),
      };
      console.log(result.verdict);
    } catch (e) {
      console.log(`FAILED (${e.message})`);
      // Keep whatever analysis (if any) already existed for this stock rather than
      // dropping it — a transient API failure on one stock shouldn't erase yesterday's
      // otherwise-still-valid analysis for it.
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
