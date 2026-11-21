/**
 * RemoteHunt relay — Cloudflare Worker: AI relay + employer job crawler.
 * The app calls POST /v1/chat/completions (OpenAI format). The Worker answers with Cloudflare
 * Workers AI (free daily allowance, no key needed) and falls back to any provider keys you add
 * as secrets: GEMINI_KEY, GROQ_KEY, OPENROUTER_KEY.
 *
 * Bindings / settings (Cloudflare dashboard → Worker → Settings):
 *   AI          Workers AI binding (required)
 *   DB          D1 database binding (required for jobs; also enables the per-device daily AI cap)
 *   Cron        trigger "* * * * *" (crawls ~10 employers per minute)
 *   ACCESS_CODE secret; your personal access code (RH-XXXXX-XXXXX). Changing it signs your phone out.
 *   DAILY_CAP   text variable; AI calls per day (default 200), a safety limit on your provider keys
 *   WAI_MODEL   text variable; Workers AI model (default @cf/openai/gpt-oss-20b)
 * Prompts and CVs are never stored or logged.
 */
const DEFAULT_MODEL = '@cf/openai/gpt-oss-20b';
const FALLBACK_WAI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const MAX_INPUT_CHARS = 60000;
const MAX_OUT_TOKENS = 4096;

// Strongest first, weakest last. Each secret may hold several keys separated by commas.
// Cloudflare Workers AI (no key) is always the final fallback.
const OPENAI_COMPAT = [
  { id: 'gemini-flash', secret: 'GEMINI_KEY', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest', effort: 'low' },
  { id: 'groq-gpt-oss-120b', secret: 'GROQ_KEY', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', effort: 'low' },
  { id: 'cerebras-gpt-oss-120b', secret: 'CEREBRAS_KEY', base: 'https://api.cerebras.ai/v1', model: 'gpt-oss-120b', effort: 'low' },
  { id: 'gemini-flash-lite', secret: 'GEMINI_KEY', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-lite-latest', effort: 'low' },
  { id: 'openrouter-free', secret: 'OPENROUTER_KEY', base: 'https://openrouter.ai/api/v1', model: 'openrouter/free' },
  { id: 'mistral-small', secret: 'MISTRAL_KEY', base: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
  { id: 'groq-llama-8b', secret: 'GROQ_KEY', base: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' }
];
function keysOf(env, secret) { return String(env[secret] || '').split(',').map((k) => k.trim()).filter(Boolean); }

// in-memory fallback limiter (per isolate) when no D1 database is bound
const memCounts = new Map();
const cooldown = new Map(); // provider -> until timestamp
const noEffort = new Set(); // providers that refused reasoning_effort

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...extra } });
}
function err(status, message, code) {
  return json({ error: { message, code: code || status } }, status);
}
function today() { return new Date().toISOString().slice(0, 10); }

async function countUse(env, device) {
  const cap = parseInt(env.DAILY_CAP || '200', 10);
  const day = today();
  if (env.DB) {
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS usage (device TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (device, day))').run();
      const row = await env.DB.prepare('INSERT INTO usage (device, day, n) VALUES (?1, ?2, 1) ON CONFLICT(device, day) DO UPDATE SET n = n + 1 RETURNING n')
        .bind(device, day).first();
      return { used: row ? row.n : 1, cap };
    } catch (e) { /* fall through to memory */ }
  }
  const k = device + '|' + day;
  const n = (memCounts.get(k) || 0) + 1;
  memCounts.set(k, n);
  if (memCounts.size > 5000) memCounts.clear();
  return { used: n, cap };
}

function textOf(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  if (r.response && typeof r.response === 'object') return JSON.stringify(r.response);
  if (r.choices && r.choices[0]) {
    const m = r.choices[0].message || {};
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map((c) => c.text || '').join('');
    if (typeof r.choices[0].text === 'string') return r.choices[0].text;
  }
  if (typeof r.output_text === 'string') return r.output_text;
  if (Array.isArray(r.output)) {
    return r.output.filter((o) => o.type === 'message' || o.content).map((o) => (o.content || []).map((c) => c.text || '').join('')).join('');
  }
  if (r.result) return textOf(r.result);
  return '';
}

function stripThinking(s) { return String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim(); }

async function viaWorkersAI(env, body, ms) {
  if (!env.AI) throw Object.assign(new Error('Workers AI binding "AI" is missing'), { status: 500 });
  const models = [env.WAI_MODEL || DEFAULT_MODEL];
  if (!env.WAI_MODEL) models.push(FALLBACK_WAI_MODEL);
  let last;
  for (const model of models) {
    try {
      let timer;
      const r = await Promise.race([
        env.AI.run(model, { messages: body.messages, max_tokens: body.max_tokens, temperature: body.temperature }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(model + ' too slow'), { status: 504 })), ms || STEP_MAX_MS); })
      ]).finally(() => clearTimeout(timer));
      const text = stripThinking(textOf(r));
      if (text) return { text, model };
      last = Object.assign(new Error('Empty reply from ' + model), { status: 502 });
    } catch (e) {
      last = e;
      if (e && e.status === 504) throw e; // out of time: don't start a second model
      // daily free allowance used up → no point trying another Workers AI model
      if (/4006|neuron|allocation|quota|limit/i.test(String(e && e.message))) throw Object.assign(new Error('Workers AI daily allowance used up'), { status: 429 });
    }
  }
  throw last;
}

