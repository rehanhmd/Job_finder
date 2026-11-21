// Unit tests: run with  node --test tests/unit.test.js   (needs jsdom in ~/.local/rh-tools or JSDOM_PATH)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_PATH || require('path').join(require('os').homedir(), '.local/rh-tools/node_modules/jsdom'));
const F = require('./fixtures');

const ROOT = path.join(__dirname, '..', 'assets');
const SRC = ['core.js', 'ai.js', 'cv.js', 'jobs.js', 'sites.js', 'voice.js', 'fillplan.js', 'mail.js'].map((f) => fs.readFileSync(path.join(ROOT, 'www/js', f), 'utf8').replace(/var BUILTIN_URL = '[^']*'/, "var BUILTIN_URL = 'https://relay.test/v1'"));
const AGENT = fs.readFileSync(path.join(ROOT, 'inject/autofill.js'), 'utf8');

function appWindow() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://appassets.androidplatform.net/www/index.html' });
  SRC.forEach((s) => dom.window.eval(s));
  return dom.window;
}
function pageWindow(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://boards.greenhouse.io/acme/jobs/1' });
  dom.window.__RH = dom.window.eval(AGENT); // test-only handle; the app keeps the agent private
  return dom.window;
}

// ---------------------------------------------------------------- AI helpers
test('parseJson handles fences, think tags, trailing commas, truncation', () => {
  const w = appWindow(), P0 = w.RH.ai.parseJson, P = (x) => JSON.parse(JSON.stringify(P0(x)));
  assert.deepEqual(P('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(P('<think>hmm {"x":2}</think>Sure! {"a":[1,2,],}'), { a: [1, 2] });
  assert.deepEqual(P('Here you go: [{"i":0,"score":80}] thanks'), [{ i: 0, score: 80 }]);
  assert.deepEqual(P('{"results":[{"i":0,"reason":"good fit"},{"i":1,"reason":"trunc'), { results: [{ i: 0, reason: 'good fit' }, { i: 1, reason: 'trunc' }] });
  assert.deepEqual(P('{"s":"a } inside { string"}'), { s: 'a } inside { string' });
});

test('AI chat falls back across providers and recovers from retired model', async () => {
  const w = appWindow(), RH = w.RH;
  RH.ai.saveSettings({ order: ['gemini', 'groq'], providers: { gemini: { key: 'g', enabled: true, model: 'gemini-old' }, groq: { key: 'q', enabled: true, model: 'openai/gpt-oss-120b' } } });
  const calls = [];
  const B = (o) => (typeof o.body === 'string' ? JSON.parse(o.body) : o.body);
  RH.http = async (o) => {
    calls.push(o.url + ' ' + (o.body && B(o).model));
    if (o.url.includes('generativelanguage') && o.url.endsWith('/models')) return { status: 200, body: JSON.stringify({ data: [{ id: 'models/gemini-embedding-001' }, { id: 'models/gemini-3-flash' }, { id: 'models/gemini-flash-latest' }] }) };
    if (o.url.includes('generativelanguage')) {
      const m = B(o).model;
      if (m === 'gemini-old') return { status: 404, body: JSON.stringify({ error: { message: 'models/gemini-old is not found' } }) };
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'from ' + m } }] }) };
    }
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'groq' } }] }) };
  };
  RH.httpJson = async (o) => JSON.parse((await RH.http(o)).body);
  const r = await RH.ai.chat('hi');
  assert.equal(r, 'from gemini-flash-latest');
  assert.equal(RH.ai.settings().providers.gemini.model, 'gemini-flash-latest');
  // now rate-limit gemini -> groq
  RH.http = async (o) => o.url.includes('generativelanguage')
    ? { status: 429, body: JSON.stringify({ error: { message: 'Quota exceeded. Please retry in 33.2s' } }) }
    : { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'groq says hi' } }] }) };
  assert.equal(await RH.ai.chat('hi'), 'groq says hi');
  assert.ok(RH.ai._cooldown.gemini > Date.now() + 30000, 'gemini cooled down');
  // next call skips gemini entirely
  let hitGemini = false;
  RH.http = async (o) => { if (o.url.includes('generativelanguage')) hitGemini = true; return { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }; };
  await RH.ai.chat('hi');
  assert.equal(hitGemini, false);
});

test('AI chat with no provider gives a clear error', async () => {
  const w = appWindow();
  w.RH.ai.saveSettings({ providers: { builtin: { enabled: false } } });
  await assert.rejects(w.RH.ai.chat('x'), /No AI provider configured/);
});

// ---------------------------------------------------------------- CV
test('quickParse extracts contacts and skills offline', () => {
  const w = appWindow();
  const p = w.RH.cv.quickParse(F.cvText);
  assert.equal(p.fullName, 'Priya Sharma');
  assert.equal(p.email, 'priya.sharma@example.com');
  assert.match(p.phone, /^\+91 98765 43210$/);
  assert.equal(p.linkedin, 'https://linkedin.com/in/priyasharma');
  assert.equal(p.github, 'https://github.com/priyas');
  for (const s of ['react', 'typescript', 'graphql', 'aws', 'docker']) assert.ok(p.skills.includes(s), s);
  assert.ok(!p.skills.includes('java'), 'java should not match javascript');
  assert.equal(p.yearsExperience, 7);
});

test('normalizeProfile tolerates sloppy AI output', () => {
  const w = appWindow();
  const p = w.RH.cv.normalizeProfile({ fullName: 'A B C', skills: 'React, Vue; Go', languages: ['English'], experience: [{ role: 'Dev', employer: 'X', description: 'did stuff' }], yearsExperience: '5 years' }, {});
  assert.equal(p.firstName, 'A'); assert.equal(p.lastName, 'B C');
  assert.deepEqual([...p.skills], ['React', 'Vue', 'Go']);
  assert.equal(p.languages[0].language, 'English');
  assert.equal(p.experience[0].title, 'Dev'); assert.equal(p.experience[0].company, 'X');
  assert.equal(p.yearsExperience, 5);
  assert.equal(p.currentTitle, 'Dev');
});

test('RTF stripping', () => {
  const w = appWindow();
  assert.match(w.RH.cv._rtf('{\\rtf1\\ansi\\f0 Hello\\par World}'), /^Hello\s*\nWorld$/);
});

// ---------------------------------------------------------------- jobs
test('normalizers produce consistent jobs', () => {
  const w = appWindow(), N = w.RH.jobs.normalize;
  const a = N.remotive(F.remotive); assert.equal(a.length, 3); assert.equal(a[0].company, 'Acme Cloud'); assert.deepEqual([...a[0].locations], ['Worldwide']);
  assert.ok(Math.abs(a[0].postedAt - (Date.now() - 86400000)) < 5000, 'remotive date parsed as UTC');
  const b = N.jobicy(F.jobicy); assert.equal(b[0].salary, '$70k–95k'); assert.deepEqual([...b[0].locations], ['APAC']);
  const c = N.himalayas(F.himalayas); assert.deepEqual([...c[0].locations], ['United States', 'Canada']); assert.ok(c[0].postedAt > 0);
  const d = N.remoteok(F.remoteok); assert.equal(d.length, 2, 'legal notice skipped'); assert.equal(d[0].salary, '$60k–80k');
  const e = N.wwr(F.wwr); assert.equal(e.length, 2); assert.equal(e[0].company, 'Globex'); assert.equal(e[0].title, 'Senior Frontend Developer (React)'); assert.deepEqual([...e[0].locations], ['Anywhere in the World']);
  const f = N.arbeitnow(F.arbeitnow); assert.equal(f.length, 1, 'only remote:true');
});

test('eligibility understands regions', () => {
  const w = appWindow(), J = w.RH.jobs;
  const mk = (locs) => ({ locations: locs });
  assert.equal(J.eligibility(mk([]), 'India'), 'worldwide');
  assert.equal(J.eligibility(mk(['Anywhere in the World']), 'India'), 'worldwide');
  assert.equal(J.eligibility(mk(['APAC']), 'India'), 'eligible');
  assert.equal(J.eligibility(mk(['USA']), 'India'), 'restricted');
  assert.equal(J.eligibility(mk(['United States', 'Canada']), 'United States'), 'eligible');
  assert.equal(J.eligibility(mk(['USA Only']), 'USA'), 'eligible');
});

