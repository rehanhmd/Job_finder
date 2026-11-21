/* Mail: reads recent emails on the phone (IMAP + app password) and updates the application tracker
 * when companies reply: received, assessment, interview, rejection, offer. */
(function (g) {
  var RH = g.RH, U = RH.util;

  var PROVIDERS = {
    gmail: { name: 'Gmail', host: 'imap.gmail.com', smtp: 'smtp.gmail.com', help: 'https://myaccount.google.com/apppasswords' },
    yahoo: { name: 'Yahoo Mail', host: 'imap.mail.yahoo.com', smtp: 'smtp.mail.yahoo.com', help: 'https://login.yahoo.com/account/security' },
    other: { name: 'Other (IMAP server)', host: '', help: '' }
  };

  function cfg() { return RH.store.get('mail.cfg', null); }
  function saveCfg(c) { RH.store.set('mail.cfg', c); }

  // ---------- decoding
  function bytesToText(bytes, charset) {
    try { return new TextDecoder(/8859|latin|1252|ascii/i.test(charset || '') ? 'iso-8859-1' : 'utf-8').decode(bytes); }
    catch (e) {
      var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      if (!/8859|latin|1252|ascii/i.test(charset || '')) { try { return decodeURIComponent(escape(s)); } catch (e2) { } }
      return s;
    }
  }
  function b64Bytes(s) { var bin = atob(s.replace(/\s+/g, '')), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function qpBytes(s, header) {
    if (header) s = s.replace(/_/g, ' ');
    s = s.replace(/=\r?\n/g, '');
    var out = [];
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-F]{2}$/i.test(s.substr(i + 1, 2))) { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
      else { var c = s.charCodeAt(i); if (c < 128) out.push(c); else { var enc = new TextEncoder().encode(s[i]); for (var k = 0; k < enc.length; k++) out.push(enc[k]); } }
    }
    return new Uint8Array(out);
  }
  /** RFC 2047 encoded words: =?UTF-8?B?...?= / =?UTF-8?Q?...?= */
  function decodeWords(s) {
    return String(s || '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, function (m, cs, enc, txt) {
      try { return bytesToText(/b/i.test(enc) ? b64Bytes(txt) : qpBytes(txt, true), cs); } catch (e) { return txt; }
    });
  }
  function cleanBody(b) {
    var s = String(b || '');
    // MIME parts: keep the first text part
    var part = s.match(/Content-Type:\s*text\/(plain|html)[^\n]*\n([\s\S]*?)(\n--[^\n]+|$)/i);
    var enc = /Content-Transfer-Encoding:\s*base64/i.test(s) ? 'b64' : /quoted-printable/i.test(s) ? 'qp' : '';
    if (part) { s = part[2].replace(/^[\s\S]*?\r?\n\r?\n/, function (h) { return /:\s/.test(h) ? '' : h; }); }
    if (enc === 'b64' || (/^[A-Za-z0-9+\/=\s]{200,}$/.test(s.trim()) && !/\s{2,}\w/.test(s.trim().slice(0, 100)))) {
      try { s = bytesToText(b64Bytes(s.replace(/--[\s\S]*$/, ''))); } catch (e) { }
    } else if (enc === 'qp' || /=\r?\n|=[0-9A-F]{2}/.test(s)) {
      try { s = bytesToText(qpBytes(s)); } catch (e) { }
    }
    return s.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/^--.*$/gm, '').replace(/^[\w-]+:\s.*$/gm, '').replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim().slice(0, 1500);
  }

  // ---------- understanding
  var TYPES = [
    ['offer', /\b(offer letter|pleased to (extend|offer)|job offer|offer of employment|we('d| would) like to offer you)\b/i],
    ['rejected', /\b(unfortunately|not (be )?moving forward|decided to (pursue|proceed|move forward) with other|regret to inform|position has been filled|not been selected|will not be progressing|decided not to proceed|no longer (being )?considered)\b/i],
    ['assessment', /\b(assessment|coding (challenge|test|exercise)|take[- ]home|hackerrank|codility|codesignal|testgorilla|coderbyte|hirevue|skills? test|online test|technical (test|exercise)|questionnaire to complete)\b/i],
    ['interview', /\b(interview|schedule (a |an )?(call|chat|time|meeting)|calendly\.com|goodtime|book a (time|slot)|your availability|speak with you|phone screen|meet the team)\b/i],
    ['received', /\b(thank(s| you) for (applying|your application|your interest)|application (has been |was )?(received|submitted)|we('ve| have) received your application)\b/i]
  ];
  var RANK = { saved: 0, applying: 1, applied: 2, assessment: 3, interview: 4, offer: 6, rejected: 5 };
  function classify(text) { for (var i = 0; i < TYPES.length; i++) if (TYPES[i][1].test(text)) return TYPES[i][0]; return null; }

  var SUFFIX = /\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|company|technologies|technology|labs|group|hq|pvt|plc|sa|bv|ag)\b/g;
  function companyKey(name) { return U.norm(name).replace(SUFFIX, '').replace(/\s+/g, ' ').trim(); }

  /** Find the tracked application this email is about. */
  function match(msg, entries) {
    var hay = ' ' + U.norm(msg.from + ' ' + msg.subject + ' ' + msg.body.slice(0, 800)) + ' ';
    var fromDomain = ((msg.from.match(/@([\w.-]+)/) || [])[1] || '').toLowerCase();
    var best = null, bestLen = 0;
    entries.forEach(function (t) {
      var key = companyKey(t.job.company);
      if (key.length < 3) return;
      var hit = hay.indexOf(' ' + key + ' ') >= 0 || (fromDomain && fromDomain.replace(/[^a-z0-9]/g, '').indexOf(key.replace(/\s/g, '')) >= 0);
      if (hit && key.length > bestLen) { best = t; bestLen = key.length; }
    });
    return best;
  }

  /** Apply one email to the tracker. Returns a short description of the change, or null. */
  function apply(msg, entries) {
    var type = classify(msg.subject + ' ' + msg.body);
    if (!type) return null;
    var t = match(msg, entries);
    if (!t) return null;
    t.mail = t.mail || [];
    if (t.mail.some(function (m) { return m.id === msg.id; })) return null;
    t.mail.push({ id: msg.id, type: type, subject: msg.subject.slice(0, 160), from: msg.from.replace(/<.*>/, '').trim().slice(0, 60), date: Date.parse(msg.date) || Date.now() });
    t.mail.sort(function (a, b) { return b.date - a.date; });
    if (t.mail.length > 10) t.mail.length = 10;
    var target = type === 'received' ? 'applied' : type;
    var cur = t.status || 'saved';
    var change = false;
    if (target === 'offer') change = cur !== 'offer';
    else if (target === 'rejected') change = cur !== 'offer' && cur !== 'rejected';
    else change = (RANK[target] || 0) > (RANK[cur] || 0) && cur !== 'rejected' && cur !== 'offer';
    if (change) { t.status = target; if (target === 'applied' && !t.appliedAt) t.appliedAt = t.mail[0].date; }
    t.updated = Date.now();
    return { job: t.job, type: type, changed: change };
  }

  /** Fetch recent mail and update `tracker` in place. Resolves {checked, updates, error}. */
  function check(tracker) {
    var c = cfg();
    if (!c || !c.user || !c.pass) return Promise.resolve({ error: 'Email not connected' });
    var entries = Object.keys(tracker).map(function (k) { return tracker[k]; }).filter(function (t) { return t.status !== 'saved'; });
    return RH.mailFetch({ host: c.host, port: c.port || 993, user: c.user, pass: c.pass, days: 30, max: 150 }).then(function (r) {
      c.lastCheck = Date.now();
      if (r.status !== 200) { c.lastError = r.error || 'Could not read email'; saveCfg(c); return { error: c.lastError }; }
      var msgs = (JSON.parse(r.body).messages || []).map(function (m) {
        return { id: m.id, from: decodeWords(m.from), subject: decodeWords(m.subject), date: m.date, body: cleanBody(m.body) };
      });
      var updates = [];
      msgs.forEach(function (m) { var u = apply(m, entries); if (u) updates.push(u); });
      c.lastError = ''; c.lastCount = msgs.length; saveCfg(c);
      return { checked: msgs.length, updates: updates };
    });
  }

  RH.mail = { PROVIDERS: PROVIDERS, cfg: cfg, saveCfg: saveCfg, check: check, decodeWords: decodeWords, cleanBody: cleanBody, classify: classify, match: match, apply: apply };
})(typeof window !== 'undefined' ? window : globalThis);