async function viaOpenAI(p, key, body, ms) {
  const send = async (effort) => {
    const payload = { model: p.model, messages: body.messages, max_tokens: body.max_tokens, temperature: body.temperature };
    if (effort) payload.reasoning_effort = effort;
    let r;
    try {
      r = await fetch(p.base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'HTTP-Referer': 'https://remotehunt.app', 'X-Title': 'RemoteHunt' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(ms)
      });
    } catch (e) {
      const to = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw Object.assign(new Error(p.id + (to ? ' too slow (' + Math.round(ms / 1000) + 's)' : ' network error')), { status: to ? 504 : 502 });
    }
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (e) { }
    return { r, j, t };
  };
  const effort = p.effort && !noEffort.has(p.id) ? p.effort : null;
  let { r, j, t } = await send(effort);
  // a provider that rejects reasoning_effort: retry once without it and stop sending it
  if (effort && ((r.status === 400 && /reasoning|effort/i.test(t)) || r.status >= 500)) {
    ({ r, j, t } = await send(null));
    if (r.ok) noEffort.add(p.id);
  }
  if (!r.ok) {
    // keep the provider's own reason (e.g. "API key not valid") so problems are visible instead of silently skipped
    const why = j && j.error ? (typeof j.error === 'string' ? j.error : j.error.message || '') : (Array.isArray(j) && j[0] && j[0].error ? j[0].error.message : '');
    throw Object.assign(new Error(p.id + ' HTTP ' + r.status + (why ? ': ' + String(why).replace(/\s+/g, ' ').slice(0, 160) : '')), { status: r.status });
  }
  const text = stripThinking(textOf(j));
  if (!text) throw Object.assign(new Error(p.id + ' empty reply'), { status: 502 });
  return { text, model: (j && j.model) || p.model };
}

// the phone waits up to 120 s, so the whole chain must answer well before that
const TOTAL_BUDGET_MS = 95000;
const STEP_MAX_MS = 45000;
const STEP_MIN_MS = 8000;

// If a provider hasn't answered after HEDGE_MS, the next one starts alongside it and the first good answer wins.
// (Gemini's main model sometimes takes 45 s+ under load; its light model answers the same prompt in ~5 s.)
const HEDGE_MS = 15000;

function complete(env, body) {
  const chain = [];
  for (const p of OPENAI_COMPAT) {
    keysOf(env, p.secret).forEach((key, i) => chain.push({ id: p.id + (i ? '#' + (i + 1) : ''), run: (ms) => viaOpenAI(p, key, body, ms) }));
  }
  chain.push({ id: 'workers-ai', run: (ms) => viaWorkersAI(env, body, ms) });
  const errors = [];
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let i = 0, running = 0, done = false;
    const giveUp = () => {
      if (done || running || i < chain.length) return;
      done = true;
      reject(Object.assign(new Error('All AI providers are busy or out of free quota. ' + errors.join(' | ')), { status: 503 }));
    };
    const next = () => {
      while (!done && i < chain.length) {
        const step = chain[i++];
        if ((cooldown.get(step.id) || 0) > Date.now()) { errors.push(step.id + ': cooling down'); continue; }
        const left = TOTAL_BUDGET_MS - (Date.now() - start);
        if (left < STEP_MIN_MS && step.id !== 'workers-ai') { errors.push(step.id + ': skipped (out of time)'); continue; }
        running++;
        let hedged = false;
        const hedge = setTimeout(() => { hedged = true; next(); }, parseInt(env.HEDGE_MS, 10) || HEDGE_MS);
        step.run(Math.min(STEP_MAX_MS, Math.max(left, STEP_MIN_MS))).then((out) => {
          clearTimeout(hedge); running--;
          if (!done) { done = true; resolve({ ...out, provider: step.id, skipped: errors.slice() }); }
        }, (e) => {
          clearTimeout(hedge); running--;
          errors.push(String(e && e.message).slice(0, 200));
          if (e && step.id === 'workers-ai' && e.status === 429) {
            const midnight = new Date(); midnight.setUTCHours(24, 0, 0, 0);
            cooldown.set(step.id, midnight.getTime()); // free allowance resets 00:00 UTC
          } else if (e && (e.status === 429 || e.status === 401 || e.status === 403)) cooldown.set(step.id, Date.now() + (e.status === 429 ? 5 : 30) * 60000);
          else if (e && e.status === 504) cooldown.set(step.id, Date.now() + 3 * 60000); // too slow right now: skip it for a few minutes
          if (!hedged || !running) next(); // failed fast, or nothing else is still trying: move on
          giveUp();
        });
        return;
      }
      giveUp();
    };
    next();
  });
}