test('search pipeline: fetch, filter, dedupe, age-limit, rank by keywords', async () => {
  const w = appWindow(), RH = w.RH;
  const routes = {
    'remotive.com': F.remotive, 'jobicy.com': F.jobicy, 'himalayas.app': F.himalayas, 'remoteok.com': F.remoteok, 'arbeitnow.com': F.arbeitnow
  };
  RH.http = async (o) => {
    if (o.url.includes('weworkremotely')) return { status: 200, body: F.wwr };
    const k = Object.keys(routes).find((h) => o.url.includes(h));
    return { status: 200, body: JSON.stringify(routes[k]) };
  };
  RH.httpJson = async (o) => JSON.parse((await RH.http(o)).body);
  RH.ai.saveSettings({ providers: { builtin: { enabled: false } } });
  const prefs = RH.jobs.defaultPrefs(); prefs.directOnly = false; prefs.sources.arbeitnow = true; prefs.sources.employers = false; prefs.sources.hn = false;
  const res = await RH.jobs.search({ queries: ['react developer'], profile: F.aiProfile, prefs, skipCrawl: true });
  const titles = res.jobs.map((j) => j.title + ' @ ' + j.company);
  assert.ok(!titles.some((t) => /Hybrid/.test(t)), 'hybrid removed');
  assert.ok(!titles.some((t) => /OldCo/.test(t)), '60-day-old job removed');
  assert.ok(!titles.some((t) => /Account Manager|Support Rep|Designer/.test(t)), 'irrelevant feed items filtered');
  assert.equal(titles.filter((t) => /Senior React Developer @ Acme/.test(t)).length, 1, 'duplicate merged');
  const acme = res.jobs.find((j) => j.company === 'Acme Cloud');
  assert.deepEqual([...acme.alsoOn], ['Remotive'].filter((s) => s !== acme.source).concat(acme.source === 'Remotive' ? ['Jobicy'] : []));
  assert.equal(res.rankedBy, 'keywords');
  assert.ok(res.jobs[0].score >= res.jobs[res.jobs.length - 1].score);
  assert.ok(res.jobs.length >= 5, 'got ' + res.jobs.length + ': ' + titles.join(' | '));
  assert.equal(res.errors.length, 0);
  // all sources report counts
  for (const k of ['remotive', 'jobicy', 'himalayas', 'remoteok', 'wwr', 'arbeitnow']) assert.equal(res.stats[k].status, 'ok', k);
});

test('search survives a failing source and AI ranking merges scores', async () => {
  const w = appWindow(), RH = w.RH;
  RH.ai.saveSettings({ order: ['groq'], providers: { groq: { key: 'k', enabled: true } } });
  RH.http = async (o) => {
    if (o.url.includes('remoteok')) return { status: 0, error: 'SocketTimeoutException' };
    if (o.url.includes('chat/completions')) {
      const body = typeof o.body === 'string' ? JSON.parse(o.body) : o.body; const jobs = JSON.parse(body.messages[1].content.split('Jobs:\n')[1].split('\n\nFor each job')[0]);
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: jobs.map((j) => ({ i: j.i, score: /React/.test(j.title) ? 88 : 40, reason: 'fits', remote: /United States/.test(j.locations) ? 'restricted' : 'worldwide' })) }) } }] }) };
    }
    if (o.url.includes('weworkremotely')) return { status: 200, body: F.wwr };
    const map = { 'remotive.com': F.remotive, 'jobicy.com': F.jobicy, 'himalayas.app': F.himalayas };
    const k = Object.keys(map).find((h) => o.url.includes(h));
    return { status: 200, body: JSON.stringify(map[k]) };
  };
  RH.httpJson = async (o) => { const r = await RH.http(o); if (r.status !== 200) { const e = new Error('HTTP ' + r.status + ' ' + (r.error || '')); throw e; } return JSON.parse(r.body); };
  const pf2 = RH.jobs.defaultPrefs(); pf2.directOnly = false; pf2.sources.employers = false; pf2.sources.hn = false;
  const res = await RH.jobs.search({ queries: ['react developer'], profile: F.aiProfile, prefs: pf2 });
  assert.equal(res.stats.remoteok.status, 'error');
  assert.equal(res.errors.length, 1, res.errors.join(' | '));
  assert.equal(res.rankedBy, 'ai');
  assert.ok(res.jobs.every((j) => j.aiScore != null));
  assert.equal(res.jobs[0].aiScore, 88);
});

// ---------------------------------------------------------------- page agent + planner
const GH_FORM = `<!doctype html><html><body>
<form id="application">
  <div class="field"><label for="first_name">First Name <span class="asterisk">*</span></label><input id="first_name" name="job_application[first_name]" required></div>
  <div class="field"><label for="last_name">Last Name *</label><input id="last_name" name="job_application[last_name]"></div>
  <div class="field"><label for="email">Email *</label><input id="email" type="email" name="job_application[email]"></div>
  <div class="field"><label for="phone">Phone</label><input id="phone" type="tel" name="job_application[phone]"></div>
  <div class="field"><label>Location (City) <input id="loc" name="job_application[location]" placeholder="Start typing..."></label></div>
  <div class="field"><label for="resume">Resume/CV</label><input type="file" id="resume" name="resume" style="display:none"></div>
  <div class="field"><label for="q1">LinkedIn Profile</label><input id="q1" name="job_application[answers][0][text_value]"></div>
  <div class="field"><label for="q2">Website</label><input id="q2" name="job_application[answers][1][text_value]"></div>
  <div class="field"><label for="q3">Company name of your current employer</label><input id="q3" name="cmp"></div>
  <div class="field"><label for="q4">How did you hear about this job?</label><select id="q4"><option value="">Please select</option><option value="1">LinkedIn</option><option value="2">Job board</option><option value="3">Referral</option></select></div>
  <fieldset><legend>Are you legally authorized to work in the country you reside in?</legend>
    <label><input type="radio" name="auth" value="1"> Yes</label><label><input type="radio" name="auth" value="0"> No</label></fieldset>
  <fieldset><legend>Will you now or in the future require visa sponsorship?</legend>
    <label><input type="radio" name="spons" value="1"> Yes</label><label><input type="radio" name="spons" value="0"> No</label></fieldset>
  <div class="field"><label for="why">Why do you want to work at Acme?</label><textarea id="why"></textarea></div>
  <div class="field"><label for="gender">Gender</label><select id="gender"><option></option><option>Male</option><option>Female</option><option>Decline to self-identify</option></select></div>
  <div class="field"><label for="years">How many years of professional React experience do you have?</label><input id="years" type="number"></div>
  <div><input type="checkbox" id="consent"><label for="consent">I agree to the privacy policy</label></div>
  <input type="hidden" name="token" value="x"><button type="submit">Submit</button>
</form></body></html>`;

test('page agent collects fields with correct labels', () => {
  const pw = pageWindow(GH_FORM);
  const data = pw.__RH.collect();
  const byLabel = Object.fromEntries(data.fields.map((f) => [f.label, f]));
  const labels = data.fields.map((f) => f.label);
  assert.ok(labels.includes('First Name'), labels.join(' | '));
  assert.ok(labels.includes('Last Name'));
  assert.ok(labels.includes('Resume/CV'), 'hidden file input still collected');
  assert.equal(byLabel['Resume/CV'].kind, 'file');
  assert.ok(labels.some((l) => /^Location \(City\)/.test(l)));
  const auth = data.fields.find((f) => /legally authorized/.test(f.label));
  assert.equal(auth.kind, 'radio'); assert.deepEqual([...auth.options], ['Yes', 'No']);
  assert.ok(!data.fields.some((f) => f.name === 'token'), 'hidden input skipped');
  assert.equal(byLabel['Gender'].kind, 'select');
  assert.equal(data.fields.length, 16);
});

