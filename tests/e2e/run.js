// End-to-end test of the real app UI in headless Chrome.
// The mock "Android" bridge reproduces MainActivity's protocol exactly; the job site runs in a separate page (like the second WebView).
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require(process.env.PUPPETEER_PATH || require('path').join(require('os').homedir(), '.local/rh-tools/node_modules/puppeteer-core'));
const F = require('../fixtures');

const ASSETS = path.join(__dirname, '../../assets');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('•', ...a);
const failures = [];
const check = (cond, msg) => { if (cond) log('PASS', msg); else { failures.push(msg); console.log('✗ FAIL', msg); } };

// ---------------------------------------------------------------- static servers
function serve(port, root) {
  return new Promise((res) => {
    http.createServer((req, rsp) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      const tryFiles = [path.join(root, p), path.join(ASSETS, p), path.join(__dirname, p)];
      const f = tryFiles.find((x) => fs.existsSync(x) && fs.statSync(x).isFile());
      if (!f) { rsp.writeHead(404); rsp.end('nf'); return; }
      const ext = path.extname(f);
      if (f.endsWith('/www/js/config.js')) { rsp.writeHead(200, { 'Content-Type': 'application/javascript' }); rsp.end("window.RH.config = { accessCode: 'RH-TEST2-CODE3' };"); return; }
      if (f.endsWith('/www/js/ai.js')) { rsp.writeHead(200, { 'Content-Type': 'application/javascript' }); rsp.end(fs.readFileSync(f, 'utf8').replace(/var BUILTIN_URL = '[^']*'/, "var BUILTIN_URL = 'https://relay.test/v1'")); return; }
      rsp.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rsp);
    }).listen(port, res);
  });
}

// ---------------------------------------------------------------- fake internet for RH.http
const aiLog = [];
const discovered = [];
const activations = [];
let rejectActivations = false;
// a company job board the user follows in "My sites"
const siteJobs = [
  { id: 501, title: 'AI Trainer – Physics', location: { name: 'Remote' }, absolute_url: 'https://job-boards.greenhouse.io/testco/jobs/501', company_name: 'Test Co', first_published: new Date(Date.now() - 86400e3).toISOString() },
  { id: 502, title: 'Office Manager', location: { name: 'Berlin' }, absolute_url: 'https://job-boards.greenhouse.io/testco/jobs/502', company_name: 'Test Co' }]; // simulate the server's ACCESS_CODE being changed
let geminiCalls = 0;
function aiReply(prompt) {
  if (/Analyze this CV/.test(prompt) && /Product manager with 4 years/.test(prompt)) return JSON.stringify(Object.assign({}, F.aiProfile, { headline: 'Product Manager', currentTitle: 'Product Manager', targetRoles: ['Product Manager'], searchKeywords: ['product manager'], skills: ['Roadmapping', 'Jira', 'SQL', 'A/B testing'], email: '', phone: '' }));
  if (/Analyze this CV/.test(prompt)) return '```json\n' + JSON.stringify(F.aiProfile, null, 1) + '\n```';
  if (/\nJobs:\n/.test(prompt)) {
    const jobs = JSON.parse(prompt.split('Jobs:\n')[1].split('\n\nFor each job')[0]);
    return JSON.stringify({ results: jobs.map((j) => ({ i: j.i, cv: /product/i.test(j.title) ? 1 : 0, score: /react/i.test(j.title) ? 70 + (j.i * 3) % 25 : 35, reason: /react/i.test(j.title) ? 'Strong React/TypeScript overlap and senior level fit.' : 'Partial skills overlap.', missing: /full stack/i.test(j.title) ? ['AWS Lambda'] : [], remote: /United States/.test(j.locations) ? 'restricted' : 'worldwide', regions: /United States/.test(j.locations) ? 'US, Canada' : '' })) });
  }
  if (/Fill in a job application/.test(prompt)) {
    const qs = JSON.parse(prompt.split('Questions: ')[1].split('\n\nReturn JSON')[0]);
    return JSON.stringify({ answers: qs.map((q) => ({ i: q.i, value: q.options ? q.options[0] : /interested|why/i.test(q.question) ? 'I have spent 7 years building React and TypeScript products at scale, most recently leading the checkout migration at Flipkart. Acme Cloud\'s focus on developer experience is exactly where I want to apply that.' : 'AI answer' })) });
  }
  if (/cover letter/i.test(prompt)) return 'Dear Hiring Team,\n\nI am excited to apply for the Senior React Developer role at Acme Cloud...\n\nBest regards,\nPriya Sharma';
  if (/single word: OK/.test(prompt)) return 'OK';
  return '{}';
}
async function fakeInternet(reqJson) {
  const req = JSON.parse(reqJson);
  const u = req.url;
  const json = (o, status = 200) => ({ status, body: typeof o === 'string' ? o : JSON.stringify(o) });
  await new Promise((r) => setTimeout(r, 30));
  if (u === 'https://boards-api.greenhouse.io/v1/boards/testco/jobs') return json({ jobs: siteJobs });
  if (u.includes('generativelanguage.googleapis.com')) {
    geminiCalls++;
    return json({ error: { code: 429, message: 'Resource exhausted. Please retry in 41s.' } }, 429);
  }
  if (u === 'https://relay.test/v1/activate') {
    const b = JSON.parse(req.body); activations.push(b);
    return !rejectActivations && b.code.replace(/[^A-Z0-9]/gi, '').toUpperCase() === 'RHTEST2CODE3' ? json({ ok: true, token: 'f'.repeat(48), name: 'Priya' }) : json({ error: { message: 'This access code is not valid.', code: 'bad_code' } }, 403);
  }
  if (u === 'https://relay.test/v1/me') return req.headers.Authorization === 'Bearer ' + 'f'.repeat(48) ? json({ ok: true }) : json({ error: { message: 'no' } }, 401);
  if (u === 'https://relay.test/v1/jobs') return json({ at: Date.now(), companies: [
    { a: 'greenhouse', s: 'gitlab', n: 'GitLab', j: [{ i: '11', t: 'Senior React Engineer', l: 'Remote, APAC / Remote, EMEA', u: 'https://job-boards.greenhouse.io/gitlab/jobs/11', a: 'https://job-boards.greenhouse.io/embed/job_app?for=gitlab&token=11', p: Date.now() - 3600e3 }] },
    { a: 'ashby', s: 'linear', n: 'Linear', j: [{ i: 'A1', t: 'Product Engineer (TypeScript/React)', l: 'Remote (Global)', u: 'https://jobs.ashbyhq.com/linear/A1', a: 'https://jobs.ashbyhq.com/linear/A1/application', p: Date.now() - 7200e3, x: 'Ship product with React and TypeScript.', s: '$150K – $200K' }] }] });
  if (u === 'https://relay.test/v1/discover') { discovered.push(...JSON.parse(req.body).items); return json({ added: 1 }); }
  if (u.includes('boards-api.greenhouse.io/v1/boards/gitlab/jobs/11')) return json({ content: '&lt;p&gt;Build our &lt;b&gt;React&lt;/b&gt; front end. Fully remote.&lt;/p&gt;' });
  if (u.includes('hn.algolia.com')) return json({ hits: [] });
  if (u.includes('api.groq.com') || u.startsWith('https://relay.test/v1/chat')) {
    if (u.endsWith('/models')) return json({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'llama-3.3-70b-versatile' }] });
    const body = JSON.parse(req.body);
    const prompt = body.messages.map((m) => m.content).join('\n');
    aiLog.push(prompt);
    return json({ choices: [{ message: { role: 'assistant', content: aiReply(prompt) }, finish_reason: 'stop' }] });
  }
  if (u.includes('remotive.com')) return json(F.remotive);
  if (u.includes('jobicy.com')) return json(F.jobicy);
  // some board listings link straight to the employer (kept), the rest only to the board (left out by default)
  if (u.includes('himalayas.app')) { const h = JSON.parse(JSON.stringify(F.himalayas)); h.jobs[0].applicationLink = 'https://careers.quicklizard.com/jobs/fullstack'; return json(h); }
  if (u.includes('remoteok.com')) { const r = JSON.parse(JSON.stringify(F.remoteok)); const k = r.findIndex((x) => x && x.position); r[k].apply_url = 'https://doit.wd3.myworkdayjobs.com/External/job/react-dev'; return json(r); }
  if (u.includes('weworkremotely.com')) return json(F.wwr);
  if (u.includes('arbeitnow.com')) return json(F.arbeitnow);
  return { status: 0, error: 'UnknownHostException' };
}