async function chatCompletions(request, env) {
    let body;
    try { body = await request.json(); } catch (e) { return err(400, 'Invalid JSON'); }
    if (!Array.isArray(body.messages) || !body.messages.length) return err(400, 'messages required');
    const messages = body.messages.filter((m) => m && typeof m.content === 'string' && /^(system|user|assistant)$/.test(m.role)).map((m) => ({ role: m.role, content: m.content }));
    const size = messages.reduce((n, m) => n + m.content.length, 0);
    if (!messages.length) return err(400, 'messages required');
    if (size > MAX_INPUT_CHARS) return err(413, 'Request too large');

    const device = (request.rhUser || request.headers.get('X-RH-Device') || request.headers.get('CF-Connecting-IP') || 'anon').slice(0, 64);
    const { used, cap } = await countUse(env, device);
    if (used > cap) return err(429, 'Daily AI limit reached (' + cap + ' requests). It resets at 5:30 AM IST, or add your own free key in Settings.', 'daily_cap');

    const clean = {
      messages,
      max_tokens: Math.min(Math.max(parseInt(body.max_tokens, 10) || 2048, 64), MAX_OUT_TOKENS),
      temperature: typeof body.temperature === 'number' ? Math.min(Math.max(body.temperature, 0), 1.2) : 0.3
    };
    try {
      const out = await complete(env, clean);
      return json({
        id: 'rh-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: out.model, provider: out.provider,
        choices: [{ index: 0, message: { role: 'assistant', content: out.text }, finish_reason: 'stop' }],
        usage_today: { used, cap },
        ...(out.skipped.length ? { skipped: out.skipped } : {}) // stronger providers that failed first, and why
      });
    } catch (e) {
      return err(e.status || 500, String(e.message || e));
    }
}