test('planner maps profile + answers; open questions go to AI', () => {
  const w = appWindow(), pw = pageWindow(GH_FORM);
  const fields = JSON.parse(JSON.stringify(pw.__RH.collect().fields));
  const answers = Object.assign(w.RH.cv.defaultAnswers(), { workAuthorization: 'Yes', needsSponsorship: 'No', hearAbout: 'Job board' });
  const plan = w.RH.fillplan.plan(fields, F.aiProfile, answers, []);
  const v = Object.fromEntries(plan.fills.map((f) => [f.label, f.value]));
  assert.equal(v['First Name'], 'Priya');
  assert.equal(v['Last Name'], 'Sharma');
  assert.equal(v['Email'], 'priya.sharma@example.com');
  assert.equal(v['Phone'], '+91 98765 43210');
  assert.equal(v['LinkedIn Profile'], 'https://linkedin.com/in/priyasharma');
  assert.equal(v['Website'], 'https://github.com/priyas');
  assert.equal(v['Company name of your current employer'], 'Flipkart', 'company, not person name');
  assert.equal(v['How did you hear about this job?'], 'Job board');
  assert.equal(v['Are you legally authorized to work in the country you reside in?'], 'Yes');
  assert.equal(v['Will you now or in the future require visa sponsorship?'], 'No');
  assert.equal(v['Gender'], 'Decline to self-identify');
  assert.ok(plan.fills.some((f) => f.kind === 'file'), 'resume attached');
  assert.match(Object.keys(v).find((k) => /^Location/.test(k)) ? v[Object.keys(v).find((k) => /^Location/.test(k))] : '', /Bengaluru/);
  const aiLabels = plan.ai.map((f) => f.label);
  assert.ok(aiLabels.includes('Why do you want to work at Acme?'), aiLabels.join('|'));
  assert.ok(!plan.fills.some((f) => /privacy/.test(f.label)), 'consent left to user');
  // years: React-specific years -> answered from profile (7)
  assert.equal(v['How many years of professional React experience do you have?'], '7');
});

test('page agent fills values, radios, selects and checkbox', () => {
  const pw = pageWindow(GH_FORM);
  const data = pw.__RH.collect();
  const id = (lab) => data.fields.find((f) => f.label.startsWith(lab)).id;
  const events = [];
  pw.document.getElementById('email').addEventListener('input', () => events.push('input'));
  pw.document.getElementById('email').addEventListener('change', () => events.push('change'));
  const res = pw.__RH.fill(JSON.stringify([
    { id: id('First Name'), kind: 'text', value: 'Priya' },
    { id: id('Email'), kind: 'email', value: 'p@x.com' },
    { id: id('How did you hear'), kind: 'select', value: 'job board' },
    { id: id('Are you legally'), kind: 'radio', value: 'Yes' },
    { id: id('Will you now'), kind: 'radio', value: 'No' },
    { id: id('Gender'), kind: 'select', value: 'Decline to self-identify' },
    { id: id('I agree'), kind: 'checkbox', value: true },
    { id: 'missing', kind: 'text', value: 'x' }
  ]), null);
  const d = pw.document;
  assert.equal(d.getElementById('first_name').value, 'Priya');
  assert.equal(d.getElementById('email').value, 'p@x.com');
  assert.deepEqual(events, ['input', 'change']);
  assert.equal(d.getElementById('q4').value, '2');
  assert.equal(d.querySelector('input[name=auth][value="1"]').checked, true);
  assert.equal(d.querySelector('input[name=spons][value="0"]').checked, true);
  assert.equal(d.getElementById('gender').selectedIndex, 3);
  assert.equal(d.getElementById('consent').checked, true);
  assert.equal(res.filled, 7);
  assert.deepEqual([...res.failed], ['missing']);
});

test('capture + remember + reuse answers', () => {
  const w = appWindow(), pw = pageWindow(GH_FORM);
  pw.document.getElementById('why').value = 'Because I love Acme products.';
  pw.document.getElementById('email').value = 'priya.sharma@example.com';
  const cap = pw.__RH.capture();
  const r = w.RH.fillplan.remember([], JSON.parse(JSON.stringify(cap.items)), F.aiProfile);
  assert.equal(r.added, 1, 'email not stored, essay stored');
  assert.equal(r.memory[0].label, 'Why do you want to work at Acme?');
  // a fresh page with the same question is answered from memory
  const pw2 = pageWindow(GH_FORM);
  const plan = w.RH.fillplan.plan(JSON.parse(JSON.stringify(pw2.__RH.collect().fields)), F.aiProfile, {}, r.memory);
  const m = plan.fills.find((f) => f.source === 'memory');
  assert.equal(m.value, 'Because I love Acme products.');
});

test('Lever-style and div-label forms', () => {
  const html = `<form><ul>
    <li class="application-question"><div class="application-label">Full name<span class="required">✱</span></div><div class="application-field"><input type="text" name="name"></div></li>
    <li class="application-question"><div class="application-label">Current company</div><div class="application-field"><input type="text" name="org"></div></li>
    <li class="application-question"><div class="application-label">What is your notice period?</div><div class="application-field"><input type="text" name="cards[abc][field0]"></div></li>
    <li><div class="application-label">Country</div><div class="application-field"><select name="country"><option>Select…</option><option>India</option><option>United States</option></select></div></li>
    <li class="application-question"><div class="application-label">Additional information</div><div class="application-field"><textarea name="comments" placeholder="Add a cover letter or anything else you want to share."></textarea></div></li>
  </ul></form>`;
  const pw = pageWindow(html), w = appWindow();
  const fields = JSON.parse(JSON.stringify(pw.__RH.collect().fields));
  assert.deepEqual(fields.map((f) => f.label), ['Full name', 'Current company', 'What is your notice period?', 'Country', 'Additional information']);
  const plan = w.RH.fillplan.plan(fields, F.aiProfile, w.RH.cv.defaultAnswers(), []);
  const v = Object.fromEntries(plan.fills.map((f) => [f.label, f.value]));
  assert.equal(v['Full name'], 'Priya Sharma');
  assert.equal(v['Current company'], 'Flipkart');
  assert.equal(v['What is your notice period?'], '2 weeks');
  assert.equal(v['Country'], 'India');
  assert.deepEqual(JSON.parse(JSON.stringify(plan.ai.map((f) => f.label))), ['Additional information']);
});

test('aiAnswers validates options and maps back to ids', async () => {
  const w = appWindow(), RH = w.RH;
  RH.ai.saveSettings({ order: ['groq'], providers: { groq: { key: 'k', enabled: true } } });
  RH.http = async () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"answers":[{"i":0,"value":"I admire Acme."},{"i":1,"value":"Senior level"},{"i":2,"value":"Purple"}]}' } }] }) });
  const fields = [{ id: 'a', kind: 'textarea', label: 'Why Acme?' }, { id: 'b', kind: 'select', label: 'Level', options: ['Select', 'Junior', 'Senior'] }, { id: 'c', kind: 'radio', label: 'Color', options: ['Red', 'Blue'] }];
  const out = await RH.fillplan.aiAnswers(fields, F.aiProfile, {}, { title: 'Dev', company: 'Acme', description: 'x' });
  assert.deepEqual(JSON.parse(JSON.stringify(out.map((o) => [o.id, o.value]))), [['a', 'I admire Acme.'], ['b', 'Senior']]);
});

test('safeHtml strips scripts and attributes', () => {
  const w = appWindow();
  const h = w.RH.util.safeHtml('<p onclick="x()">Hi <a href="https://x.com" style="c">l</a><img src=x onerror=alert(1)><script>bad()</script><custom>t</custom></p>');
  assert.equal(h, '<p>Hi <a href="https://x.com" data-ext="1">l</a>t</p>');
});

// ---------------------------------------------------------------- v2: employers, HN, trust, discovery
const FEED = { at: Date.now(), companies: [
  { a: 'greenhouse', s: 'gitlab', n: 'GitLab', j: [{ i: '11', t: 'Senior Frontend Engineer (React)', l: 'Remote, EMEA / Remote, APAC', u: 'https://job-boards.greenhouse.io/gitlab/jobs/11', a: 'https://job-boards.greenhouse.io/embed/job_app?for=gitlab&token=11', p: Date.now() - 86400000 }] },
  { a: 'lever', s: 'acme', n: '', j: [{ i: 'L1', t: 'React Developer', l: 'Remote', u: 'https://jobs.lever.co/acme/L1', a: 'https://jobs.lever.co/acme/L1/apply', p: Date.now() - 2 * 86400000, x: 'Build React apps with TypeScript', s: '$40k–60k' }] }] };
