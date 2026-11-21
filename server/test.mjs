import assert from 'node:assert/strict';
import W, { _test } from './worker.js';
import { D1 } from './d1shim.mjs';
const DB = D1();
const CODE = 'RH-ABCDE-FGH23';
const ENV = {};
let r, j0;
const H = 'https://x.workers.dev';
const call = (path, { method = 'GET', body, headers = {}, env = {}, ip = '1.1.1.1' } = {}) =>
  W.fetch(new Request(H + path, { method, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers }, body: body ? JSON.stringify(body) : undefined }), { DB, ACCESS_CODE: CODE, ...env }, { waitUntil() {} });
const act = (code, ip, env = ENV, device = 'phoneA') => call('/v1/activate', { method: 'POST', body: { code, device, model: 'Pixel 8' }, ip, env }).then(async (x) => ({ status: x.status, j: await x.json() }));
// ---- no admin page, no update endpoint, health leaks nothing
r = await call('/admin'); assert.equal(r.status, 401, 'admin page is gone');
r = await call('/app/patches?build=3'); assert.equal(r.status, 401, 'no over-the-air update endpoint');
r = await call('/'); assert.deepEqual(await r.json(), { ok: true });
// ---- server without ACCESS_CODE refuses to activate
let n0 = await act(CODE, '1.1.1.1', { ACCESS_CODE: '' }); assert.equal(n0.status, 503); assert.equal(n0.j.error.code, 'no_code');
// ---- activation with the owner's code
let a1 = await act(CODE.toLowerCase().replace(/-/g, ' ')); assert.equal(a1.status, 200, JSON.stringify(a1.j)); assert.match(a1.j.token, /^[0-9a-f]{48}$/);
let bad = await act('RH-AAAAA-BBBBB'); assert.equal(bad.status, 403); assert.equal(bad.j.error.code, 'bad_code');
let short = await act('RH-AAAA'); assert.equal(short.status, 400);
const auth = (t, env = ENV) => call('/v1/me', { headers: { Authorization: 'Bearer ' + t }, env }).then((x) => x.status);
assert.equal(await auth(a1.j.token), 200);
r = await call('/v1/jobs', { env: ENV }); assert.equal(r.status, 401); assert.equal((await r.json()).error.code, 'no_access');
assert.equal(await auth('0'.repeat(48)), 401, 'random token refused');
// ---- the same device signing in again replaces only its own old token
let a2 = await act(CODE); assert.equal(a2.status, 200);
assert.equal(await auth(a1.j.token), 401, 'this device\'s old token is replaced');
assert.equal(await auth(a2.j.token), 200);
// ---- other devices stay signed in, up to 5; the 6th pushes out the oldest
const others = [];
for (let i = 0; i < 4; i++) others.push((await act(CODE, '1.1.1.1', ENV, 'dev' + i)).j.token);
assert.equal(await auth(a2.j.token), 200, 'first phone still signed in with 5 devices');
assert.ok((await Promise.all(others.map((t) => auth(t)))).every((x) => x === 200), 'all 5 devices signed in');
const sixth = (await act(CODE, '1.1.1.1', ENV, 'dev-six')).j.token;
assert.equal(await auth(sixth), 200); assert.equal(await auth(a2.j.token), 401, 'oldest device pushed out by the 6th');
a2 = await act(CODE); assert.equal(await auth(a2.j.token), 200, 'signing in again works');
// ---- changing ACCESS_CODE signs every phone out
assert.equal(await auth(a2.j.token, { ACCESS_CODE: 'RH-ZZZZZ-ZZZZZ' }), 401, 'rotating the secret revokes the token');
assert.equal(await auth(a2.j.token, { ACCESS_CODE: '' }), 401, 'removing the secret revokes the token');
// ---- status page needs a token
r = await call('/v1/status', { env: ENV }); assert.equal(r.status, 401);
r = await call('/v1/status', { headers: { Authorization: 'Bearer ' + a2.j.token }, env: { ...ENV, GROQ_KEY: 'k' } }); j0 = await r.json(); assert.ok(j0.providers.includes('groq-gpt-oss-120b'));
let T = a2.j.token;
// ---- chat works with token, cap per code
const msg = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 99999 };
let seen; const AI = { run: async (m, inp) => { seen = inp; return { response: '<think>x</think>Hello from ' + m }; } };
r = await call('/v1/chat/completions', { method: 'POST', body: msg, headers: { Authorization: 'Bearer ' + T }, env: { AI } });
let j = await r.json(); assert.equal(j.choices[0].message.content, 'Hello from @cf/openai/gpt-oss-20b'); assert.equal(seen.max_tokens, 4096);
// cap: one chat so far today; with a cap of 3, two more pass and the next is refused
for (let i = 0; i < 2; i++) { r = await call('/v1/chat/completions', { method: 'POST', body: msg, headers: { Authorization: 'Bearer ' + T }, env: { AI, DAILY_CAP: '3' } }); assert.equal(r.status, 200); }
r = await call('/v1/chat/completions', { method: 'POST', body: msg, headers: { Authorization: 'Bearer ' + T, 'X-RH-Device': 'spoofed' }, env: { AI, DAILY_CAP: '3' } });
assert.equal(r.status, 429, 'daily cap applies; spoofing the device header does not help');
// ---- brute force lockout
for (let i = 0; i < 8; i++) await act('RH-ZZZZZ-ZZZZ' + (i % 9 + 2), '9.9.9.9');
assert.equal((await act(CODE, '9.9.9.9')).status, 429, 'IP locked after repeated wrong codes');
const fresh = await act(CODE, '8.8.8.8'); assert.equal(fresh.status, 200, 'other IPs unaffected');
T = fresh.j.token;
// ---- relay behaviour kept: fallback, shapes, limits
const T2 = T;
const chat = (env, extra = {}) => call('/v1/chat/completions', { method: 'POST', body: extra.body || msg, headers: { Authorization: 'Bearer ' + T2 }, env });
r = await chat({ AI: { run: async () => ({ output: [{ type: 'reasoning', content: [{ text: '' }] }, { type: 'message', content: [{ text: 'B' }] }] }) } }); assert.equal((await r.json()).choices[0].message.content, 'B');
r = await chat({ AI: { run: async (m) => { if (m.includes('gpt-oss')) throw new Error('5007'); return { response: 'llama ok' }; } } }); assert.equal((await r.json()).choices[0].message.content, 'llama ok');
r = await chat({ AI }, { body: { messages: [{ role: 'user', content: 'x'.repeat(70000) }] } }); assert.equal(r.status, 413);
globalThis.fetch = async (u) => new Response(JSON.stringify({ model: 'openai/gpt-oss-120b', choices: [{ message: { content: 'from groq' } }] }));
r = await chat({ AI: { run: async () => { throw new Error('4006: daily free allocation of 10,000 neurons used'); } } });
assert.equal(r.status, 503, 'only Workers AI configured and it is out of allowance');
r = await chat({ AI }); assert.equal(r.status, 503, 'workers-ai cooling down until midnight UTC');
r = await chat({ AI, GROQ_KEY: 'k' }); j = await r.json(); assert.equal(j.provider, 'groq-gpt-oss-120b', 'a key-based provider still serves');
r = await call('/'); j = await r.json(); assert.deepEqual(j, { ok: true }, 'health page leaks nothing');
// ---- priority: strongest configured provider first, multi-key rotation
const calls = [];
globalThis.fetch = async (u, o) => { const b = JSON.parse(o.body); const k = o.headers.Authorization; calls.push(b.model + ' ' + k);
  if (k === 'Bearer g1') return new Response('{"error":{"message":"quota"}}', { status: 429 });
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok ' + b.model } }] })); };
const T3 = T;
r = await call('/v1/chat/completions', { method: 'POST', body: msg, headers: { Authorization: 'Bearer ' + T3 }, env: { AI, GEMINI_KEY: 'g1, g2', GROQ_KEY: 'q' } });
j = await r.json();
assert.deepEqual(calls, ['gemini-flash-latest Bearer g1', 'gemini-flash-latest Bearer g2'], 'first key rate-limited -> second key of the same best model');
assert.equal(j.provider, 'gemini-flash#2');
// ---- a slow provider is cut off and the next one answers; reasoning_effort sent, dropped if refused
const realTimeout = AbortSignal.timeout; AbortSignal.timeout = () => { const c = new AbortController(); setTimeout(() => c.abort(Object.assign(new Error('t'), { name: 'TimeoutError' })), 50); return c.signal; };
const seen2 = [];
globalThis.fetch = async (u, o) => { const b = JSON.parse(o.body); seen2.push(b.model + ':' + (b.reasoning_effort || '-'));
  if (b.model === 'gemini-flash-latest') return new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' }))));
  if (b.model === 'openai/gpt-oss-120b' && b.reasoning_effort) return new Response('{"error":{"message":"reasoning_effort not supported"}}', { status: 400 });
  return new Response(JSON.stringify({ choices: [{ message: { content: 'fast ' + b.model } }] })); };
const T4 = T;
const t0 = Date.now();
r = await call('/v1/chat/completions', { method: 'POST', body: msg, headers: { Authorization: 'Bearer ' + T4 }, env: { AI, GEMINI_KEY: 'cooled, gs', GROQ_KEY: 'qs' } });
j = await r.json(); AbortSignal.timeout = realTimeout;
assert.equal(j.provider, 'groq-gpt-oss-120b', 'slow Gemini is cut off, Groq answers');
assert.ok(Date.now() - t0 < 2000, 'cut-off happened quickly');
assert.deepEqual(seen2, ['gemini-flash-latest:low', 'openai/gpt-oss-120b:low', 'openai/gpt-oss-120b:-'], 'effort sent, retried without it on 400');
seen2.length = 0;
r = await call('/v1/chat/completions', { method: 'POST', body: msg, headers: { Authorization: 'Bearer ' + T4 }, env: { AI, GEMINI_KEY: 'cooled, gs', GROQ_KEY: 'qs' } });
assert.ok(!seen2.includes('gemini-flash-latest:low'), 'slow provider skipped for a few minutes');
// ---- hedging: a slow first provider gets company; the first good answer wins
_test.cooldown.clear(); // earlier cases left providers cooling down
const hedgeCalls = [];
globalThis.fetch = async (u, o) => { const b = JSON.parse(o.body); hedgeCalls.push(b.model);
  if (b.model === 'gemini-flash-latest') { await new Promise((r) => setTimeout(r, 1500)); return new Response(JSON.stringify({ choices: [{ message: { content: 'slow' } }] })); }
  return new Response(JSON.stringify({ choices: [{ message: { content: 'fast ' + b.model } }] })); };
let h0 = Date.now();
r = await call('/v1/chat/completions', { method: 'POST', body: msg, headers: { Authorization: 'Bearer ' + T }, env: { AI, GEMINI_KEY: 'hg', HEDGE_MS: '100' } });
j = await r.json();
assert.equal(j.provider, 'gemini-flash-lite', 'slow main model -> light model started after the hedge delay answers first');
assert.ok(Date.now() - h0 < 1200, 'answer arrived without waiting for the slow model');
assert.deepEqual(hedgeCalls.slice(0, 2), ['gemini-flash-latest', 'gemini-flash-lite-latest']);
hedgeCalls.length = 0;
globalThis.fetch = async (u, o) => { const b = JSON.parse(o.body); hedgeCalls.push(b.model); return new Response(JSON.stringify({ choices: [{ message: { content: 'quick ' + b.model } }] })); };
r = await call('/v1/chat/completions', { method: 'POST', body: msg, headers: { Authorization: 'Bearer ' + T }, env: { AI, GEMINI_KEY: 'hg2', HEDGE_MS: '100' } });
j = await r.json(); assert.equal(j.provider, 'gemini-flash'); assert.deepEqual(hedgeCalls, ['gemini-flash-latest'], 'a fast first answer starts nothing else');
await new Promise((res) => setTimeout(res, 1600)); // let the slow call from the first case finish
console.log('worker (owner auth + relay): all checks passed');