// ============================================================================ JOB CRAWLER
// Reads companies' own hiring systems (public, keyless APIs), keeps only fully-remote jobs,
// and stores each company's jobs as a ready JSON string so the feed is served without re-parsing.
const SEED_BOARDS = {"gr": "stripe airbnb coinbase robinhood figma discord asana pinterest reddit cloudflare affirm instacart datadog gitlab dropbox twitch anthropic databricks samsara brex flexport squarespace doximity lyft roblox okta elastic mongodb twilio zscaler udemy peloton carta checkr duolingo faire mixpanel remote scaleai vercel webflow airtable calendly pagerduty gusto chime toast postman launchdarkly amplitude justworks smartsheet nextdoor betterment sofi n26 gocardless monzo grafanalabs andurilindustries janestreet blend marqeta billcom attentive braze iterable contentful algolia fastly netlify circleci planetscale temporaltechnologies togetherai gleanwork intercom typeform stockx cameo kickstarter wikimedia mozilla proton bitwarden wizinc tailscale jfrog chainguard oura mavenclinic recursionpharmaceuticals verkada rubrik sambanovasystems coreweave nuro rocketlab vardaspace redwoodmaterials gomotive carvana highnote lithic tripactions prisma descope cribl honeycomb pendo airship customerio klaviyo narvar flexe project44 fourkites bringg remotecom lattice cultureamp greenhouse textio seekout hackerrank karat ziprecruiter upwork doordashusa netskope orcasecurity huntress abnormalsecurity axonius catonetworks knowbe4 recordedfuture censys bigid onetrust osano hightouch starburst imply labelbox snorkelai dominodatalab arizeai newrelic sumologic globalizationpartners epicgames riotgames scopely gemini fireblocks bitgo consensys figure current public traderepublicbank homelight orchard knock humaninterest vestwell alpaca cleo earnin ginkgobioworks freenome natera truveta flatironhealth calicolabs beamtherapeutics swordhealth omadahealth onemedical parsleyhealth calm betterhelp talkspace cerebral modernhealth myfitnesspal tempo future classpass mindbody gympass coursera udacity khanacademy masterclass outschool springboard newsela ixllearning goguardian imbue inflectionai stabilityai blackforestlabs relativity everlaw alloy forter riskified feedzai complyadvantage novacredit homeward vacasa kasa taskrabbit instawork movableink bloomreach quillbot invisibletech turing wrike aha qualtrics backblaze wasabi minio filecoinfoundation prismatic workato celigo appian mercury truelayer sezzle luno bitpanda binance okx bybit vectara assemblyai speechmatics otterai cresta observeai polyai manychat 6sense zoominfo apolloio cognism mercari offerup stitchfix grailed hellofresh homechef thrivemarket misfitsmarket weee", "le": "palantir ro veeva tala wattpad aircall brightedge zoox outreach highspot kapwing", "as": "ramp linear openai watershed substack notion runway synthesia cursor replit modal levels middesk vanta abridge sardine decagon harvey sierra speak crusoe rilla suno elevenlabs baseten braintrust lovable bland posthog warp rho mercor persona anrok orb commonroom vellum langchain pinecone weaviate runpod merge nango endgame drata secureframe headway cedar aurorasolar resend triggerdev rula skydio saronic whoop superpower eightsleep attio gamma zapier unit column moderntreasury poolside reflectionai character krea zilch griffin snowflake preply", "sm": "Visa Equinox TheWonderfulCompany Version1 BoschGroup DeliveryHero", "wo": "huggingface eqltech i-tech-people mondu", "re": "helloprint channable trustedshops bunq cmcom"};
const SEED_GUESS = "automattic gitlab zapier buffer doist toptal hotjar remote remotecom deel oyster papayaglobal lattice gusto airtable notion figma canva atlassian shopify plaid brex ramp mercury wise revolut gocardless chime coinbase kraken gemini consensys chainlinklabs alchemy ledger circle ripple uniswaplabs opensea dydx aave polygon nearfoundation solanafoundation avalabs dfinity fireblocks chainalysis elastic mongodb cockroachlabs timescale supabase planetscale neon vercel netlify cloudflare fastly digitalocean hashicorp grafanalabs datadog newrelic honeycomb sentry posthog mixpanel amplitude twilio intercom zendesk hubspot close pipedrive calendly loom miro clickup asana smartsheet 1password bitwarden okta duolingo coursera udemy khanacademy codecademy scribd medium substack wikimedia mozilla canonical suse docker jetbrains sourcegraph gitbook replit retool airbyte dbtlabs fivetran databricks snowflake confluent starburst hex observablehq streamlit huggingface anthropic openai cohere mistral perplexity scaleai labelbox wandb pinecone weaviate qdrant langchain modal runpod togetherai anyscale deepgram assemblyai elevenlabs synthesia descript runwayml jasper grammarly deepl wrike toggl harvest dropbox zoom discord reddit pinterest twitch spotify soundcloud bandcamp patreon kickstarter gumroad teachable kajabi thinkific podia kit ghost squarespace wix webflow framer bubble make n8n typeform jotform surveymonkey qualtrics fullstory contentsquare optimizely launchdarkly circleci buildkite gitpod coder tailscale ngrok goteleport snyk sonarsource crowdstrike sentinelone wiz tines drata vanta secureframe onetrust rippling justworks hibob gem turing andela arc crossover xteam braintrust upwork fiverr contra wellfound producthunt appwrite strapi directus sanity contentful storyblok prismic algolia meilisearch typesense mapbox razorpay postman browserstack freshworks chargebee hasura atlan druva innovaccer swiggy zomato cred groww zerodha meesho sharechat unacademy phonepe cars24 urbancompany nykaa darwinbox yellowai haptik gupshup exotel clevertap moengage webengage whatfix uniphore observeai sprinklr mindtickle capillary icertis highradius pubmatic tredence fractal thoughtworks multiplier skuad remotepass velocityglobal globalization-partners safetywing hackerrank hackerearth codility testgorilla doximity hims ro noom calm headspace betterhelp talkspace cerebral spring lyra modernhealth oscar devoted collectivehealth carbonhealth zocdoc sword hingehealth omada"; // tried on greenhouse, lever and ashby; dead ones are dropped
const SEED = [];
for (const code of Object.keys(SEED_BOARDS)) for (const slug of SEED_BOARDS[code].split(' ')) SEED.push([code, slug, '']);
for (const slug of SEED_GUESS.split(' ')) for (const code of ['gr?', 'le?', 'as?']) if (!SEED_BOARDS[code.slice(0, 2)] || !(' ' + SEED_BOARDS[code.slice(0, 2)] + ' ').includes(' ' + slug + ' ')) SEED.push([code, slug, '']);
const SEED_VERSION = 'v1';
const ATS = { gr: 'greenhouse', le: 'lever', as: 'ashby', sm: 'smartrecruiters', wo: 'workable', re: 'recruitee' };
const PER_RUN = 20;            // companies per run (≤ 50 subrequests on the free plan)
const NEW_GUESS_BYTES = 40000; // most unchecked companies are small or don't exist
const BYTE_BUDGET = 1100000;   // bytes parsed per run, keeps CPU under the free plan's 10 ms
const REMOTE = /\b(remote|anywhere|work from home|wfh|distributed|worldwide|global)\b/i;
const NOT_REMOTE = /\b(hybrid|on-?site|in[- ]office)\b/i;
const SLUG_RE = /^[a-z0-9][a-z0-9_.-]{1,60}$/i;

function strip(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}
function ms(v) { if (!v) return 0; if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; const t = Date.parse(String(v).replace(' UTC', 'Z').replace(' ', 'T')); return isNaN(t) ? 0 : t; }
function money(min, max, cur, per) {
  min = Number(min) || 0; max = Number(max) || 0; if (!min && !max) return '';
  const f = (n) => n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
  const c = !cur || cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur + ' ';
  return c + (min && max && min !== max ? f(min) + '–' + f(max) : f(max || min)) + (per && !/year|annual/i.test(per) ? '/' + String(per).toLowerCase().replace(/ly$/, '') : '');
}
function remoteLoc(loc) { return REMOTE.test(loc) && !NOT_REMOTE.test(loc); }