const HN = { children: [
  { id: 901, created_at_i: Math.floor(Date.now() / 1000) - 3600, text: 'Acme Robotics | Senior React Engineer | REMOTE (US/EU) | $150k-$190k<p>We build robots. Apply: <a href="https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;acmerobotics" rel="nofollow">https://jobs.ashbyhq.com/acmerobotics</a>' },
  { id: 902, created_at_i: Math.floor(Date.now() / 1000), text: 'OnsiteCo | Backend Engineer | ONSITE NYC<p>No remote.' },
  { id: 903, created_at_i: Math.floor(Date.now() / 1000), text: 'Widgets Inc | Frontend Developer | Remote<p>Apply at https://boards.greenhouse.io/widgetsinc' }] };

test('employer feed + HN normalize; Employer copy wins dedupe; trust levels', async () => {
  const w = appWindow(), RH = w.RH;
  RH.store.set('auth', { token: 'a'.repeat(48) });
  const emp = RH.jobs.normalize.employers(FEED);
  assert.equal(emp.length, 2); assert.equal(emp[1].company, 'Acme', 'slug prettified');
  assert.equal(emp[0].applyUrl, 'https://job-boards.greenhouse.io/embed/job_app?for=gitlab&token=11');
  assert.deepEqual([...emp[0].locations], ['Remote, EMEA', 'Remote, APAC']);
  const hn = RH.jobs.normalize.hn(HN);
  assert.equal(hn.length, 2, 'onsite post skipped');
  assert.equal(hn[0].company, 'Acme Robotics'); assert.equal(hn[0].title, 'Senior React Engineer'); assert.equal(hn[0].applyUrl, 'https://jobs.ashbyhq.com/acmerobotics');
  assert.match(hn[0].salary, /\$150k-\$190k/);
  // full search with relay feed + a duplicate on Remotive
  const posted = [];
  RH.http = async (o) => {
    if (o.url === 'https://relay.test/v1/jobs') return { status: 200, body: JSON.stringify(FEED) };
    if (o.url === 'https://relay.test/v1/discover') { posted.push(...(typeof o.body === 'string' ? JSON.parse(o.body) : o.body).items); return { status: 200, body: '{"added":1}' }; }
    if (o.url.includes('author_whoishiring')) return { status: 200, body: JSON.stringify({ hits: [{ objectID: '777', title: 'Ask HN: Who is hiring? (November 2026)' }] }) };
    if (o.url.includes('/items/777')) return { status: 200, body: JSON.stringify(HN) };
    if (o.url.includes('remotive')) return { status: 200, body: JSON.stringify({ jobs: [{ id: 5, url: 'https://remotive.com/x', title: 'Senior Frontend Engineer (React)', company_name: 'GitLab', publication_date: new Date().toISOString().slice(0, 19), candidate_required_location: 'Worldwide', description: 'Apply at https://boards.greenhouse.io/gitlab' },
      { id: 6, url: 'https://remotive.com/y', title: 'React Developer - Data Entry', company_name: 'QuickCash', publication_date: new Date().toISOString().slice(0, 19), candidate_required_location: 'Worldwide', description: 'No experience required! Earn $500 per day. Pay a registration fee of $50 and contact us on Telegram.' }] }) };
    return { status: 200, body: JSON.stringify({ jobs: [] }) };
  };
  RH.httpJson = async (o) => JSON.parse((await RH.http(o)).body);
  const prefs = RH.jobs.defaultPrefs(); prefs.directOnly = false; prefs.sources = { employers: true, remotive: true, hn: true };
  const res = await RH.jobs.search({ queries: ['react'], profile: F.aiProfile, prefs });
  const titles = res.jobs.map((j) => j.title + '@' + j.company + '#' + j.source + '#' + j.trust);
  const gl = res.jobs.filter((j) => j.company === 'GitLab');
  assert.equal(gl.length, 1, titles.join(' | ')); assert.equal(gl[0].source, 'Employer'); assert.equal(gl[0].trust, 'verified'); assert.deepEqual([...gl[0].alsoOn], ['Remotive']);
  assert.ok(!titles.some((t) => /QuickCash/.test(t)), 'scam hidden'); assert.equal(res.flagged, 1);
  assert.ok(res.jobs.some((j) => j.source === 'HN Hiring' && j.trust === 'verified'), 'HN post links to the employer\'s Ashby page');
  // discovery: boards found in aggregator/HN text are reported once, employer feed itself is not
  const keys = posted.map((x) => x.ats + ':' + x.slug).sort();
  assert.deepEqual(keys, ['ashby:acmerobotics', 'greenhouse:gitlab', 'greenhouse:widgetsinc']);
  posted.length = 0; RH.jobs.clearCache();
  await RH.jobs.search({ queries: ['react'], profile: F.aiProfile, prefs });
  assert.equal(posted.length, 0, 'already-reported boards not sent again');
});

test('trust heuristics', () => {
  const w = appWindow(), T = w.RH.jobs.trust;
  const mk = (o) => Object.assign({ title: 'Developer', description: '', source: 'Remotive', url: 'https://x.com', applyUrl: 'https://x.com' }, o);
  assert.equal(T(mk({})), 'trusted');
  assert.equal(T(mk({ source: 'Employer' })), 'verified');
  assert.equal(T(mk({ source: 'HN Hiring' })), 'community');
  assert.equal(T(mk({ description: 'Message us on WhatsApp to apply' })), 'flagged');
  assert.equal(T(mk({ description: 'Send your CV to hr.jobs2026@gmail.com' })), 'caution');
  assert.equal(T(mk({ applyUrl: 'https://forms.gle/abc' })), 'caution');
  assert.equal(T(mk({ description: 'We build WhatsApp integrations for banks.' })), 'trusted', 'mentioning WhatsApp as a product is fine');
  assert.equal(T(mk({ description: 'Your starter kit fee is refundable' })), 'flagged');
});

test('findBoards extracts ATS slugs and skips non-slugs', () => {
  const w = appWindow();
  const b = w.RH.jobs.findBoards('see https://jobs.lever.co/netflix/abc and https://apply.workable.com/j/XYZ and https://acme.recruitee.com/o/dev https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=1 https://jobs.smartrecruiters.com/oneclick-ui/x');
  const k = JSON.parse(JSON.stringify(b.map((x) => x.ats + ':' + x.slug).sort()));
  assert.deepEqual(k, ['greenhouse:stripe', 'lever:netflix', 'recruitee:acme']);
});

test('lazy description load for Greenhouse decodes HTML', async () => {
  const w = appWindow(), RH = w.RH;
  RH.httpJson = async (o) => { assert.equal(o.url, 'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs/11'); return { content: '&lt;p&gt;We need &lt;b&gt;React&lt;/b&gt;. Contact us on Telegram.&lt;/p&gt;' }; };
  const j = RH.jobs.normalize.employers(FEED)[0];
  await RH.jobs.loadDescription(j);
  assert.equal(j.description, '<p>We need <b>React</b>. Contact us on Telegram.</p>');
  assert.equal(j.trust, 'flagged', 'trust re-evaluated after the full text arrives');
});

test('no access token: built-in AI and employer feed stay off', () => {
  const w = appWindow(), RH = w.RH;
  assert.equal(RH.ai.relayReady(), false);
  assert.ok(!RH.ai.active().includes('builtin'));
  RH.store.set('auth', { token: 'b'.repeat(48) });
  assert.equal(RH.ai.relayReady(), true);
  assert.ok(RH.ai.active().includes('builtin'));
  assert.equal(RH.ai.settings().providers.builtin.key, 'b'.repeat(48));
});

