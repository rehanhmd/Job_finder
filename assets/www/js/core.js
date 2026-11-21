/* Core: namespace, native bridge (with browser fallback for testing), storage, helpers. */
(function (g) {
  var RH = g.RH = g.RH || {};
  var native = g.Android || null;
  RH.isNative = !!native;

  // ---------- HTTP via native (no CORS). Falls back to fetch() in a desktop browser.
  var pending = {}, seq = 0;
  g.__httpDone = function (id) {
    var cb = pending[id]; delete pending[id];
    if (!cb) return;
    var r;
    try { r = JSON.parse(native.httpTake(id)); } catch (e) { r = { status: 0, error: 'Bad native response' }; }
    cb(r);
  };

  RH.http = function (opts) {
    // opts: {method,url,headers,body,timeout}
    var req = {
      method: opts.method || 'GET', url: opts.url, headers: opts.headers || {},
      body: opts.body == null ? null : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)),
      timeout: opts.timeout || 60000
    };
    if (native) {
      return new Promise(function (resolve) {
        var id = 'h' + (++seq) + '_' + Date.now();
        pending[id] = resolve;
        native.http(id, JSON.stringify(req));
      });
    }
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, req.timeout) : null;
    return fetch(req.url, { method: req.method, headers: req.headers, body: req.body || undefined, signal: ctl && ctl.signal })
      .then(function (r) { return r.text().then(function (b) { return { status: r.status, body: b, url: r.url }; }); })
      .catch(function (e) { return { status: 0, error: String(e && e.message || e) }; })
      .finally(function () { if (t) clearTimeout(t); });
  };

  /** Read recent emails on the phone (IMAP, app password). Resolves {status, body|error}. */
  RH.mailFetch = function (cfg) {
    if (!native || !native.mailCheck) return Promise.resolve({ status: 0, error: 'Email checking works in the Android app only' });
    return new Promise(function (resolve) {
      var id = 'm' + (++seq) + '_' + Date.now();
      pending[id] = resolve;
      native.mailCheck(id, JSON.stringify(cfg));
    });
  };

  RH.httpJson = function (opts) {
    return RH.http(opts).then(function (r) {
      if (r.status < 200 || r.status >= 300) {
        var err = new Error('HTTP ' + r.status + (r.error ? ' ' + r.error : '') + (r.body ? ': ' + String(r.body).slice(0, 300) : ''));
        err.status = r.status; err.body = r.body;
        throw err;
      }
      try { return JSON.parse(r.body); } catch (e) { var er = new Error('Invalid JSON from ' + opts.url); er.status = r.status; throw er; }
    });
  };

  // ---------- storage (native files; localStorage fallback)
  var mem = {};
  function rawGet(k) {
    var raw = null;
    try { raw = native ? native.kvGet(k) : (g.localStorage ? localStorage.getItem('rh.' + k) : mem[k]); } catch (e) { raw = mem[k]; }
    return raw;
  }
  function rawSet(k, raw) {
    try { if (native) native.kvSet(k, raw); else if (g.localStorage) localStorage.setItem('rh.' + k, raw); else mem[k] = raw; }
    catch (e) { mem[k] = raw; }
  }
  function rawRemove(k) {
    try { if (native) native.kvRemove(k); else if (g.localStorage) localStorage.removeItem('rh.' + k); } catch (e) { }
    delete mem[k];
  }
  function parse(raw, def) {
    if (raw == null || raw === undefined) return def;
    try { return JSON.parse(raw); } catch (e) { return def; }
  }

  // ---------- accounts: several people (or very different job searches) on one phone.
  // Each account keeps its own CVs, profile, answers, tracker, email settings… under the key prefix "acct.<id>.".
  // The first account ("main") uses plain keys, so data from before accounts existed simply becomes that account.
  // Shared by all accounts: the server sign-in, AI provider keys, job-board caches and the native "cv.meta" handle.
  var PER_ACCOUNT = /^(profile$|answers$|memory$|tracker$|cvs$|accounts$|sites$|rank\.cache$|mail\.cfg$|jobs\.(queries|last|prefs|cvMode)$|cv\.(activeId$|meta\.web$|text|b64)|cover\.)/;
  var acctId = parse(rawGet('acct.current'), 'main') || 'main';
  function keyOf(k) { return acctId !== 'main' && PER_ACCOUNT.test(k) ? 'acct.' + acctId + '.' + k : k; }

  RH.store = {
    get: function (k, def) { return parse(rawGet(keyOf(k)), def); },
    set: function (k, v) { rawSet(keyOf(k), JSON.stringify(v)); },
    remove: function (k) { rawRemove(keyOf(k)); }
  };

  function accountList() {
    var l = parse(rawGet('acct.list'), null);
    if (!Array.isArray(l) || !l.length) l = [{ id: 'main', name: 'Me' }];
    return l;
  }
  function saveAccounts(l) { rawSet('acct.list', JSON.stringify(l)); }
  RH.account = {
    list: accountList,
    currentId: function () { return acctId; },
    current: function () { return accountList().filter(function (a) { return a.id === acctId; })[0] || { id: acctId, name: 'Me' }; },
    /** CV file slots on the phone are shared by all accounts, so non-main accounts prefix theirs. */
    slotPrefix: function () { return acctId === 'main' ? '' : acctId + '_'; },
    add: function (name) {
      var l = accountList(), id = 'a' + Date.now().toString(36);
      l.push({ id: id, name: String(name || '').trim().slice(0, 40) || 'Account ' + (l.length + 1) });
      saveAccounts(l); return id;
    },
    rename: function (id, name) {
      name = String(name || '').trim().slice(0, 40); if (!name) return;
      var l = accountList(); l.forEach(function (a) { if (a.id === id) a.name = name; }); saveAccounts(l);
    },
    /** Make another account current. The caller reloads the app so every screen starts from that account's data. */
    switchTo: function (id) {
      if (!accountList().some(function (a) { return a.id === id; })) return false;
      rawSet('acct.current', JSON.stringify(id));
      rawRemove('cv.meta'); // the native "attach my CV" handle must not point at another account's file
      acctId = id; return true;
    },
    /** Delete an account (not "main") and everything stored for it, including its CV files. */
    remove: function (id) {
      if (id === 'main') return false;
      var pre = 'acct.' + id + '.';
      var cvs = parse(rawGet(pre + 'cvs'), []) || [];
      cvs.forEach(function (c) {
        if (!c || !c.id) return;
        rawRemove(pre + 'cv.text.' + c.id); rawRemove(pre + 'cv.b64.' + c.id);
        if (native && native.deleteCvSlot) native.deleteCvSlot(c.id);
      });
      ['profile', 'answers', 'memory', 'tracker', 'cvs', 'accounts', 'sites', 'rank.cache', 'mail.cfg', 'jobs.queries', 'jobs.last', 'jobs.prefs', 'jobs.cvMode',
        'cv.activeId', 'cv.meta.web', 'cv.text', 'cv.b64'].forEach(function (k) { rawRemove(pre + k); });
      saveAccounts(accountList().filter(function (a) { return a.id !== id; }));
      if (acctId === id) RH.account.switchTo('main');
      return true;
    }
  };

  RH.nativeCall = function (name) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (native && typeof native[name] === 'function') return native[name].apply(native, args);
    if (RH.mockNative && RH.mockNative[name]) return RH.mockNative[name].apply(null, args);
    return undefined;
  };

  // ---------- helpers
  RH.util = {
    esc: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },
    stripHtml: function (html) {
      var s = String(html || '');
      if (typeof DOMParser !== 'undefined') {
        try {
          var d = new DOMParser().parseFromString('<div>' + s.replace(/<(br|\/p|\/li|\/h\d|\/div)[^>]*>/gi, '$&\n') + '</div>', 'text/html');
          return (d.body.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
        } catch (e) { }
      }
      return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    },
    /** Very small HTML sanitizer for job descriptions (allowlist of tags, no attributes except href). */
    safeHtml: function (html) {
      if (typeof DOMParser === 'undefined') return RH.util.esc(RH.util.stripHtml(html));
      var allowed = { P: 1, BR: 1, UL: 1, OL: 1, LI: 1, B: 1, STRONG: 1, I: 1, EM: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, A: 1, DIV: 1, SPAN: 1 };
      var src = String(html || '');
      if (!/<[a-z][\s\S]*>/i.test(src)) src = RH.util.esc(src).replace(/\n/g, '<br>');
      var doc = new DOMParser().parseFromString('<div id="r">' + src + '</div>', 'text/html');
      (function walk(n) {
        var kids = Array.prototype.slice.call(n.childNodes);
        kids.forEach(function (k) {
          if (k.nodeType === 1) {
            if (!allowed[k.tagName]) {
              if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|FORM|INPUT|BUTTON|IMG|SVG|VIDEO|AUDIO)$/.test(k.tagName)) { k.remove(); return; }
              walk(k);
              while (k.firstChild) n.insertBefore(k.firstChild, k);
              k.remove(); return;
            }
            var href = k.tagName === 'A' ? k.getAttribute('href') : null;
            Array.prototype.slice.call(k.attributes).forEach(function (a) { k.removeAttribute(a.name); });
            if (href && /^https?:/i.test(href)) { k.setAttribute('href', href); k.setAttribute('data-ext', '1'); }
            walk(k);
          } else if (k.nodeType !== 3) k.remove();
        });
      })(doc.getElementById('r'));
      return doc.getElementById('r').innerHTML;
    },
    ago: function (ts) {
      if (!ts) return '';
      var s = (Date.now() - ts) / 1000;
      if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
      if (s < 86400) return Math.round(s / 3600) + 'h ago';
      var d = Math.round(s / 86400);
      return d === 1 ? '1 day ago' : d + ' days ago';
    },
    uniq: function (arr) {
      var seen = {}, out = [];
      (arr || []).forEach(function (x) {
        var k = String(x || '').toLowerCase().trim();
        if (k && !seen[k]) { seen[k] = 1; out.push(String(x).trim()); }
      });
      return out;
    },
    norm: function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim(); },
    tokens: function (s) { return RH.util.norm(s).split(' ').filter(function (t) { return t.length > 1; }); },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    hash: function (s) {
      var h = 0; s = String(s);
      for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
      return (h >>> 0).toString(36);
    },
    pool: function (items, limit, fn) {
      var i = 0, results = new Array(items.length);
      function next() {
        if (i >= items.length) return Promise.resolve();
        var idx = i++;
        return Promise.resolve().then(function () { return fn(items[idx], idx); })
          .then(function (r) { results[idx] = r; }, function (e) { results[idx] = { error: e }; })
          .then(next);
      }
      var workers = []; for (var w = 0; w < Math.min(limit, items.length); w++) workers.push(next());
      return Promise.all(workers).then(function () { return results; });
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