function boardUrl(ats, slug) {
  switch (ats) {
    case 'greenhouse': return 'https://boards-api.greenhouse.io/v1/boards/' + slug + '/jobs';
    case 'lever': return 'https://api.lever.co/v0/postings/' + slug + '?mode=json';
    case 'ashby': return 'https://api.ashbyhq.com/posting-api/job-board/' + slug + '?includeCompensation=true';
    case 'smartrecruiters': return 'https://api.smartrecruiters.com/v1/companies/' + slug + '/postings?limit=100';
    case 'workable': return 'https://apply.workable.com/api/v1/widget/accounts/' + slug;
    case 'recruitee': return 'https://' + slug + '.recruitee.com/api/offers/';
  }
}

/** Parse one board → { name, jobs:[compact remote jobs] }. Exported for tests. */
function parseBoard(ats, slug, data) {
  const out = []; let name = '';
  if (ats === 'greenhouse') {
    for (const j of data.jobs || []) {
      const loc = (j.location && j.location.name) || '';
      if (!remoteLoc(loc)) continue;
      name = name || j.company_name || '';
      out.push({ i: String(j.id), t: j.title, l: loc, u: j.absolute_url,
        a: 'https://job-boards.greenhouse.io/embed/job_app?for=' + slug + '&token=' + j.id,
        p: ms(j.first_published || j.updated_at) });
    }
  } else if (ats === 'lever') {
    for (const j of Array.isArray(data) ? data : []) {
      const c = j.categories || {}, loc = [c.location].concat(c.allLocations || []).filter(Boolean).join(' / ');
      const wt = String(j.workplaceType || '').toLowerCase();
      if (!(wt === 'remote' || (wt !== 'hybrid' && wt !== 'onsite' && remoteLoc(loc)))) continue;
      const sr = j.salaryRange || {};
      out.push({ i: j.id, t: j.text, l: loc || 'Remote', d: c.team || c.department || '', e: c.commitment || '', u: j.hostedUrl, a: j.applyUrl || (j.hostedUrl + '/apply'),
        p: ms(j.createdAt), s: money(sr.min, sr.max, sr.currency, sr.interval), x: String(j.descriptionPlain || '').replace(/\s+/g, ' ').slice(0, 700) });
    }
  } else if (ats === 'ashby') {
    for (const j of data.jobs || []) {
      if (j.isListed === false) continue;
      const wt = String(j.workplaceType || '').toLowerCase();
      const loc = [j.location].concat((j.secondaryLocations || []).map((s) => s.location)).filter(Boolean).join(' / ');
      if (!(wt === 'remote' || (j.isRemote && wt !== 'hybrid' && wt !== 'onsite'))) continue;
      out.push({ i: j.id, t: j.title, l: loc || 'Remote', d: j.department || j.team || '', e: j.employmentType || '', u: j.jobUrl, a: j.applyUrl || (j.jobUrl + '/application'),
        p: ms(j.publishedAt), s: (j.compensation && (j.compensation.compensationTierSummary || j.compensation.scrapeableCompensationSalarySummary)) || '',
        x: String(j.descriptionPlain || strip(j.descriptionHtml)).replace(/\s+/g, ' ').slice(0, 700) });
    }
  } else if (ats === 'smartrecruiters') {
    for (const j of data.content || []) {
      const l = j.location || {};
      if (!(l.remote || l.fullyRemote)) continue;
      if (l.hybrid) continue;
      name = name || (j.company && j.company.name) || '';
      const cid = (j.company && j.company.identifier) || slug;
      out.push({ i: String(j.id), t: j.name, l: ['Remote', l.city, l.country && String(l.country).toUpperCase()].filter(Boolean).join(', '), d: (j.department && j.department.label) || '',
        e: (j.typeOfEmployment && j.typeOfEmployment.label) || '', u: 'https://jobs.smartrecruiters.com/' + cid + '/' + j.id, a: 'https://jobs.smartrecruiters.com/oneclick-ui/company/' + cid + '/publication/' + (j.uuid || j.id),
        p: ms(j.releasedDate) });
    }
  } else if (ats === 'workable') {
    name = data.name || '';
    for (const j of data.jobs || []) {
      const loc = (j.locations && j.locations.length ? j.locations.map((x) => [x.city, x.country].filter(Boolean).join(', ')).join(' / ') : [j.city, j.country].filter(Boolean).join(', '));
      if (!(j.telecommuting === true || String(j.workplace || '').toLowerCase() === 'remote')) continue;
      if (String(j.workplace || '').toLowerCase() === 'hybrid') continue;
      out.push({ i: j.shortcode, t: j.title, l: 'Remote' + (loc ? ' — ' + loc : ''), d: j.department || '', e: j.employment_type || '',
        u: j.url || j.shortlink, a: j.application_url || ((j.url || '') + '/apply'), p: ms(j.published_on || j.created_at) });
    }
  } else if (ats === 'recruitee') {
    for (const j of data.offers || []) {
      if (!(j.remote === true && !j.hybrid && !j.on_site)) continue;
      name = name || j.company_name || '';
      const sal = j.salary || {};
      out.push({ i: String(j.id), t: j.title, l: ['Remote', j.location || [j.city, j.country].filter(Boolean).join(', ')].filter(Boolean).join(' — '), d: j.department || '',
        e: j.employment_type_code || '', u: j.careers_url, a: j.careers_apply_url || j.careers_url, p: ms(j.published_at || j.created_at),
        s: money(sal.min, sal.max, sal.currency, sal.period), x: strip(j.description).slice(0, 700) });
    }
  }
  for (const j of out) { for (const k of Object.keys(j)) if (j[k] === '' || j[k] == null || j[k] === 0) delete j[k]; }
  return { name, jobs: out };
}