test('AI answers: style rules + writing samples in prompt, clean-up applied', async () => {
  const w = appWindow(), RH = w.RH;
  RH.ai.saveSettings({ order: ['groq'], providers: { groq: { key: 'k', enabled: true }, builtin: { enabled: false } } });
  let prompt = '';
  RH.http = async (o) => { prompt = (typeof o.body === 'string' ? JSON.parse(o.body) : o.body).messages.map((m) => m.content).join('\n');
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: [{ i: 0, value: 'I am thrilled to apply! I am passionate about leveraging React — it is a testament to my skills.' }] }) } }] }) }; };
  const memory = [{ label: 'Why us?', value: 'Honestly I just like building tools people use every day. At Flipkart I shipped the checkout rewrite and it was the most fun I had.', at: Date.now() }];
  const out = await RH.fillplan.aiAnswers([{ id: 'w', kind: 'textarea', label: 'Why Acme?' }], F.aiProfile, { writingSample: 'I keep things simple and I ship. Most of my best work came from small teams that move quickly.' }, { title: 'Dev', company: 'Acme', description: 'React' }, '', memory);
  assert.match(prompt, /WRITING STYLE/); assert.match(prompt, /Never use these words/); assert.match(prompt, /I keep things simple and I ship/); assert.match(prompt, /checkout rewrite/);
  assert.deepEqual(JSON.parse(JSON.stringify(RH.voice.aiTells(out[0].value))), [], out[0].value);
  assert.ok(!/—/.test(out[0].value));
});

test('multiple CVs: local score picks the best CV per job, AI can override', async () => {
  const w = appWindow(), RH = w.RH;
  RH.ai.saveSettings({ order: ['groq'], providers: { groq: { key: 'k', enabled: true }, builtin: { enabled: false } } });
  const fe = Object.assign({}, F.aiProfile), pm = Object.assign({}, F.aiProfile, { headline: 'Product Manager', targetRoles: ['Product Manager'], searchKeywords: ['product manager'], skills: ['Roadmapping', 'Jira', 'SQL', 'A/B testing'], currentTitle: 'Product Manager' });
  const cvs = [{ id: 'fe', label: 'Frontend', profile: fe }, { id: 'pm', label: 'Product', profile: pm }];
  let sawCvs = false;
  RH.http = async (o) => {
    if (o.url.includes('chat/completions')) {
      const body = typeof o.body === 'string' ? JSON.parse(o.body) : o.body, txt = body.messages[1].content;
      sawCvs = /"cvs":\[/.test(txt) && /"cv":0/.test(txt);
      const jobs = JSON.parse(txt.split('Jobs:\n')[1].split('\n\nFor each job')[0]);
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: jobs.map((j) => ({ i: j.i, cv: /Product/.test(j.title) ? 1 : 0, score: 80, reason: 'fit' })) }) } }] }) };
    }
    return { status: 200, body: JSON.stringify({ jobs: [
      { id: 1, url: 'https://remotive.com/1', title: 'Senior React Developer', company_name: 'A', publication_date: new Date().toISOString().slice(0, 19), candidate_required_location: 'Worldwide', tags: ['react'], description: 'React TypeScript' },
      { id: 2, url: 'https://remotive.com/2', title: 'Product Manager', company_name: 'B', publication_date: new Date().toISOString().slice(0, 19), candidate_required_location: 'Worldwide', tags: [], description: 'Roadmapping Jira SQL A/B testing' }] }) };
  };
  RH.httpJson = async (o) => JSON.parse((await RH.http(o)).body);
  const prefs = RH.jobs.defaultPrefs(); prefs.directOnly = false; prefs.sources = { remotive: true };
  const res = await RH.jobs.search({ queries: ['react', 'product manager'], profile: fe, cvs, prefs });
  assert.ok(sawCvs, 'prompt lists both CVs');
  const by = Object.fromEntries(res.jobs.map((j) => [j.title, j.bestCv]));
  assert.equal(by['Senior React Developer'], 'fe'); assert.equal(by['Product Manager'], 'pm');
  assert.equal(RH.jobs.defaultPrefs().aiRankCount, 24);
});

test('email: decode headers/bodies, classify, match to applications, update statuses', () => {
  const w = appWindow(), M = w.RH.mail;
  assert.equal(M.decodeWords('=?UTF-8?B?TGluZWFyIFJlY3J1aXRpbmc=?= <jobs@linear.app>'), 'Linear Recruiting <jobs@linear.app>');
  assert.equal(M.decodeWords('=?UTF-8?Q?Next_steps_=E2=80=94_interview?='), 'Next steps — interview');
  assert.equal(M.cleanBody('Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nWe=E2=80=99d love to chat. Please pick a time=\r\n on Calendly.'), 'We’d love to chat. Please pick a time on Calendly.');
  assert.match(M.cleanBody('<html><body><p>Unfortunately,&nbsp;we will not be <b>moving forward</b>.</p></body></html>'), /^Unfortunately, we will not be moving forward\.$/);
  assert.equal(M.classify('Your HackerRank assessment for Acme'), 'assessment');
  assert.equal(M.classify('Unfortunately we decided to move forward with other candidates'), 'rejected');
  assert.equal(M.classify('We would like to offer you the role'), 'offer');
  assert.equal(M.classify('Thank you for applying to GitLab'), 'received');
  assert.equal(M.classify('Your weekly newsletter'), null);
  const tracker = {
    a: { job: { id: 'a', title: 'Frontend', company: 'GitLab Inc.' }, status: 'applying' },
    b: { job: { id: 'b', title: 'Engineer', company: 'Linear' }, status: 'applied' },
    c: { job: { id: 'c', title: 'Dev', company: 'Acme' }, status: 'offer' }
  };
  const E = Object.values(tracker);
  let u = M.apply({ id: '1', from: 'Greenhouse <no-reply@greenhouse-mail.io>', subject: 'Thank you for applying to GitLab', body: 'We received your application', date: 'Wed, 18 Nov 2026 10:00:00 +0000' }, E);
  assert.equal(u.job.id, 'a'); assert.equal(tracker.a.status, 'applied', 'company suffix "Inc." ignored when matching');
  u = M.apply({ id: '2', from: 'Linear Recruiting <jobs@linear.app>', subject: 'Next steps', body: 'We would love to schedule a call. Use calendly.com/linear', date: 'Wed, 18 Nov 2026 11:00:00 +0000' }, E);
  assert.equal(tracker.b.status, 'interview');
  u = M.apply({ id: '2', from: 'Linear Recruiting <jobs@linear.app>', subject: 'Next steps', body: 'calendly', date: '' }, E);
  assert.equal(u, null, 'same email not applied twice');
  M.apply({ id: '3', from: 'hr@acme.com', subject: 'Update', body: 'Unfortunately we will not be moving forward', date: '' }, E);
  assert.equal(tracker.c.status, 'offer', 'an offer is never downgraded by a later rejection email');
  M.apply({ id: '4', from: 'Linear <jobs@linear.app>', subject: 'Thanks for applying', body: 'We have received your application', date: '' }, E);
  assert.equal(tracker.b.status, 'interview', 'no downgrade from interview to applied');
  assert.equal(M.apply({ id: '5', from: 'news@medium.com', subject: 'Interview tips', body: 'interview', date: '' }, E), null, 'unrelated sender ignored');
  assert.equal(tracker.b.mail.length, 2);
});

