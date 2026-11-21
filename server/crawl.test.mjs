import assert from 'node:assert/strict';
import W, { _test } from './worker.js';
import { D1 } from './d1shim.mjs';
const day = 86400000, now = Date.now();
const F = {
  'boards-api.greenhouse.io/v1/boards/gitlab/jobs': { jobs: [
    { id: 11, title: 'Senior Frontend Engineer', location: { name: 'Remote, EMEA' }, absolute_url: 'https://job-boards.greenhouse.io/gitlab/jobs/11', updated_at: new Date(now - day).toISOString(), first_published: new Date(now - 2 * day).toISOString(), company_name: 'GitLab' },
    { id: 12, title: 'Office Manager', location: { name: 'San Francisco, CA' }, absolute_url: 'x', updated_at: new Date().toISOString() },
    { id: 13, title: 'Designer', location: { name: 'Hybrid - Remote/London' }, absolute_url: 'x' }] },
  'api.lever.co/v0/postings/acme?mode=json': [
    { id: 'L1', text: 'React Developer', categories: { location: 'Bengaluru', team: 'Web', commitment: 'Full-time' }, workplaceType: 'remote', createdAt: now - 3 * day, hostedUrl: 'https://jobs.lever.co/acme/L1', applyUrl: 'https://jobs.lever.co/acme/L1/apply', descriptionPlain: 'Build React apps', salaryRange: { min: 40000, max: 60000, currency: 'USD', interval: 'per-year-salary' } },
    { id: 'L2', text: 'Sales', categories: { location: 'Remote' }, workplaceType: 'hybrid', hostedUrl: 'h' }],
  'api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true': { jobs: [
    { id: 'A1', title: 'Product Engineer', location: 'Remote (Global)', isRemote: true, workplaceType: 'Remote', isListed: true, publishedAt: new Date(now - day).toISOString(), jobUrl: 'https://jobs.ashbyhq.com/linear/A1', applyUrl: 'https://jobs.ashbyhq.com/linear/A1/application', descriptionPlain: 'Ship fast', compensation: { compensationTierSummary: '$150K – $200K' } },
    { id: 'A2', title: 'Unlisted', isRemote: true, isListed: false }] },
  'api.smartrecruiters.com/v1/companies/visa/postings?limit=100': { content: [
    { id: '7444', uuid: 'u-1', name: 'Data Analyst', company: { identifier: 'Visa', name: 'Visa' }, releasedDate: new Date(now - day).toISOString(), location: { city: 'Pune', country: 'in', remote: true } },
    { id: '7445', name: 'Onsite', location: { remote: false } }] },
  'apply.workable.com/api/v1/widget/accounts/hotjar': { name: 'Hotjar', jobs: [
    { title: 'Support Specialist', shortcode: 'AB12', telecommuting: true, url: 'https://apply.workable.com/j/AB12', application_url: 'https://apply.workable.com/j/AB12/apply', published_on: new Date(now - day).toISOString().slice(0, 10), country: 'Malta' },
    { title: 'Office', shortcode: 'X', telecommuting: false }] },
  'remote-co.recruitee.com/api/offers/': { offers: [
    { id: 5, title: 'Backend Engineer', remote: true, hybrid: false, on_site: false, location: 'Europe', careers_url: 'https://remote-co.recruitee.com/o/backend', careers_apply_url: 'https://remote-co.recruitee.com/o/backend/c/new', published_at: '2026-11-15 10:00:00 UTC', description: '<p>Go &amp; Postgres</p>', company_name: 'RemoteCo' }] }
};
let fetches = [];
globalThis.fetch = async (u) => {
  const k = String(u).replace(/^https:\/\//, ''); fetches.push(k);
  if (F[k]) return new Response(JSON.stringify(F[k]), { status: 200 });
  return new Response('{"ok":false}', { status: 404 });
};
// ---- 1. parsers keep only fully-remote jobs and produce direct apply links
const P = _test.parseBoard;
const gh = P('greenhouse', 'gitlab', F['boards-api.greenhouse.io/v1/boards/gitlab/jobs']);
assert.equal(gh.name, 'GitLab'); assert.equal(gh.jobs.length, 1, 'onsite + hybrid excluded');
assert.equal(gh.jobs[0].a, 'https://job-boards.greenhouse.io/embed/job_app?for=gitlab&token=11');
const lv = P('lever', 'acme', F['api.lever.co/v0/postings/acme?mode=json']); assert.equal(lv.jobs.length, 1); assert.equal(lv.jobs[0].s, '$40k–60k');
const as = P('ashby', 'linear', F['api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true']); assert.equal(as.jobs.length, 1); assert.equal(as.jobs[0].s, '$150K – $200K');
const sm = P('smartrecruiters', 'visa', F['api.smartrecruiters.com/v1/companies/visa/postings?limit=100']); assert.equal(sm.jobs.length, 1); assert.match(sm.jobs[0].u, /jobs\.smartrecruiters\.com\/Visa\/7444/);
const wo = P('workable', 'hotjar', F['apply.workable.com/api/v1/widget/accounts/hotjar']); assert.equal(wo.name, 'Hotjar'); assert.equal(wo.jobs.length, 1); assert.match(wo.jobs[0].a, /apply$/);
const re = P('recruitee', 'remote-co', F['remote-co.recruitee.com/api/offers/']); assert.equal(re.jobs[0].x, 'Go & Postgres'); assert.ok(re.jobs[0].p > 0);
console.log('parsers ok; lever salary =', lv.jobs[0].s);

// ---- 2. crawl on a real SQLite db with a small custom seed
const env = { DB: D1() };
const admin0 = async (e) => { e.ACCESS_CODE = 'RH-ABCDE-FGH23'; return (await (await W.fetch(new Request('https://x/v1/activate', { method: 'POST', body: JSON.stringify({ code: e.ACCESS_CODE }) }), e, {})).json()).token; };
_test.SEED.length = 0;
_test.SEED.push(['gr', 'gitlab', 'GitLab'], ['le', 'acme', 'Acme'], ['as', 'linear', ''], ['sm', 'visa', ''], ['wo', 'hotjar', ''], ['re', 'remote-co', ''], ['gr?', 'doesnotexist', ''], ['le?', 'gitlab', '']);
let r = await _test.crawl(env);
console.log('crawl 1:', r.checked.join(' | '));
r = await _test.crawl(env); console.log('crawl 2:', r.checked.join(' | '));
const rows = env.DB._db.prepare('SELECT ats, slug, status, n_jobs FROM companies ORDER BY ats, slug').all();
const st = Object.fromEntries(rows.map((x) => [x.ats + ':' + x.slug, x.status + '/' + x.n_jobs]));
assert.equal(st['greenhouse:gitlab'], 'ok/1'); assert.equal(st['lever:acme'], 'ok/1'); assert.equal(st['ashby:linear'], 'ok/1');
assert.equal(st['smartrecruiters:visa'], 'ok/1'); assert.equal(st['workable:hotjar'], 'ok/1'); assert.equal(st['recruitee:remote-co'], 'ok/1');
assert.equal(st['greenhouse:doesnotexist'], 'dead/0', 'guess that 404s is dropped'); assert.equal(st['lever:gitlab'], 'dead/0');
// second run immediately: nothing due
fetches = []; r = await _test.crawl(env); assert.equal(fetches.length, 0, 'not re-crawled before next_check');

// ---- 3. feed via HTTP with auth
const T = await admin0(env);
const call = (path, opt = {}) => W.fetch(new Request('https://x.workers.dev' + path, { method: opt.method || 'GET', headers: { Authorization: 'Bearer ' + T, ...(opt.headers || {}) }, body: opt.body }), env, { waitUntil() {} });
let res = await call('/v1/jobs'); let j = await res.json();
assert.equal(j.companies.length, 6); const allJobs = j.companies.flatMap((c) => c.j); assert.equal(allJobs.length, 6);
assert.ok(j.companies.find((c) => c.s === 'gitlab').n === 'GitLab');
res = await call('/v1/jobs?since=' + j.at); j = await res.json(); assert.equal(j.companies.length, 0, 'delta empty');
res = await W.fetch(new Request('https://x.workers.dev/v1/jobs'), env, {}); assert.equal(res.status, 401);

// ---- 4. discovery adds new boards (validated), ignores junk and duplicates
res = await call('/v1/discover', { method: 'POST', body: JSON.stringify({ items: [{ ats: 'ashby', slug: 'posthog' }, { ats: 'greenhouse', slug: 'gitlab' }, { ats: 'evil', slug: 'x' }, { ats: 'lever', slug: '../../etc' }] }) });
j = await res.json(); assert.equal(j.added, 1);
// ---- 5. signed-in status shows counts; public health shows nothing
res = await call('/v1/status'); j = await res.json(); assert.equal(j.employers.ok.companies, 6); assert.equal(j.employers.new.companies, 1);
res = await W.fetch(new Request('https://x.workers.dev/'), env, {}); assert.deepEqual(await res.json(), { ok: true });
// ---- 6. byte budget: a huge board is processed alone, others deferred to the next run
const big = { jobs: Array.from({ length: 6000 }, (_, i) => ({ id: i, title: 'Job ' + i + ' '.repeat(150), location: { name: i % 2 ? 'Remote' : 'NYC' }, absolute_url: 'u' })) };
F['boards-api.greenhouse.io/v1/boards/bigco/jobs'] = big;
const env2 = { DB: D1() }; _test.SEED.length = 0; _test.SEED.push(['gr', 'bigco', ''], ['gr', 'gitlab', '']);
r = await _test.crawl(env2); console.log('budget run:', r.checked.join(' | '));
assert.ok(r.checked.some((x) => /bigco 3000/.test(x)), 'big board parsed');
const t0 = performance.now(); const pb = P('greenhouse', 'bigco', big); console.log('parse 6000-job board:', (performance.now() - t0).toFixed(1), 'ms', JSON.stringify(big).length, 'bytes');
// ---- 7. one crawl at a time; claimed companies are not retried right away even if a run dies
const env3 = { DB: D1() }; _test.SEED.length = 0; _test.SEED.push(['gr', 'gitlab', ''], ['le', 'acme', ''], ['as', 'linear', '']);
const [c1, c2] = await Promise.all([_test.crawl(env3), _test.crawl(env3)]);
assert.ok([c1, c2].filter((x) => x.ran).length === 1 && [c1, c2].some((x) => x.busy), 'second overlapping run backs off');
const env4 = { DB: D1() }; _test.SEED.length = 0; _test.SEED.push(['gr', 'gitlab', ''], ['le', 'acme', '']);
const realBatch = env4.DB.batch.bind(env4.DB); let nb = 0;
env4.DB.batch = async (st) => { nb++; if (nb === 4) throw new Error('simulated CPU limit'); return realBatch(st); }; // 1 = schema, 2 = seed, 3 = claim, 4 = results
await assert.rejects(_test.crawl(env4));
env4.DB.batch = realBatch;
await env4.DB.prepare('UPDATE meta SET v = ?1 WHERE k = ?2').bind('0', 'crawl_lock').run();
fetches = []; r = await _test.crawl(env4);
assert.equal(fetches.length, 0, 'claimed companies wait 15 min instead of blocking the queue');
assert.equal(r.ran, true); assert.equal(r.due, 0);
// ---- 8. /v1/crawl runs a batch for signed-in phones and reports what is left
const env5 = { DB: D1() }; _test.SEED.length = 0; _test.SEED.push(['gr', 'gitlab', ''], ['gr', 'nope1', ''], ['gr', 'nope2', '']);
const T5 = await admin0(env5);
res = await W.fetch(new Request('https://x.workers.dev/v1/crawl', { method: 'POST', headers: { Authorization: 'Bearer ' + T5 } }), env5, {});
j = await res.json(); assert.equal(j.ran, true); assert.equal(j.checked.length, 3); assert.equal(j.due, 0);
res = await W.fetch(new Request('https://x.workers.dev/v1/crawl', { method: 'POST' }), env5, {}); assert.equal(res.status, 401, 'crawl needs an access code');
let bg = null; res = await W.fetch(new Request('https://x.workers.dev/v1/me', { headers: { Authorization: 'Bearer ' + T5 } }), env5, { waitUntil(p) { bg = p; } });
assert.equal(res.status, 200); assert.ok(bg, '/v1/me also nudges the crawler in the background'); await bg;
// ---- 9. no over-the-air update endpoint
res = await W.fetch(new Request('https://x.workers.dev/app/patches?build=3'), env5, {}); assert.equal(res.status, 401);
console.log('crawler: all checks passed');