const schemaReady = new WeakSet();
async function ensureSchema(env) {
  if (schemaReady.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS companies (ats TEXT NOT NULL, slug TEXT NOT NULL, name TEXT, status TEXT NOT NULL DEFAULT \'new\', next_check INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0, n_jobs INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, jobs_json TEXT, checked_at INTEGER, source TEXT, PRIMARY KEY (ats, slug))'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS companies_next ON companies (status, next_check)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)')
  ]);
  const m = await env.DB.prepare('SELECT v FROM meta WHERE k = ?1').bind('seed').first();
  if (!m || m.v !== SEED_VERSION) {
    const stmts = [];
    for (const [code, slug, name] of SEED) {
      const guess = code.endsWith('?');
      stmts.push(env.DB.prepare('INSERT OR IGNORE INTO companies (ats, slug, name, status, next_check, source) VALUES (?1, ?2, ?3, \'new\', ?4, ?5)')
        .bind(ATS[code.slice(0, 2)], slug.toLowerCase(), name || null, guess ? 1 : 0, guess ? 'guess' : 'seed'));
    }
    for (let i = 0; i < stmts.length; i += 400) await env.DB.batch(stmts.slice(i, i + 400));
    await env.DB.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?1, ?2)').bind('seed', SEED_VERSION).run();
  }
  schemaReady.add(env.DB);
}

async function crawl(env) {
  if (!env.DB) return { error: 'no DB binding' };
  await ensureSchema(env);
  const now = Date.now();
  if (!(await takeLock(env, now))) return { ran: false, busy: true };
  const due = (await env.DB.prepare('SELECT ats, slug, name, fails, bytes, status FROM companies WHERE status IN (\'new\', \'ok\', \'empty\') AND next_check <= ?1 ORDER BY next_check LIMIT ?2')
    .bind(now, PER_RUN).all()).results || [];
  // fit within the byte budget, smallest known boards first; always take at least one
  const size = (c) => c.bytes || (c.status === 'new' ? NEW_GUESS_BYTES : 150000);
  due.sort((a, b) => size(a) - size(b));
  const pick = []; let est = 0;
  for (const c of due) { const b = size(c); if (pick.length && est + b > BYTE_BUDGET) continue; pick.push(c); est += b; }
  // claim them first: if this run dies (CPU limit), they are retried later instead of blocking the queue forever
  if (pick.length) await env.DB.batch(pick.map((c) => env.DB.prepare('UPDATE companies SET next_check = ?1 WHERE ats = ?2 AND slug = ?3').bind(now + 15 * 60e3, c.ats, c.slug)));
  const responses = await Promise.all(pick.map((c) => fetch(boardUrl(c.ats, c.slug), { headers: { 'User-Agent': 'RemoteHunt/1.0 (+job aggregator for personal use)', Accept: 'application/json' }, cf: { cacheTtl: 0 } })
    .then(async (r) => ({ c, status: r.status, text: r.ok ? await r.text() : '' }), (e) => ({ c, status: 0, text: '' }))));
  const stmts = []; let parsed = 0; const report = [];
  for (const { c, status, text } of responses) {
    if (status === 404 || status === 410 || (status >= 400 && status < 500 && status !== 429)) {
      const fails = c.fails + 1, dead = fails >= (c.status === 'new' ? 1 : 3);
      stmts.push(env.DB.prepare('UPDATE companies SET fails = ?1, status = ?2, next_check = ?3, checked_at = ?4 WHERE ats = ?5 AND slug = ?6')
        .bind(fails, dead ? 'dead' : c.status, now + 24 * 3600e3, now, c.ats, c.slug));
      report.push(c.ats + ':' + c.slug + ' ' + status); continue;
    }
    if (!text) { stmts.push(env.DB.prepare('UPDATE companies SET next_check = ?1 WHERE ats = ?2 AND slug = ?3').bind(now + 3600e3, c.ats, c.slug)); continue; }
    if (parsed && parsed + text.length > BYTE_BUDGET * 1.3) { // too much for this run: remember its size and retry soon
      stmts.push(env.DB.prepare('UPDATE companies SET bytes = ?1, next_check = ?2 WHERE ats = ?3 AND slug = ?4').bind(text.length, now + 60e3, c.ats, c.slug));
      report.push(c.slug + ' deferred'); continue;
    }
    parsed += text.length;
    let data; try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!data) { stmts.push(env.DB.prepare('UPDATE companies SET fails = fails + 1, next_check = ?1 WHERE ats = ?2 AND slug = ?3').bind(now + 6 * 3600e3, c.ats, c.slug)); continue; }
    const { name, jobs } = parseBoard(c.ats, c.slug, data);
    const json = JSON.stringify(jobs);
    // companies with remote jobs are re-checked every ~2h, others every ~12h (jittered)
    const next = now + (jobs.length ? 2 : 12) * 3600e3 + Math.floor(Math.random() * 1800e3);
    stmts.push(env.DB.prepare('UPDATE companies SET name = COALESCE(?1, name), status = ?2, fails = 0, n_jobs = ?3, bytes = ?4, jobs_json = ?5, checked_at = ?6, next_check = ?7 WHERE ats = ?8 AND slug = ?9')
      .bind(name || null, jobs.length ? 'ok' : 'empty', jobs.length, text.length, jobs.length ? json : null, now, next, c.ats, c.slug));
    report.push(c.ats + ':' + c.slug + ' ' + jobs.length);
  }
  if (stmts.length) await env.DB.batch(stmts);
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM companies WHERE status IN (\'new\', \'ok\', \'empty\') AND next_check <= ?1').bind(Date.now()).first();
  await env.DB.prepare('UPDATE meta SET v = ?1 WHERE k = ?2').bind('0', 'crawl_lock').run();
  return { ran: true, checked: report, due: left ? left.n : 0 };
}