test('direct links only: classify links, keep employer pages, drop middlemen, look for their own hiring pages', async () => {
  const w = appWindow(), RH = w.RH, J = RH.jobs;
  // classifier
  assert.equal(J.linkKind('https://boards.greenhouse.io/acme/jobs/1'), 'direct');
  assert.equal(J.linkKind('https://acme.wd5.myworkdayjobs.com/en-US/External/job/123'), 'direct');
  assert.equal(J.linkKind('https://careers.acme.com/jobs/42'), 'direct', 'company own careers site');
  assert.equal(J.linkKind('https://remotive.com/remote-jobs/software-dev/x'), 'middleman');
  assert.equal(J.linkKind('https://www.linkedin.com/jobs/view/1'), 'middleman');
  assert.equal(J.linkKind('https://in.indeed.com/viewjob?jk=1'), 'middleman');
  assert.equal(J.linkKind('https://remoteok.com/l/123'), 'middleman');
  assert.equal(J.linkKind('https://bit.ly/abc'), 'bad');
  assert.equal(J.linkKind('mailto:jobs@acme.com'), 'bad');
  assert.equal(J.atsOf('https://jobs.lever.co/acme/1'), 'Lever');
  assert.deepEqual([...J.guessBoards('Widgets Inc.')].map((b) => b.ats + ':' + b.slug), ['greenhouse:widgets', 'lever:widgets', 'ashby:widgets']);
  assert.deepEqual([...J.guessBoards('Big Data Labs')].map((b) => b.slug), ['bigdatalabs', 'big-data-labs', 'bigdatalabs']);
  // search: Himalayas job that links to the employer's Greenhouse page is kept (with that link); board-only jobs are left out
  RH.store.set('auth', { token: 'a'.repeat(48) });
  const posted = [];
  const now = new Date().toISOString();
  RH.http = async (o) => {
    if (o.url === 'https://relay.test/v1/discover') { posted.push(...o.body.items); return { status: 200, body: '{"added":3}' }; }
    if (o.url.includes('himalayas')) return { status: 200, body: JSON.stringify({ jobs: [
      { guid: 'h1', title: 'React Engineer', companyName: 'Acme', applicationLink: 'https://job-boards.greenhouse.io/acme/jobs/9', pubDate: Date.now() / 1000, locationRestrictions: [] },
      { guid: 'h2', title: 'React Developer', companyName: 'Board Only Co', applicationLink: 'https://himalayas.app/companies/boardonly/jobs/react', pubDate: Date.now() / 1000, locationRestrictions: [] }] }) };
    if (o.url.includes('remotive')) return { status: 200, body: JSON.stringify({ jobs: [{ id: 7, url: 'https://remotive.com/z', title: 'Senior React Developer', company_name: 'Middle Corp', publication_date: now.slice(0, 19), candidate_required_location: 'Worldwide', description: 'x' }] }) };
    return { status: 200, body: JSON.stringify({ jobs: [] }) };
  };
  RH.httpJson = async (o) => JSON.parse((await RH.http(o)).body);
  const prefs = J.defaultPrefs(); prefs.sources = { himalayas: true, remotive: true };
  assert.equal(prefs.directOnly, true, 'on by default'); assert.equal(prefs.appliedMode, 'bottom');
  const res = await J.search({ queries: ['react'], profile: F.aiProfile, prefs, skipAi: true, skipCrawl: true });
  assert.deepEqual([...res.jobs].filter((j) => !j.viaBoard).map((j) => j.company), ['Acme'], 'only Acme has a direct link');
  assert.deepEqual([...res.jobs].filter((j) => j.viaBoard).map((j) => j.company).sort(), ['Board Only Co', 'Middle Corp'], 'board-only listings kept, marked viaBoard (shown on request)');
  assert.equal(res.jobs[0].applyUrl, 'https://job-boards.greenhouse.io/acme/jobs/9');
  assert.equal(res.jobs[0].atsName, 'Greenhouse'); assert.equal(res.jobs[0].trust, 'verified'); assert.equal(res.jobs[0].direct, true);
  assert.equal(res.middlemen, 2);
  assert.deepEqual(posted.filter((x) => x.slug === 'middle').map((x) => x.ats).sort(), ['ashby', 'greenhouse', 'lever'], 'crawler asked to check Middle Corp’s own hiring page');
  assert.ok(posted.some((x) => x.slug === 'boardonly'));
  // guesses are sent only once per company
  posted.length = 0; J.clearCache();
  await J.search({ queries: ['react'], profile: F.aiProfile, prefs, skipAi: true, skipCrawl: true });
  assert.equal(posted.filter((x) => x.slug === 'middle').length, 0);
  // turning the option off shows board listings again
  J.clearCache(); prefs.directOnly = false;
  const all = await J.search({ queries: ['react'], profile: F.aiProfile, prefs, skipAi: true, skipCrawl: true });
  assert.equal(all.jobs.length, 3);
});

test('crawl pings: repeat while the server reports more work, stop when done', async () => {
  const w = appWindow(), RH = w.RH;
  RH.store.set('auth', { token: 'a'.repeat(48) });
  let calls = 0;
  RH.util.sleep = async () => {};
  RH.httpJson = async (o) => { if (o.url.endsWith('/crawl')) { calls++; return { ran: true, due: calls < 3 ? 50 : 0 }; } return {}; };
  assert.equal(await RH.jobs.crawlPing(6), 3);
  calls = 0; RH.httpJson = async () => { calls++; return { ran: false, busy: true }; };
  assert.equal(await RH.jobs.crawlPing(6), 1, 'busy server: one try only');
});

// ---------------------------------------------------------------- autofill accuracy fixes (each was a real wrong value)
const fld = (label, kind = 'text', extra = {}) => Object.assign({ id: label, kind, label, name: '', placeholder: '', value: '' }, extra);
const planOf = (w, fields, answers = {}, memory = [], company = '') => {
  const plan = w.RH.fillplan.plan(fields, F.aiProfile, Object.assign(w.RH.cv.defaultAnswers(), answers), memory, company);
  return { v: Object.fromEntries(plan.fills.map((f) => [f.label, f.value])), ai: plan.ai.map((f) => f.label), skipped: plan.skipped.map((f) => f.label) };
};

test('fix: "excellent" is not a phone field; mobile development is not a phone; years come first', () => {
  const w = appWindow();
  const r = planOf(w, [fld('Why are you an excellent fit for this role?'), fld('How many years of mobile development experience do you have?'), fld('Mobile number'), fld('Cell phone'), fld('Mobile')]);
  assert.notEqual(r.v['Why are you an excellent fit for this role?'], F.aiProfile.phone);
  assert.ok(r.ai.includes('Why are you an excellent fit for this role?'), 'open question goes to AI');
  assert.equal(r.v['How many years of mobile development experience do you have?'], '7');
  assert.equal(r.v['Mobile number'], F.aiProfile.phone); assert.equal(r.v['Cell phone'], F.aiProfile.phone); assert.equal(r.v['Mobile'], F.aiProfile.phone);
});

test('fix: "Company name", "Name of university", "Referrer name" are not your name', () => {
  const w = appWindow();
  const r = planOf(w, [fld('Company name'), fld('Name of university'), fld('Referrer name'), fld('Name'), fld('Full name'), fld('Emergency contact name')]);
  assert.equal(r.v['Company name'], 'Flipkart');
  assert.notEqual(r.v['Name of university'], F.aiProfile.fullName); assert.ok(!r.v['Name of university'] || /institute|university|college|iit|nit|bits/i.test(r.v['Name of university']));
  assert.equal(r.v['Referrer name'], undefined); assert.equal(r.v['Emergency contact name'], undefined);
  assert.equal(r.v['Name'], 'Priya Sharma'); assert.equal(r.v['Full name'], 'Priya Sharma');
});

test('fix: "Country/Region" gets the country, not the state', () => {
  const w = appWindow();
  const r = planOf(w, [fld('Country/Region'), fld('Country of current residence'), fld('State/Province')]);
  assert.equal(r.v['Country/Region'], F.aiProfile.country);
  assert.equal(r.v['Country of current residence'], F.aiProfile.country);
  if (F.aiProfile.state) assert.equal(r.v['State/Province'], F.aiProfile.state);
});

test('fix: saved answers do not leak to another company', () => {
  const w = appWindow();
  const mem = w.RH.fillplan.remember([], [
    { label: 'Why do you want to work at Acme?', value: 'Acme builds the tools I use every day.', kind: 'textarea' },
    { label: 'Why do you want to work here?', value: 'I love what Acme is doing for developers.', kind: 'textarea' },
    { label: 'Notice period', value: '30 days', kind: 'text' }], F.aiProfile, 'Acme').memory;
  assert.equal(mem[0].company, 'Acme');
  const globex = planOf(w, [fld('Why do you want to work at Globex?', 'textarea'), fld('Why do you want to work here?', 'textarea'), fld('Notice Period:')], {}, mem, 'Globex');
  assert.equal(globex.v['Why do you want to work at Globex?'], undefined, 'different company in the question');
  assert.equal(globex.v['Why do you want to work here?'], undefined, 'answer names Acme: not reused for Globex');
  assert.equal(globex.v['Notice Period:'], '30 days', 'short generic answers are still reused');
  const acme = planOf(w, [fld('Why do you want to work here?', 'textarea')], {}, mem, 'Acme');
  assert.equal(acme.v['Why do you want to work here?'], 'I love what Acme is doing for developers.', 'same company: reused');
});