(async () => {
  log('start'); await serve(8701, path.join(ASSETS)); log('served');
  await serve(8702, __dirname); // "another origin" for the embedded ATS iframe
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'), headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server', '--no-first-run', '--disable-background-networking'] });
  log('browser up'); const app = await browser.newPage();
  await app.setViewport({ width: 412, height: 860, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true });
  const job = await browser.newPage();
  await job.setViewport({ width: 412, height: 860, isMobile: true });
  const consoleErrors = [];
  app.on('console', (m) => { if (m.type() === 'error' && !/ERR_NAME_NOT_RESOLVED/.test(m.text())) consoleErrors.push(m.text()); }); // logos can't resolve DNS in the sandbox
  app.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  const inject = fs.readFileSync(path.join(ASSETS, 'inject/autofill.js'), 'utf8');
  // same wrapper as MainActivity.agentJs(): the agent stays private to this one evaluation
  const agent = (expr) => '(function(){var __rh=' + inject + '\n;return JSON.stringify(' + expr + ');})()';
  const statuses = [];
  let loadInApplyCalled = null;

  // ---- native side (mirrors MainActivity)
  const pdfB64 = fs.readFileSync(path.join(__dirname, 'cv.pdf')).toString('base64');
  await app.exposeFunction('__nodeHttp', fakeInternet);
  const pmB64 = fs.readFileSync(path.join(__dirname, 'cv_pm.docx')).toString('base64');
  await app.exposeFunction('__nodePickCv', (slot) => slot === 'main'
    ? { meta: { name: 'Priya_Sharma_CV.pdf', mime: 'application/pdf', size: fs.statSync(path.join(__dirname, 'cv.pdf')).size, path: '/data/cv/main/Priya_Sharma_CV.pdf', savedAt: Date.now(), slot }, b64: pdfB64 }
    : { meta: { name: 'Priya_PM_CV.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 9000, path: '/data/cv/' + slot + '/Priya_PM_CV.docx', savedAt: Date.now(), slot }, b64: pmB64 });
  const mailCalls = [];
  await app.exposeFunction('__nodeMail', (cfg) => {
    const c = JSON.parse(cfg); mailCalls.push(c);
    if (c.pass !== 'abcdefghijklmnop') return { status: 0, error: 'Login failed: check the email address and app password' };
    return { status: 200, body: JSON.stringify({ messages: [
      { id: '7|x', from: '=?UTF-8?B?R2l0TGFiIFJlY3J1aXRpbmc=?= <recruiting@gitlab.com>', subject: '=?UTF-8?Q?Next_steps_=E2=80=94_GitLab_interview?=', date: 'Wed, 18 Nov 2026 12:00:00 +0000', body: 'Hi Priya, we would love to schedule an interview. Please pick a time: calendly.com/gitlab' },
      { id: '8|y', from: 'Medium <noreply@medium.com>', subject: 'Top stories', date: 'Wed, 18 Nov 2026 12:00:00 +0000', body: 'interview tips' }] }) };
  });
  await app.exposeFunction('__nodeOpenApply', async (url) => { await job.goto('http://localhost:8701/react-form.html?from=' + encodeURIComponent(url)); });
  await app.exposeFunction('__nodeLoadInApply', async (url) => { loadInApplyCalled = url; await job.goto(url); });
  await app.exposeFunction('__nodeStatus', (t) => { statuses.push(t); });
  await app.exposeFunction('__nodeFill', async (fillsJson, needsFile) => {
    let fileArg = 'null';
    if (needsFile) { const m = JSON.parse(await app.evaluate(() => window.Android.kvGet('cv.meta'))); fileArg = JSON.stringify({ name: m.name, mime: m.mime, b64: m.name.endsWith('.pdf') ? pdfB64 : pmB64 }); }
    const value = await job.evaluate(agent('__rh.fill(' + JSON.stringify(fillsJson) + ',' + fileArg + ')'));
    await app.evaluate('RH.autofill.onFilled(' + JSON.stringify(value) + ')');
  });
  await app.evaluateOnNewDocument(() => {
    const saved = JSON.parse(sessionStorage.getItem('__phone') || '{"kv":{},"files":{}}');
    const kv = saved.kv, results = {};
    const files = saved.files;
    window.addEventListener('pagehide', () => {
      const keep = {}; Object.keys(kv).forEach((k) => { if (!/^cache\./.test(k)) keep[k] = kv[k]; });
      try { sessionStorage.setItem('__phone', JSON.stringify({ kv: keep, files })); } catch (e) { }
    });
    window.Android = {
      kvGet: (k) => (k in kv ? kv[k] : null), kvSet: (k, v) => { kv[k] = v; }, kvRemove: (k) => { delete kv[k]; },
      http: (id, req) => { window.__nodeHttp(req).then((r) => { results[id] = JSON.stringify(r); window.__httpDone(id); }); },
      httpTake: (id) => { const r = results[id]; delete results[id]; return r || '{"status":0,"error":"missing"}'; },
      pickCv: () => window.Android.pickCvSlot('main'),
      pickCvSlot: (slot) => { window.__nodePickCv(slot).then((x) => { files[x.meta.path] = x.b64; kv['cv.meta'] = JSON.stringify(x.meta); window.RH.onCvPicked(x.meta); }); },
      cvBase64: () => null, cvMeta: () => kv['cv.meta'] || null, cvBase64Path: (p) => files[p] || null, deleteCvSlot: () => {},
      mailCheck: (id, cfg) => { window.__nodeMail(cfg).then((r) => { results[id] = JSON.stringify(r); window.__httpDone(id); }); },
      sendMail: (id, cfg) => { (window.__sent = window.__sent || []).push(JSON.parse(cfg)); results[id] = '{"status":200}'; setTimeout(() => window.__httpDone(id), 20); },
      scheduleSiteChecks: (on) => { window.__scheduled = on; }, notificationsAllowed: () => true, requestNotifications: () => { window.__askedNotify = true; }, launchTab: () => null, openBatterySettings: () => {},
      deviceId: () => 'a-0123456789abcdef', deviceModel: () => 'Google Pixel 8',
      openApply: (u) => { window.__nodeOpenApply(u); }, closeApply: () => {}, loadInApply: (u) => { window.__nodeLoadInApply(u); },
      applyFills: (j, nf) => { window.__nodeFill(j, nf); }, setApplyStatus: (t) => { window.__nodeStatus(t); },
      openExternal: () => {}, toast: () => {}, copy: () => {}, share: () => {}, platform: () => 'android-34'
    };
  });
  async function tapAutofill(auto = false, asUrl = null) { // = MainActivity.startAutofill(auto); asUrl = pretend the page is at this address
    const value = await job.evaluate(agent('__rh.collect()'));
    await app.evaluate('RH.autofill.onFields(' + JSON.stringify(value) + ',' + JSON.stringify(asUrl || job.url()) + ',' + JSON.stringify(await job.title()) + ',' + auto + ')');
  }
  async function tapSave() {
    const value = await job.evaluate(agent('__rh.capture()'));
    await app.evaluate('RH.autofill.onCapture(' + JSON.stringify(value) + ')');
  }
  const shot = async (name) => { await app.bringToFront(); return app.screenshot({ path: path.join(OUT, name + '.png') }); };
  const waitText = (t, ms = 15000) => app.waitForFunction((s) => document.body.innerText.includes(s), { timeout: ms, polling: 250 }, t)
    .catch(async (e) => { const seen = await app.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)).catch(() => '?'); throw new Error('waiting for "' + t + '" — screen shows: ' + seen); });
  const click = async (sel) => { await app.bringToFront(); await app.waitForSelector(sel, { timeout: 8000 }); await app.click(sel); };

  try {
    log('goto'); await app.goto('http://localhost:8701/www/index.html'); log('loaded');
    await waitText('Upload my CV');
    check(activations.length === 1 && activations[0].device === 'a-0123456789abcdef' && activations[0].model === 'Google Pixel 8', 'signs in by itself with the built-in code (no code screen), sending the phone id + model');
    check(await app.evaluate(() => !document.querySelector('#codeIn')), 'no access-code screen shown');
    check((await app.evaluate(() => RH.store.get('auth').token)).length === 48, 'token stored after automatic sign-in');
    check(await app.evaluate(() => /Me/.test(document.querySelector('#acctBtn').textContent)), 'header shows the current account ("Me")');
    await shot('01-welcome');
    check(await app.evaluate(() => RH.isNative), 'app detects native bridge');

    // ---- settings: add keys
    await click('#tabs [data-tab=settings]');
    await app.bringToFront(); await app.type('[data-prov-gemini="key"]', 'AIza-test');
    await app.type('[data-prov-groq="key"]', 'gsk_test');
    await click('[data-act=saveAi]');
    await click('[data-act=testProv][data-id=groq]');
    await app.waitForFunction(() => /Works/.test(document.querySelector('#test-groq').textContent), { timeout: 8000 });
    check(true, 'Groq key test shows ✓ Works');
    await shot('02-settings');

    // ---- upload + analyze CV
    await click('#tabs [data-tab=profile]');
    await click('[data-act=pickCv]');
    await waitText('ROLES TO TARGET', 30000);
    await shot('03-profile');
    const cvPrompt = aiLog.find((p) => /Analyze this CV/.test(p)) || '';
    check(/Flipkart/.test(cvPrompt) && /priya\.sharma@example\.com/.test(cvPrompt), 'PDF text extracted by pdf.js and sent to AI');
    check(geminiCalls >= 1, 'Gemini was tried first (429) and the app fell back to Groq');
    const prof = await app.evaluate(() => RH.state.profile);
    check(prof.fullName === 'Priya Sharma' && prof.skills.includes('React'), 'profile parsed from AI JSON (inside ```json fence)');
    check((await app.evaluate(() => document.querySelector('[data-p=email]').value)) === 'priya.sharma@example.com', 'profile form shows email');

    // edit + save the profile form
    await app.evaluate(() => { document.querySelectorAll('details.sec')[4].open = true; });
    await app.$eval('[data-ans=expectedSalary]', (el) => { el.value = '85000'; });
    await app.$eval('[data-ans=workAuthorization]', (el) => { el.value = 'Yes'; });
    await click('[data-act=saveProfile]');
    check((await app.evaluate(() => RH.state.answers.expectedSalary)) === '85000', 'answers saved from form');

    // ---- search
    await click('[data-act=goJobs]');
    await waitText('remote jobs', 30000);
    await app.waitForFunction(() => !RH.state.search.running, { timeout: 30000 });
    await shot('04-jobs');
    const res = await app.evaluate(() => RH.state.search.result);
    check(res && res.jobs.length >= 3, 'search returned ' + (res && res.jobs.length) + ' jobs');
    const direct = res.jobs.filter((j) => !j.viaBoard);
    check(await app.evaluate(() => RH.state.search.result.jobs.filter((j) => !j.viaBoard).every((j) => j.source === 'Employer' || RH.jobs.linkKind(j.applyUrl) === 'direct')), 'direct jobs all have employer links: ' + direct.map((j) => j.applyUrl).join(' '));
    check(res.middlemen > 0 && (await app.evaluate(() => document.body.innerText.includes('Showing only direct company application pages'))), 'note explains job-board listings were left out (' + res.middlemen + ')');
    const jobCards = () => app.evaluate(() => document.querySelectorAll('.job').length);
    const nDirect = await jobCards();
    check(nDirect === Math.min(direct.length, 30), 'list shows only the direct jobs by default (' + nDirect + ')');
    await click('[data-act=showBoards]');
    check((await jobCards()) > nDirect && (await app.evaluate(() => document.body.innerText.includes('Including '))), '"Show them too" adds the job-board listings');
    await click('[data-act=hideBoards]');
    check((await jobCards()) === nDirect, '"Direct pages only" hides them again');

    // ---- My sites: follow a company's job board; jobs that appear later are marked NEW
    await app.bringToFront();
    await app.type('#siteUrl', 'boards.greenhouse.io/testco');
    await click('[data-act=siteAdd]');
    await waitText('Following Test Co');
    check(await app.evaluate(() => document.querySelectorAll('.site-row').length === 1 && /1 remote · 2 total/.test(document.querySelector('.site-row').textContent)), 'site added: shows its remote jobs and the total');
    await shot('22-my-sites');
    siteJobs.push({ id: 503, title: 'LLM Evaluator', location: { name: 'Remote, Worldwide' }, absolute_url: 'https://job-boards.greenhouse.io/testco/jobs/503', first_published: new Date().toISOString() });
    await click('[data-act=sitesCheck]');
    await waitText('1 new');
    check(await app.evaluate(() => (document.querySelector('#tabs [data-tab=jobs] .dot') || {}).textContent === '1'), 'Jobs tab shows the number of new jobs');
    await click('.site-row');
    await waitText('New since you last looked');
    check(await app.evaluate(() => { const c = document.querySelector('#sheet .job'); return !!c && /LLM Evaluator/.test(c.textContent) && /NEW/.test(c.textContent); }), 'new job listed first with a NEW label');
    await new Promise((r) => setTimeout(r, 500)); await shot('23-site-jobs');
    await click('#sheet .job');
    await waitText('Apply with Autofill');
    check(await app.evaluate(() => !!RH.state.sheetJob && /LLM Evaluator/.test(RH.state.sheetJob.title) && RH.state.sheetJob.trust === 'verified'), 'job opens with Apply with Autofill (verified employer)');
    await click('[data-act=closeSheet]');
    await waitText('Stop following');
    check(true, 'Back returns to the site');
    check(await app.evaluate(() => !document.querySelector('#tabs [data-tab=jobs] .dot')), 'looking at the site clears the new-jobs badge');
    await click('[data-site-remote]');
    await waitText('Office Manager');
    check(true, 'unticking "Only remote jobs" shows on-site jobs too');
    await click('[data-act=siteRemove]');
    check(await app.evaluate(() => RH.sites.list().length === 0 && !document.querySelector('.site-row')), 'Stop following removes the site');
    check(res.jobs.some((j) => /myworkdayjobs/.test(j.applyUrl) && j.trust === 'verified'), 'board listing kept with its direct Workday link');
    check(res.rankedBy === 'ai', 'jobs ranked by AI');
    check(!res.jobs.some((j) => /Hybrid/.test(j.title)), 'hybrid job filtered');
    check(direct[0].aiScore >= direct[direct.length - 1].aiScore, 'sorted by match');
    const emp = res.jobs.filter((j) => j.source === 'Employer');
    check(emp.length === 2 && emp.every((j) => j.trust === 'verified'), 'verified employer jobs from the relay feed');
    check((await app.$$eval('.pill.g', (e) => e.map((x) => x.textContent))).includes('✓ Verified employer'), 'Verified employer badge shown');
    const cards = await app.$$eval('.job', (els) => els.length);
    check(cards === Math.min(direct.length, 30), 'all direct job cards rendered (' + cards + ')');

    // ---- detail + cover letter
    await app.bringToFront(); await app.click('.job');
    await app.waitForSelector('#sheet:not([hidden]) .desc');
    await new Promise((r) => setTimeout(r, 400));
    await shot('05-detail');
    const descHtml = await app.$eval('.desc', (e) => e.innerHTML);
    check(!/script/i.test(descHtml), 'description sanitized');
    await click('[data-act=cover]');
    await app.waitForSelector('#coverTxt', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 400));
    check(/Dear Hiring Team/.test(await app.$eval('#coverTxt', (e) => e.value)), 'cover letter generated');
    await shot('06-cover');
    await click('[data-act=closeModal]');

    // ---- apply with autofill on a React-controlled form
    await click('[data-act=apply]');
    await job.waitForSelector('#first', { timeout: 10000 });
    await tapAutofill();
    await app.waitForFunction(() => true);
    const t0 = Date.now();
    while (!statuses.some((s) => /✓ Filled/.test(s)) && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 200));
    const st = statuses.filter((s) => /✓ Filled/.test(s)).pop() || statuses.pop();
    log('status:', st);
    const state = await job.evaluate(() => window.__state);
    log('react state:', JSON.stringify(state));
    check(state.first === 'Priya' && state.last === 'Sharma', 'React controlled first/last name updated');
    check(state.email === 'priya.sharma@example.com' && state.phone === '+91 98765 43210', 'email + phone');
    check(state.country === 'India', 'select (country) chosen');
    check(state.linkedin === 'https://linkedin.com/in/priyasharma', 'LinkedIn');
    check(/^Priya_Sharma_CV\.pdf:\d+$/.test(state.file), 'CV file attached to resume input (' + state.file + ')');
    check(/Flipkart/.test(state.why), 'open question answered by AI');
    check(/245, 158, 11/.test(await job.$eval('#why', (e) => e.style.outline)), 'AI-written answer highlighted yellow for review');
    check(/34, 197, 94/.test(await job.$eval('#first', (e) => e.style.outline)), 'profile fields highlighted green');
    check(state.auth === 'Yes', 'radio group answered');
    check(state.salary === '85000', 'salary from saved answers');
    check(state.start === '2 weeks', 'start date from notice period');
    check(state.hear === 'Job board', 'how did you hear');
    check(/✓ Filled \d+ of \d+ fields/.test(st), 'status bar shows result');
    const answerPrompt = aiLog.find((p) => /Fill in a job application/.test(p)) || '';
    const applyTitle = await app.evaluate(() => RH.state.applyJob.title);
    check(answerPrompt.includes(JSON.stringify(applyTitle)) && /Questions: /.test(answerPrompt), 'AI answer prompt includes the job (' + applyTitle + ')');
    await job.bringToFront(); await job.screenshot({ path: path.join(OUT, '07-form-filled.png'), fullPage: true }); await app.bringToFront();

    // user edits one answer, taps Save -> memory
    await job.focus('#why');
    await job.evaluate(() => { const el = document.getElementById('why'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, 'My own edited answer about Acme.'); el.dispatchEvent(new Event('input', { bubbles: true })); });
    await tapSave();
    const mem = await app.evaluate(() => RH.state.memory);
    check(mem.some((m) => m.value === 'My own edited answer about Acme.'), 'edited answer remembered');
    check(!mem.some((m) => m.value === 'priya.sharma@example.com'), 'profile values not duplicated into memory');

    // second time: remembered answer is reused without AI
    const aiBefore = aiLog.length;
    await job.reload(); await job.waitForSelector('#first');
    await tapAutofill();
    await new Promise((r) => setTimeout(r, 1500));
    const state2 = await job.evaluate(() => window.__state);
    check(state2.why === 'My own edited answer about Acme.', 'remembered answer reused on refill');
    check(aiLog.length === aiBefore, 'no extra AI call needed on refill');

    // ---- close apply -> ask to mark applied
    await app.evaluate(() => RH.onApplyClosed());
    await click('[data-act=confirmApplied]');
    await click('[data-act=closeSheet]');
    await click('#tabs [data-tab=tracker]');
    await waitText('Applied');
    await shot('08-tracker');
    const tr = await app.evaluate(() => Object.values(RH.state.tracker));
    check(tr.length === 1 && tr[0].status === 'applied', 'tracker has the applied job');

    // ---- applied job moves to the bottom of the jobs list (default), or is hidden (option)
    await click('#tabs [data-tab=jobs]');
    await app.waitForSelector('.job');
    const order = await app.$$eval('.job', (els) => els.map((e) => e.getAttribute('data-id')));
    check(order[order.length - 1] === tr[0].job.id && order[0] !== tr[0].job.id, 'applied job is last in the list, next job to apply is first');
    check(await app.evaluate(() => document.body.innerText.includes('✓ Already applied') && /jobs to apply/.test(document.body.innerText)), 'applied section labelled');
    await shot('08b-jobs-applied-bottom');
    await app.evaluate(() => { const p = RH.jobs.prefs(); p.appliedMode = 'hide'; RH.jobs.savePrefs(p); RH.render(); });
    const order2 = await app.$$eval('.job', (els) => els.map((e) => e.getAttribute('data-id')));
    check(order2.length === order.length - 1 && !order2.includes(tr[0].job.id), 'hide option removes applied jobs from the list');
    await app.evaluate(() => { const p = RH.jobs.prefs(); p.appliedMode = 'bottom'; RH.jobs.savePrefs(p); RH.render(); });
    await click('#tabs [data-tab=tracker]');

    // ---- embedded cross-origin ATS iframe -> app opens it directly
    statuses.length = 0;
    await job.goto('http://localhost:8701/careers-host.html');
    await tapAutofill();
    await new Promise((r) => setTimeout(r, 1500));
    check(loadInApplyCalled && loadInApplyCalled.includes('8702'), 'cross-origin form iframe detected and opened directly');
    await job.waitForSelector('#first', { timeout: 8000 });
    await tapAutofill();
    await new Promise((r) => setTimeout(r, 1500));
    check((await job.evaluate(() => window.__state.first)) === 'Priya', 'embedded form filled after opening directly');

    // ---- automatic autofill (no tap) is refused on a page that is not a hiring site
    statuses.length = 0;
    await app.evaluate(() => { RH.state.autoDone = {}; RH.state.applyJob = RH.state.search.result.jobs.find((j) => j.source === 'Employer'); });
    await job.goto('http://localhost:8701/react-form.html?auto=1'); await job.waitForSelector('#first');
    await tapAutofill(true); await new Promise((r) => setTimeout(r, 800));
    check((await job.evaluate(() => window.__state.email)) !== 'priya.sharma@example.com', 'auto-fill does NOT run on a page that is not a hiring site');
    check(statuses.some((x) => /known hiring site/.test(x)), 'status explains that tapping Autofill fills it');
    // ---- on a hiring system (the page reports Greenhouse's address) the form fills itself
    statuses.length = 0;
    const GH = 'https://job-boards.greenhouse.io/embed/job_app?for=gitlab&token=11';
    await job.goto('http://localhost:8701/react-form.html?auto=1'); await job.waitForSelector('#first');
    await tapAutofill(true, GH); // = MainActivity.scheduleAuto() firing after page load
    const ta = Date.now(); while (!statuses.some((x) => /Auto-filled/.test(x)) && Date.now() - ta < 10000) await new Promise((r) => setTimeout(r, 200));
    check(statuses.some((x) => /⚡ Auto-filled \d+ of \d+ fields/.test(x)), 'form auto-filled on load without tapping');
    check((await job.evaluate(() => window.__state.email)) === 'priya.sharma@example.com', 'auto-fill wrote the values');
    const before = statuses.length; await tapAutofill(true, GH); await new Promise((r) => setTimeout(r, 800));
    check(statuses.length === before, 'auto-fill runs once per page (no repeat on later triggers)');
    statuses.length = 0;
    await job.goto('http://localhost:8701/no-form.html'); await tapAutofill(true); await new Promise((r) => setTimeout(r, 500));
    check(statuses.length === 0, 'auto mode stays silent on pages without a form');

    // ---- no form on page
    statuses.length = 0;
    await job.goto('http://localhost:8701/no-form.html');
    await tapAutofill();
    await new Promise((r) => setTimeout(r, 500));
    check(statuses.some((s) => /No form found/.test(s)), 'helpful message when no form');

    // ---- DOCX + TXT extraction in the browser
    const docxB64 = fs.readFileSync(path.join(__dirname, 'cv.docx')).toString('base64');
    const docxText = await app.evaluate((b) => RH.cv.extractText({ name: 'cv.docx', mime: '' }, b), docxB64);
    check(/Flipkart/.test(docxText) && /VIT University/.test(docxText), 'DOCX text extraction');
    const txtText = await app.evaluate((b) => RH.cv.extractText({ name: 'cv.txt', mime: 'text/plain' }, b), Buffer.from(F.cvText).toString('base64'));
    check(/Bengaluru/.test(txtText), 'TXT extraction');
    const bad = await app.evaluate(() => RH.cv.extractText({ name: 'x.pdf', mime: 'application/pdf' }, btoa('%PDF-1.4 garbage')).then(() => 'ok', (e) => e.message));
    check(bad !== 'ok', 'corrupt PDF gives an error instead of hanging: ' + bad.slice(0, 60));

    // ---- back button behaviour
    await click('#tabs [data-tab=jobs]');
    await app.bringToFront(); await app.click('.job'); await app.waitForSelector('#sheet:not([hidden])');
    check(await app.evaluate(() => RH.onBack()) === true && await app.evaluate(() => document.getElementById('sheet').hidden), 'back closes job detail');
    check(await app.evaluate(() => RH.onBack()) === false, 'back on Jobs tab exits app');

    // employer job detail loads the full description on demand
    await app.evaluate(() => { const j = RH.state.search.result.jobs.find((x) => x.ats === 'greenhouse'); j.descLoaded = false; });
    await app.evaluate(() => { const j = RH.state.search.result.jobs.find((x) => x.ats === 'greenhouse'); document.querySelector('#sheet').hidden = true; });
    await app.evaluate(() => { const j = RH.state.search.result.jobs.find((x) => x.ats === 'greenhouse'); const el = document.createElement('div'); el.setAttribute('data-act', 'openJob'); el.setAttribute('data-id', j.id); document.body.appendChild(el); el.click(); });
    await app.waitForFunction(() => /Build our/.test((document.getElementById('jobDesc') || {}).textContent || ''), { timeout: 8000 });
    check(true, 'full description fetched from the employer\'s hiring system');
    await new Promise((r) => setTimeout(r, 300)); await shot('10-verified-detail');
    await app.evaluate(() => RH.onBack());
    check(discovered.length === 0 || discovered.every((d) => d.ats && d.slug), 'discovery payload well-formed');

    // ---- submission + account detection (MainActivity.schedulePageInfo)
    const pageInfo = async () => { const v = await job.evaluate(agent('__rh.pageInfo()')); await app.evaluate('RH.onPageInfo(' + v + ')'); };
    const gl = await app.evaluate(() => { const j = RH.state.search.result.jobs.find((x) => x.company === 'GitLab'); RH.state.applyJob = j; return j.id; });
    await app.evaluate((id) => { delete RH.state.tracker[id]; }, gl);
    await job.goto('http://localhost:8701/login.html'); await pageInfo();
    check((await app.evaluate(() => Object.keys(RH.store.get('accounts', {})))).includes('localhost'), 'sign-in site remembered in "My job site accounts"');
    await job.goto('http://localhost:8701/thanks.html'); await pageInfo();
    const tg = await app.evaluate((id) => RH.state.tracker[id], gl);
    check(tg && tg.status === 'applied' && tg.autoDetected, 'submitted application detected and marked Applied automatically');
    check(statuses.some((x) => /Application submitted/.test(x)), 'status bar confirms the submission');

    // ---- email tracking (IMAP on the phone)
    await click('#tabs [data-tab=settings]');
    check(await app.evaluate(() => /RemoteHunt v1\.0 \(personal\)/.test(document.body.innerText)), 'settings show the personal version (no over-the-air updates)');
    check(await app.evaluate(() => !!document.querySelector('[data-pref=directOnly]:checked') && document.querySelector('[data-pref=appliedMode]').value === 'bottom'), 'direct-only and applied-to-bottom settings shown, on by default');
    await app.$eval('[data-mail=user]', (e) => { e.value = 'priya@gmail.com'; });
    await app.type('[data-mail=pass]', 'wrong pass');
    await click('[data-act=connectMail]');
    await waitText('Login failed');
    check(true, 'wrong app password shows a clear error');
    await app.$eval('[data-mail=pass]', (e) => { e.value = ''; });
    await app.type('[data-mail=pass]', 'abcd efgh ijkl mnop');
    await click('[data-act=connectMail]');
    await app.waitForFunction(() => RH.mail.cfg() && RH.mail.cfg().lastCheck, { timeout: 10000 });
    check(mailCalls.every((c) => c.host === 'imap.gmail.com') && mailCalls[mailCalls.length - 1].pass === 'abcdefghijklmnop', 'Gmail IMAP used; spaces in app password removed');
    const tg2 = await app.evaluate((id) => RH.state.tracker[id], gl);
    check(tg2.status === 'interview' && tg2.mail[0].subject === 'Next steps — GitLab interview', 'interview email moved the GitLab application to Interview');
    await click('#tabs [data-tab=tracker]');
    await waitText('Next steps — GitLab interview');
    check(true, 'tracker shows the email subject');
    await new Promise((r) => setTimeout(r, 300)); await shot('13-tracker-email');

    // ---- new-job alerts: follow a site, background check scheduled, email alerts with a test email
    await click('#tabs [data-tab=jobs]');
    await app.type('#siteUrl', 'boards.greenhouse.io/testco');
    await click('[data-act=siteAdd]');
    await waitText('Following Test Co');
    check(await app.evaluate(() => window.__scheduled === true), 'following a site starts the 30-minute background check');
    check(await app.evaluate(() => /Checked about every 30 min, also when the app is closed/.test(document.body.innerText)), 'My sites says alerts are on');
    await click('#tabs [data-tab=settings]');
    await waitText('New-job alerts');
    await app.$eval('[data-alert=email]', (e) => e.click()); // styled switch: the checkbox itself is hidden
    await waitText('Send test email');
    await click('[data-act=alertTest]');
    await app.waitForFunction(() => (window.__sent || []).length === 1, { timeout: 5000 });
    const sent = await app.evaluate(() => Object.assign({ connected: RH.mail.cfg().user, pass0: RH.mail.cfg().pass }, window.__sent[0]));
    check(sent.host === 'smtp.gmail.com' && sent.user === sent.connected && sent.to === sent.connected && sent.pass === sent.pass0 && /test/i.test(sent.subject), 'test email sent from the connected Gmail to itself (' + sent.host + ', ' + sent.to + ')');
    await new Promise((r) => setTimeout(r, 300)); await shot('24-alert-settings');
    siteJobs.push({ id: 504, title: 'Prompt Engineer', location: { name: 'Remote' }, absolute_url: 'https://job-boards.greenhouse.io/testco/jobs/504' });
    await click('#tabs [data-tab=jobs]');
    await click('[data-act=sitesCheck]');
    await app.waitForFunction(() => (window.__sent || []).length === 2, { timeout: 8000 });
    const alertMail = await app.evaluate(() => window.__sent[1]);
    check(/1 new job: Prompt Engineer at Test Co/.test(alertMail.subject) && /jobs\/504|token=504/.test(alertMail.body), 'new job on a followed site -> alert email with its link');
    await click('.site-row'); await click('[data-act=siteRemove]');
    check(await app.evaluate(() => window.__scheduled === false), 'no sites left -> background check stopped');

    // ---- second CV + "All my CVs" search
    await click('#tabs [data-tab=profile]');
    await click('[data-act=pickCv]:not([data-slot])');
    await app.waitForFunction(() => RH.state.cvs.length === 2 && RH.state.cvs[1].profile && !RH.state.analyzing, { timeout: 20000 });
    const cvs = await app.evaluate(() => RH.state.cvs.map((c) => ({ id: c.id, label: c.label, email: c.profile.email })));
    check(cvs[1].label === 'Product Manager', 'second CV analyzed and labelled automatically');
    check(cvs[1].email === 'priya.sharma@example.com', 'contact details shared from the first CV');
    await new Promise((r) => setTimeout(r, 300)); await shot('11-two-cvs');
    await click('#tabs [data-tab=jobs]');
    await app.select('[data-cvmode]', 'all');
    await app.evaluate(() => { RH.jobs.clearCache(); RH.store.remove('rank.cache'); });
    await click('[data-act=search]');
    await app.waitForFunction(() => !RH.state.search.running, { timeout: 30000 });
    const best = await app.evaluate(() => RH.state.search.result.jobs.map((j) => [j.title, j.bestCv]));
    check(best.length > 0 && best.every((b) => b[1]), 'every job has a best-matching CV in "All my CVs" mode');
    check((await app.$$eval('.job .pill', (e) => e.map((x) => x.textContent))).some((t) => /📄/.test(t)), 'best CV shown on job cards');
    await shot('12-all-cvs');

    await click('#tabs [data-tab=settings]');
    await shot('09-settings-full');
    // ---- the server's code was changed: the app asks for the current one
    rejectActivations = true;
    await app.evaluate(() => { RH.state.lastAuto = 0; RH.nativeCall('closeApply'); RH.onAuthLost('expired'); });
    await waitText('no longer matches');
    check(await app.evaluate(() => !!document.querySelector('#codeIn')), 'stale built-in code -> asks for the current code');
    rejectActivations = false;
    await app.type('#codeIn', 'rhtest2code3');
    check((await app.$eval('#codeIn', (e) => e.value)) === 'RHTEST2CODE3', 'code input upper-cases as you type');
    await click('[data-act=verifyCode]');
    await app.waitForFunction(() => !!RH.store.get('auth'), { timeout: 8000 });
    check(true, 'typing the current code unlocks the app');

    // ---- accounts: a second person on the same phone gets a separate space
    const mainState = await app.evaluate(() => ({ t: Object.keys(RH.state.tracker).length, cvs: RH.state.cvs.length, name: RH.state.profile && RH.state.profile.fullName }));
    await click('#acctBtn'); await waitText('Each account has its own CVs');
    await shot('20-accounts');
    await app.type('#acctName', 'Rahul');
    await Promise.all([app.waitForNavigation({ waitUntil: 'load' }), click('[data-act=acctAdd]')]);
    await app.waitForFunction(() => window.RH && RH.state && document.querySelector('#acctBtn').textContent.includes('Rahul'), { timeout: 8000 });
    check(await app.evaluate(() => !RH.state.profile && RH.state.cvs.length === 0 && Object.keys(RH.state.tracker).length === 0), 'new account starts empty (no CV, profile or tracker from the other account)');
    check(await app.evaluate(() => !window.Android.kvGet('cv.meta')), 'native "attach my saved CV" no longer points at the other account\'s file');
    check(await app.evaluate(() => !!RH.store.get('auth') && !document.querySelector('#codeIn')), 'still signed in after switching');
    await click('[data-act=pickCv]');
    await app.waitForFunction(() => RH.state.cvs.length === 1, { timeout: 8000 });
    await shot('21-second-account');
    check(await app.evaluate(() => RH.state.cvs[0].id.indexOf(RH.account.currentId() + '_') === 0), 'CV saved in its own file slot (cannot overwrite the other account\'s CV)');
    await click('#acctBtn'); await waitText('Each account has its own CVs');
    await Promise.all([app.waitForNavigation({ waitUntil: 'load' }), click('[data-act=acctSwitch][data-id=main]')]);
    await app.waitForFunction(() => window.RH && RH.state && RH.account.currentId() === 'main', { timeout: 8000 });
    check(await app.evaluate((m) => RH.state.cvs.length === m.cvs && Object.keys(RH.state.tracker).length === m.t && (RH.state.profile && RH.state.profile.fullName) === m.name, mainState), 'switching back restores the first account\'s CVs, profile and tracker');
    const rahul = await app.evaluate(() => RH.account.list().filter((a) => a.name === 'Rahul')[0].id);
    await click('#acctBtn'); await waitText('Each account has its own CVs');
    await Promise.all([app.waitForNavigation({ waitUntil: 'load' }), click('[data-act=acctSwitch][data-id=' + rahul + ']')]);
    await app.waitForFunction(() => window.RH && RH.state && RH.account.currentId() !== 'main', { timeout: 8000 });
    await click('#acctBtn'); await click('[data-act=acctDelete]'); await waitText('Delete "Rahul"?');
    await Promise.all([app.waitForNavigation({ waitUntil: 'load' }), click('[data-act=acctDoDelete]')]);
    await app.waitForFunction(() => window.RH && RH.state && RH.account.currentId() === 'main', { timeout: 8000 });
    check(await app.evaluate((id) => RH.account.list().length === 1 && !Object.keys(JSON.parse(sessionStorage.getItem('__phone') || '{"kv":{}}').kv).some((k) => k.indexOf('acct.' + id + '.') === 0), rahul), 'deleting an account removes it and all its data');
    check(await app.evaluate((m) => RH.state.cvs.length === m.cvs, mainState), 'the first account is untouched');

    check(consoleErrors.length === 0, 'no console errors' + (consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''));
  } catch (e) {
    failures.push('EXCEPTION ' + e.stack);
    console.log(e);
    await shot('zz-error').catch(() => {});
    console.log('console errors:', consoleErrors);
    console.log('statuses:', statuses);
  }
  await browser.close();
  console.log('\n' + (failures.length ? '✗ ' + failures.length + ' FAILED:\n - ' + failures.join('\n - ') : '✓ ALL E2E CHECKS PASSED'));
  process.exit(failures.length ? 1 : 0);
})();