// one crawl at a time (cron, app pings and background runs can overlap); a stuck lock expires after 25 s
async function takeLock(env, now) {
  await env.DB.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?1, ?2)').bind('crawl_lock', '0').run();
  const r = await env.DB.prepare('UPDATE meta SET v = ?1 WHERE k = ?2 AND CAST(v AS INTEGER) < ?3').bind(String(now), 'crawl_lock', now - 25000).run();
  return !!(r && r.meta && r.meta.changes === 1);
}

async function feed(env, url) {
  if (!env.DB) return err(503, 'Job database not connected yet');
  await ensureSchema(env);
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  const rows = (await env.DB.prepare('SELECT ats, slug, name, jobs_json, checked_at FROM companies WHERE status = \'ok\' AND checked_at > ?1').bind(since).all()).results || [];
  let maxAt = since; const parts = [];
  for (const r of rows) {
    if (!r.jobs_json) continue;
    if (r.checked_at > maxAt) maxAt = r.checked_at;
    parts.push('{"a":' + JSON.stringify(r.ats) + ',"s":' + JSON.stringify(r.slug) + ',"n":' + JSON.stringify(r.name || '') + ',"j":' + r.jobs_json + '}');
  }
  return new Response('{"at":' + maxAt + ',"companies":[' + parts.join(',') + ']}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function discover(env, request) {
  if (!env.DB) return err(503, 'Job database not connected yet');
  let body; try { body = await request.json(); } catch (e) { return err(400, 'Invalid JSON'); }
  const valid = Object.values(ATS);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 40)
    .filter((x) => x && valid.includes(x.ats) && SLUG_RE.test(String(x.slug || '')));
  if (!items.length) return json({ added: 0 });
  await ensureSchema(env);
  const res = await env.DB.batch(items.map((x) => env.DB.prepare('INSERT OR IGNORE INTO companies (ats, slug, name, status, next_check, source) VALUES (?1, ?2, ?3, \'new\', 0, \'discovered\')')
    .bind(x.ats, String(x.slug).toLowerCase(), x.name ? String(x.name).slice(0, 80) : null)));
  return json({ added: res.reduce((n, r) => n + ((r.meta && r.meta.changes) || 0), 0) });
}

async function stats(env) {
  if (!env.DB) return null;
  await ensureSchema(env);
  const r = await env.DB.prepare('SELECT status, COUNT(*) AS n, SUM(n_jobs) AS jobs FROM companies GROUP BY status').all();
  const o = {}; for (const x of r.results || []) o[x.status] = { companies: x.n, jobs: x.jobs || 0 };
  return o;
}


// ============================================================================ ACCESS (single owner)
// One secret access code, stored only as the Worker secret ACCESS_CODE (format RH-XXXXX-XXXXX).
// Signing in returns a device token. Up to MAX_DEVICES devices stay signed in (a device signing in again
// replaces only its own old token), and changing ACCESS_CODE signs every device out.
const failedTries = new Map(); // ip -> {n, until}
const MAX_DEVICES = 5;

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomToken() { return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^RH/, ''); }
/** Constant-time comparison of two equal-length hex digests. */
function sameHex(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length || !a.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const metaReady = new WeakSet();
async function ensureMeta(env) {
  if (metaReady.has(env.DB)) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)').run();
  metaReady.add(env.DB);
}