test('fix: option matching uses whole words ("No" is not "Not applicable" or "...now")', () => {
  const w = appWindow(), P = w.RH.fillplan.pickOption, pw = pageWindow('<form></form>');
  for (const pick of [P, (opts, want) => pw.__RH.bestOption(opts, want)]) { // planner and page agent agree
    assert.equal(pick(['Yes, I will need sponsorship now', 'No'], 'No'), 1);
    assert.equal(pick(['Not applicable', 'Yes'], 'No'), -1);
    assert.equal(pick(['No, I do not', 'Yes, I do'], 'No'), 0);
    assert.equal(pick(['Yes', 'No'], 'yes'), 0);
  }
});

test('fix: sponsorship / visa / work permit are never guessed', () => {
  const w = appWindow();
  const qs = [fld('Will you now or in the future require visa sponsorship?', 'radio', { options: ['Yes', 'No'] }), fld('Do you currently hold a valid visa?', 'radio', { options: ['Yes', 'No'] }),
    fld('Are you legally authorized to work in the United States?', 'radio', { options: ['Yes', 'No'] })];
  const unset = planOf(w, qs);
  assert.equal(w.RH.cv.defaultAnswers().needsSponsorship, '', 'no default legal answer');
  qs.forEach((q) => { assert.equal(unset.v[q.label], undefined, q.label); assert.ok(!unset.ai.includes(q.label), 'not sent to AI: ' + q.label); });
  const set = planOf(w, qs, { needsSponsorship: 'Yes', workAuthorization: 'No' });
  assert.equal(set.v['Will you now or in the future require visa sponsorship?'], 'Yes');
  assert.equal(set.v['Are you legally authorized to work in the United States?'], 'No');
  assert.equal(set.v['Do you currently hold a valid visa?'], undefined, 'a visa question is not the sponsorship question');
});

test('fix: page agent never overwrites what you typed while AI was writing', () => {
  const pw = pageWindow('<form><label for="a">Cover note</label><textarea id="a"></textarea><label for="b">Website</label><input id="b"><label for="s">Notice</label><select id="s"><option>Select…</option><option>2 weeks</option><option>1 month</option></select></form>');
  const f = pw.__RH.collect().fields, id = (l) => f.find((x) => x.label.startsWith(l)).id;
  pw.document.getElementById('a').value = 'My own words';          // typed after the scan
  pw.document.getElementById('s').selectedIndex = 2;                // chosen after the scan
  const res = pw.__RH.fill(JSON.stringify([{ id: id('Cover'), kind: 'textarea', value: 'AI text', ai: true }, { id: id('Website'), kind: 'text', value: 'https://x.dev' }, { id: id('Notice'), kind: 'select', value: '2 weeks' }]), null);
  assert.equal(pw.document.getElementById('a').value, 'My own words');
  assert.equal(pw.document.getElementById('s').selectedIndex, 2);
  assert.equal(pw.document.getElementById('b').value, 'https://x.dev', 'empty field still filled');
  assert.equal(res.kept, 2);
  const again = pw.__RH.fill(JSON.stringify([{ id: id('Website'), kind: 'text', value: 'https://y.dev' }]), null);
  assert.equal(pw.document.getElementById('b').value, 'https://y.dev', 'a field we filled can be filled again');
  assert.equal(again.kept, 0);
  assert.equal(pw.__RH.fill(JSON.stringify([{ id: id('Notice'), kind: 'select', value: 'No' }]), null).kept, 1);
});

test('fix: "we never charge a fee" is not a scam; real fee requests still are', () => {
  const w = appWindow(), T = w.RH.jobs.trust;
  const mk = (d) => ({ title: 'AI Trainer', description: d, source: 'Remotive', url: 'https://x.com', applyUrl: 'https://x.com' });
  assert.equal(T(mk('We will never ask you to pay an application fee.')), 'trusted');
  assert.equal(T(mk('There is no application fee. We cover equipment costs for every hire.')), 'trusted');
  assert.equal(T(mk('Training is free of charge.')), 'trusted');
  assert.equal(T(mk('A registration fee of $50 is required before onboarding.')), 'flagged');
  assert.equal(T(mk('No need to worry, just pay the registration fee and start.')), 'flagged');
  assert.equal(T(mk('Buy the laptop from our vendor and we reimburse the equipment cost.')), 'flagged');
});

test('fix: "Remote - US only" is not worldwide', () => {
  const w = appWindow(), J = w.RH.jobs, mk = (locs) => ({ locations: locs });
  assert.equal(J.eligibility(mk(['Remote - US only']), 'India'), 'restricted');
  assert.equal(J.eligibility(mk(['Remote (Canada)']), 'India'), 'restricted');
  assert.equal(J.eligibility(mk(['Remote']), 'India'), 'worldwide');
  assert.equal(J.eligibility(mk(['Fully Remote']), 'India'), 'worldwide');
  assert.equal(J.eligibility(mk(['Remote (Global)']), 'India'), 'worldwide');
  assert.equal(J.eligibility(mk(['Remote, India']), 'India'), 'eligible');
});

test('fix: writing clean-up keeps names ("Pivotal Labs", "Foster + Partners")', () => {
  const w = appWindow(), H = w.RH.voice.humanize;
  const out = H('I spent three years at Pivotal Labs and two at Foster + Partners. It was a pivotal time and I worked to foster trust.');
  assert.match(out, /Pivotal Labs/); assert.match(out, /Foster \+ Partners/);
  assert.match(out, /a key time/); assert.match(out, /to build trust/);
  assert.match(H('Pivotal Labs taught me pairing.'), /^Pivotal Labs/);
});

// ---------------------------------------------------------------- My sites (followed job pages)
test('sites: recognise hiring-system boards in links and pages', () => {
  const A = appWindow().RH.sites._atsFrom, P = (x) => JSON.parse(JSON.stringify(A(x)));
  assert.deepEqual(P('https://boards.greenhouse.io/scaleai'), { ats: 'greenhouse', slug: 'scaleai' });
  assert.deepEqual(P('job-boards.greenhouse.io/invisibletech/jobs/123'), { ats: 'greenhouse', slug: 'invisibletech' });
  assert.deepEqual(P('<script src="https://boards.greenhouse.io/embed/job_board/js?for=labelbox"></script>'), { ats: 'greenhouse', slug: 'labelbox' });
  assert.deepEqual(P('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=5'), { ats: 'greenhouse', slug: 'acme' });
  assert.deepEqual(P('https://jobs.lever.co/palantir'), { ats: 'lever', slug: 'palantir' });
  assert.deepEqual(P('https://jobs.ashbyhq.com/mercor/abc-123'), { ats: 'ashby', slug: 'mercor' });
  assert.deepEqual(P('https://apply.workable.com/huggingface/'), { ats: 'workable', slug: 'huggingface' });
  assert.deepEqual(P('https://jobs.smartrecruiters.com/Visa'), { ats: 'smartrecruiters', slug: 'Visa' });
  assert.deepEqual(P('https://helloprint.recruitee.com/o/dev'), { ats: 'recruitee', slug: 'helloprint' });
  assert.equal(A('https://example.com/careers'), null);
});

test('sites: board answers keep every job with a remote flag', () => {
  const PB = appWindow().RH.sites._parseBoard, P = (a, s, d) => JSON.parse(JSON.stringify(PB(a, s, d)));
  const gh = P('greenhouse', 'acme', { jobs: [{ id: 1, title: 'AI Trainer', location: { name: 'Remote, India' }, absolute_url: 'https://x/1', company_name: 'Acme' }, { id: 2, title: 'Office Manager', location: { name: 'New York' }, absolute_url: 'https://x/2' }] });
  assert.equal(gh.name, 'Acme'); assert.deepEqual(gh.jobs.map((j) => [j.t, j.r]), [['AI Trainer', true], ['Office Manager', false]]);
  assert.match(gh.jobs[0].a, /embed\/job_app\?for=acme&token=1/);
  const lv = P('lever', 'acme', [{ id: 'L1', text: 'Evaluator', workplaceType: 'remote', categories: { location: 'Anywhere' }, hostedUrl: 'https://jobs.lever.co/acme/L1' }, { id: 'L2', text: 'Chef', workplaceType: 'onsite', categories: { location: 'Remote' }, hostedUrl: 'https://jobs.lever.co/acme/L2' }]);
  assert.deepEqual(lv.jobs.map((j) => j.r), [true, false]); assert.equal(lv.jobs[0].a, 'https://jobs.lever.co/acme/L1/apply');
  const ab = P('ashby', 'acme', { jobs: [{ id: 'A1', title: 'Prompt Engineer', isRemote: true, jobUrl: 'https://jobs.ashbyhq.com/acme/A1' }, { id: 'A2', title: 'Hidden', isListed: false, jobUrl: 'u' }, { id: 'A3', title: 'Lab Tech', workplaceType: 'OnSite', location: 'SF', jobUrl: 'u3' }] });
  assert.deepEqual(ab.jobs.map((j) => [j.t, j.r]), [['Prompt Engineer', true], ['Lab Tech', false]]);
});

test('sites: plain pages yield job-looking links, not menus or blog posts', () => {
  const w = appWindow(), PJ = (h) => JSON.parse(JSON.stringify(w.RH.sites._pageJobs(h, 'https://acme.ai/careers')));
  const r = PJ('<title>Careers | Acme AI</title><header><a href="/jobs/designer">Senior Designer</a></header><nav><a href="/about">About</a></nav>' +
    '<main><a href="/careers/jobs/ai-trainer-physics">AI Trainer – Physics</a><a href="https://acme.ai/positions/ml-eval">Machine Learning Evaluator</a>' +
    '<a href="/blog/how-our-experts-work">How our expert reviewers work</a><a href="/careers">Careers</a><a href="/meet-our-experts">Our Experts</a><a href="/careers/open-roles">View all open roles</a></main><footer><a href="/jobs/x">Writer Jobs</a></footer>');
  assert.deepEqual(r.jobs.map((j) => j.t), ['AI Trainer – Physics', 'Machine Learning Evaluator']);
  assert.equal(r.jobs[0].u, 'https://acme.ai/careers/jobs/ai-trainer-physics');
  const C = w.RH.sites._cleanName;
  assert.equal(C('Careers \\ Labelbox'), 'Labelbox'); assert.equal(C('Careers at Scale AI'), 'Scale AI');
  assert.equal(C('Train the Next Generation of AI as an Expert| Outlier AI'), 'Outlier AI'); assert.equal(C('Careers', 'Openai'), 'Openai');
});

test('sites: follow a site, later jobs are NEW, viewing clears them, per account', async () => {
  const w = appWindow(), RH = w.RH, SI = RH.sites;
  let jobs = [{ id: 1, title: 'AI Trainer', location: { name: 'Remote' }, absolute_url: 'https://g/1', company_name: 'Acme AI', first_published: new Date(Date.now() - 86400e3).toISOString() },
    { id: 2, title: 'Office Manager', location: { name: 'Berlin' }, absolute_url: 'https://g/2' }];
  const pages = {
    'https://acme.ai/careers': '<title>Careers | Acme AI</title><a href="/careers/open-roles">View open roles</a>',
    'https://acme.ai/careers/open-roles': '<div id="grnhse_app"></div><script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeai"></script>'
  };
  const discovered = [];
  RH.http = async (o) => {
    if (o.url === 'https://boards-api.greenhouse.io/v1/boards/acmeai/jobs') return { status: 200, body: JSON.stringify({ jobs }) };
    if (/\/discover$/.test(o.url)) { discovered.push(o.body.items[0]); return { status: 200, body: '{}' }; }
    if (pages[o.url]) return { status: 200, body: pages[o.url], url: o.url };
    return { status: 404, body: '' };
  };
  RH.store.set('auth', { token: 'a'.repeat(48) });
  const s = await SI.add('acme.ai/careers');
  assert.equal(s.kind, 'ats'); assert.equal(s.ats, 'greenhouse'); assert.equal(s.slug, 'acmeai', 'found through the "View open roles" page');
  assert.equal(s.name, 'Acme AI'); assert.equal(SI.count(s), 1, 'remote only by default'); assert.equal(SI.total(s), 2); assert.equal(SI.newCount(), 0, 'jobs already there are not new');
  assert.deepEqual(discovered.map((d) => d.slug), ['acmeai'], 'server crawler told about the board');
  await assert.rejects(SI.add('https://boards.greenhouse.io/acmeai'), /already follow/);
  jobs = jobs.concat([{ id: 3, title: 'LLM Evaluator', location: { name: 'Remote, Worldwide' }, absolute_url: 'https://g/3' }, { id: 4, title: 'Receptionist', location: { name: 'Paris' }, absolute_url: 'https://g/4' }]);
  const r = await SI.checkAll(true);
  assert.equal(r.fresh, 2); assert.equal(SI.newCount(), 1, 'only the remote new job counts while "remote only" is on');
  const vis = SI.visible(SI.list()[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(vis.map((j) => [j.title, j.isNew]))), [['LLM Evaluator', true], ['AI Trainer', false]]);
  assert.equal(vis[0].source, 'Employer'); assert.equal(vis[0].trust, 'verified'); assert.match(vis[0].applyUrl, /for=acmeai&token=3/);
  SI.setRemoteOnly(s.id, false); assert.equal(SI.newCount(), 2); assert.ok(SI.visible(SI.list()[0]).find((j) => j.title === 'Receptionist').notRemote);
  SI.markSeen(s.id); assert.equal(SI.newCount(), 0);
  assert.equal((await SI.checkAll(false)).checked, 0, 'not re-checked within 30 minutes');
  // sites belong to the account
  RH.account.switchTo(RH.account.add('Rahul')); assert.equal(SI.list().length, 0); RH.account.switchTo('main'); assert.equal(SI.list().length, 1);
  SI.remove(s.id); assert.equal(SI.list().length, 0);
});

test('sites: a JavaScript-only careers page finds the company board by name, and only if the name matches', async () => {
  const w = appWindow(), RH = w.RH;
  RH.http = async (o) => {
    if (o.url === 'https://scale.com/careers') return { status: 200, body: '<title>Careers at Scale AI</title><div id="root"></div>', url: o.url };
    if (o.url === 'https://boards-api.greenhouse.io/v1/boards/scaleai/jobs') return { status: 200, body: JSON.stringify({ jobs: [{ id: 9, title: 'AI Trainer', location: { name: 'Remote' }, absolute_url: 'u', company_name: 'Scale AI' }] }) };
    if (o.url === 'https://boards-api.greenhouse.io/v1/boards/scale/jobs') return { status: 200, body: JSON.stringify({ jobs: [{ id: 1, title: 'Welder', location: { name: 'Ohio' }, absolute_url: 'u', company_name: 'Scale Steel Inc' }] }) };
    return { status: 404, body: '' };
  };
  const r = JSON.parse(JSON.stringify(await RH.sites._resolve('https://scale.com/careers')));
  assert.equal(r.kind, 'ats'); assert.equal(r.slug, 'scaleai', 'the other company called "scale" is not taken');
  RH.http = async (o) => o.url === 'https://jsonly.dev/jobs' ? { status: 200, body: '<title>Jobs</title><div id="app"></div>', url: o.url } : { status: 404, body: '' };
  const p = JSON.parse(JSON.stringify(await RH.sites._resolve('https://jsonly.dev/jobs')));
  assert.equal(p.kind, 'page'); assert.equal(p.n, 0);
});