function tooMany(ip) { const f = failedTries.get(ip); return f && f.n >= 8 && f.until > Date.now(); }
function noteFail(ip) {
  const f = failedTries.get(ip) || { n: 0, until: 0 };
  f.n = f.until > Date.now() ? f.n + 1 : 1; f.until = Date.now() + 15 * 60000; failedTries.set(ip, f);
  if (failedTries.size > 5000) failedTries.clear();
}

async function deviceTokens(env) {
  const m = await env.DB.prepare('SELECT v FROM meta WHERE k = ?1').bind('owner_tokens').first();
  let list = null; try { list = JSON.parse(m && m.v); } catch (e) { }
  return Array.isArray(list) ? list.filter((x) => x && x.t && x.c) : [];
}

async function codeHash(env) {
  const want = normCode(env.ACCESS_CODE);
  return want.length >= 10 ? sha256('code:' + want) : '';
}

/** POST /v1/activate {code, model} → {token} */
async function activate(env, request) {
  if (!env.DB) return err(503, 'Server not ready (database missing)');
  const want = await codeHash(env);
  if (!want) return err(503, 'Server not set up yet: add the ACCESS_CODE secret.', 'no_code');
  const ip = request.headers.get('CF-Connecting-IP') || 'x';
  if (tooMany(ip)) return err(429, 'Too many wrong codes. Try again in 15 minutes.', 'locked');
  let body; try { body = await request.json(); } catch (e) { return err(400, 'Invalid JSON'); }
  const key = normCode(body.code);
  if (key.length !== 10) { noteFail(ip); return err(400, 'Enter the full access code (like RH-ABCDE-FGHJK).', 'bad_code'); }
  if (!sameHex(await sha256('code:' + key), want)) { noteFail(ip); return err(403, 'This access code is not valid.', 'bad_code'); }
  await ensureMeta(env);
  const token = randomToken();
  const dev = await sha256('device:' + String(body.device || body.model || '').slice(0, 64));
  const rec = { t: await sha256(token), c: want, d: dev, model: String(body.model || '').slice(0, 60), at: Date.now() };
  // newest first; drop this device's old token, tokens from an older ACCESS_CODE, and anything past MAX_DEVICES
  const list = [rec].concat((await deviceTokens(env)).filter((x) => x.d !== dev && x.c === want)).slice(0, MAX_DEVICES);
  await env.DB.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?1, ?2)').bind('owner_tokens', JSON.stringify(list)).run();
  return json({ ok: true, token, name: '' });
}

/** Returns {code, label} for the owner's valid device token, or a Response explaining why not. */
async function checkToken(env, request) {
  if (!env.DB) return err(503, 'Server not ready (database missing)');
  const tok = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!/^[0-9a-f]{48}$/.test(tok)) return err(401, 'This app needs an access code.', 'no_access');
  await ensureMeta(env);
  const want = await codeHash(env), h = await sha256(tok);
  const ok = want && (await deviceTokens(env)).some((x) => sameHex(x.c, want) && sameHex(x.t, h));
  if (!ok) return err(401, 'Access expired on this phone. Enter your access code again.', 'no_access');
  return { code: 'owner', label: '' };
}

export const _test = { parseBoard, crawl, feed, discover, SEED, activate, checkToken, cooldown };

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(crawl(env)); },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST' } });
    // public health check: says nothing about your keys, jobs or setup
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/v1/activate' && request.method === 'POST') return activate(env, request);
    const who = await checkToken(env, request);
    if (who instanceof Response) return who;
    // signed-in status: which AI providers are configured and how the crawler is doing
    if (url.pathname === '/v1/status') {
      let st = null; try { st = await stats(env); } catch (e) { st = { error: String(e.message) }; }
      return json({ ok: true, workersAI: !!env.AI, database: !!env.DB, providers: OPENAI_COMPAT.filter((p) => keysOf(env, p.secret).length).map((p) => p.id).concat(env.AI ? ['workers-ai'] : []), employers: st });
    }
    // Cloudflare's schedule can't be relied on, so app activity also moves the crawler along
    if (url.pathname === '/v1/crawl' && request.method === 'POST') return json(await crawl(env).catch((e) => ({ ran: false, error: String(e && e.message) })));
    if (url.pathname === '/v1/me') { if (ctx && ctx.waitUntil) ctx.waitUntil(crawl(env).catch(() => { })); return json({ ok: true, name: who.label || '', code: who.code }); }
    if (url.pathname === '/v1/jobs' && request.method === 'GET') return feed(env, url);
    if (url.pathname === '/v1/discover' && request.method === 'POST') return discover(env, request);
    if (url.pathname === '/v1/models') return json({ data: [{ id: 'auto', object: 'model' }] });
    if (url.pathname !== '/v1/chat/completions' || request.method !== 'POST') return err(404, 'Not found');
    request.rhUser = who.code;
    return chatCompletions(request, env);
  }
};
