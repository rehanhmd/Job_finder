/* AI client: OpenAI-compatible chat across free-tier providers with automatic fallback. */
(function (g) {
  var RH = g.RH;

  // Built-in relay: YOUR Cloudflare Worker (server/, deployed with `wrangler deploy`).
  var BUILTIN_URL = 'https://remotehunt-personal.hunt-job.workers.dev/v1';
  function authToken() { var a = RH.store.get('auth', null); return (a && a.token) || ''; }

  var PROVIDERS = {
    builtin: {
      name: 'Built-in AI (free)', base: BUILTIN_URL, model: 'auto', keyUrl: '', maxTokens: 4096, builtin: true,
      prefer: [], note: 'Works out of the box — no key needed. Shared free daily allowance.'
    },
    gemini: {
      name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-flash-latest', keyUrl: 'https://aistudio.google.com/apikey', maxTokens: 8192,
      prefer: [/^(models\/)?gemini-flash-latest$/, /gemini-[\d.]+-flash$/, /flash-lite-latest/, /gemini-[\d.]+-flash-lite$/, /flash/],
      note: 'Best free option. Free key from Google AI Studio.'
    },
    groq: {
      name: 'Groq', base: 'https://api.groq.com/openai/v1',
      model: 'openai/gpt-oss-120b', keyUrl: 'https://console.groq.com/keys', maxTokens: 6000,
      prefer: [/gpt-oss-120b/, /llama-3\.3-70b/, /qwen.*32b/, /gpt-oss-20b/, /llama/],
      note: 'Very fast, generous free tier.'
    },
    openrouter: {
      name: 'OpenRouter', base: 'https://openrouter.ai/api/v1',
      model: 'openrouter/free', keyUrl: 'https://openrouter.ai/keys', maxTokens: 6000,
      prefer: [/^openrouter\/free$/, /:free$/],
      note: 'Routes to free models (IDs ending in :free).'
    },
    mistral: {
      name: 'Mistral', base: 'https://api.mistral.ai/v1',
      model: 'mistral-small-latest', keyUrl: 'https://console.mistral.ai/api-keys', maxTokens: 6000,
      prefer: [/^mistral-small-latest$/, /^mistral-medium-latest$/, /^mistral-large-latest$/, /small/],
      note: 'Free "Experiment" plan.'
    },
    cerebras: {
      name: 'Cerebras', base: 'https://api.cerebras.ai/v1',
      model: 'gpt-oss-120b', keyUrl: 'https://cloud.cerebras.ai', maxTokens: 3000, smallContext: true,
      prefer: [/gpt-oss-120b/, /llama-3\.3-70b/, /qwen/, /llama/],
      note: 'Fast; free/trial limits and a small context window.'
    },
    custom: {
      name: 'Custom (OpenAI-compatible)', base: '', model: '', keyUrl: '', maxTokens: 4000,
      prefer: [], note: 'Any OpenAI-compatible endpoint (e.g. Together, DeepInfra, local Ollama via tunnel).'
    }
  };
  var ORDER = ['builtin', 'gemini', 'groq', 'openrouter', 'mistral', 'cerebras', 'custom'];

  var cooldown = {}; // provider -> timestamp until which it is skipped
  var lastUsed = null;

  function settings() {
    var s = RH.store.get('ai.settings', null) || {};
    s.providers = s.providers || {};
    s.order = (s.order && s.order.length) ? s.order : ORDER.slice();
    ORDER.forEach(function (id) {
      if (s.order.indexOf(id) < 0) s.order.push(id);
      var p = s.providers[id] = s.providers[id] || {};
      if (p.enabled === undefined) p.enabled = true;
      if (!p.model) p.model = PROVIDERS[id].model;
      if (id === 'custom' && !p.base) p.base = '';
      if (id === 'builtin') { p.key = authToken(); p.model = 'auto'; }
    });
    return s;
  }
  function saveSettings(s) { RH.store.set('ai.settings', s); }

  function active(s) {
    s = s || settings();
    var ids = s.order.filter(function (id) {
      var p = s.providers[id];
      return p && p.enabled && p.key && p.key.trim() && (id !== 'custom' || /^https:\/\//i.test(p.base || '')) && (id !== 'builtin' || !/REPLACE_ME/.test(BUILTIN_URL));
    });
    // the user's own keys go first; the shared built-in AI is the safety net
    var own = ids.filter(function (id) { return id !== 'builtin'; });
    return own.concat(ids.filter(function (id) { return id === 'builtin'; }));
  }

  function deviceId() {
    var nat = RH.nativeCall('deviceId');
    if (nat) return nat;
    var d = RH.store.get('device.id', null);
    if (!d) { d = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); RH.store.set('device.id', d); }
    return d;
  }

  function baseOf(id, p) { return (id === 'custom' ? p.base : PROVIDERS[id].base).replace(/\/+$/, ''); }

  function headers(id, key) {
    var h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key.trim() };
    if (id === 'openrouter') { h['HTTP-Referer'] = 'https://remotehunt.app'; h['X-Title'] = 'RemoteHunt'; }
    if (id === 'builtin') h['X-RH-Device'] = deviceId();
    return h;
  }

  function listModels(id, p) {
    return RH.httpJson({ url: baseOf(id, p) + '/models', headers: headers(id, p.key), timeout: 30000 })
      .then(function (j) {
        var arr = j.data || j.models || [];
        return arr.map(function (m) { return String(m.id || m.name || '').replace(/^models\//, ''); }).filter(Boolean);
      });
  }

  function pickModel(id, ids) {
    var pref = PROVIDERS[id].prefer || [];
    var bad = /(embed|tts|audio|image|vision-only|whisper|guard|moderation|realtime|live|transcribe|veo|imagen|lyria|aqa|robotics|computer)/i;
    var usable = ids.filter(function (x) { return !bad.test(x); });
    for (var i = 0; i < pref.length; i++) {
      for (var j = 0; j < usable.length; j++) if (pref[i].test(usable[j])) return usable[j];
    }
    return usable[0] || null;
  }

  function stripThinking(s) {
    return String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*<think>[\s\S]*$/i, '').trim();
  }

  /** Extract the first JSON object/array from a model reply. */
  function parseJson(text) {
    var s = stripThinking(text);
    var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1];
    try { return JSON.parse(s); } catch (e) { }
    var start = -1;
    for (var i = 0; i < s.length; i++) { if (s[i] === '{' || s[i] === '[') { start = i; break; } }
    if (start < 0) throw new Error('AI reply had no JSON');
    var open = s[start], close = open === '{' ? '}' : ']', depth = 0, inStr = false, esc = false;
    for (var k = start; k < s.length; k++) {
      var c = s[k];
      if (inStr) {
        if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          var chunk = s.slice(start, k + 1);
          try { return JSON.parse(chunk); }
          catch (e2) { return JSON.parse(chunk.replace(/,\s*([}\]])/g, '$1')); }
        }
      }
    }
    // truncated JSON: try closing it
    var tail = s.slice(start).replace(/,\s*$/, '');
    var stack = [];
    inStr = false; esc = false;
    for (var m = 0; m < tail.length; m++) {
      var ch = tail[m];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === '{') stack.push('}'); else if (ch === '[') stack.push(']'); else if (ch === '}' || ch === ']') stack.pop();
    }
    if (inStr) tail += '"';
    tail = tail.replace(/,\s*$/, '').replace(/:\s*$/, ': null');
    return JSON.parse(tail + stack.reverse().join(''));
  }

  function callOnce(id, p, messages, opts) {
    var body = {
      model: p.model,
      messages: messages,
      temperature: opts.temperature == null ? 0.3 : opts.temperature,
      max_tokens: Math.min(opts.maxTokens || 4000, PROVIDERS[id].maxTokens || 4000)
    };
    if (PROVIDERS[id].smallContext) {
      // keep prompts within ~8k tokens
      body.messages = messages.map(function (m) { return { role: m.role, content: String(m.content).slice(0, 14000) }; });
    }
    return RH.http({ method: 'POST', url: baseOf(id, p) + '/chat/completions', headers: headers(id, p.key), body: body, timeout: opts.timeout || 120000 })
      .then(function (r) {
        var j = null;
        try { j = JSON.parse(r.body); } catch (e) { }
        if (r.status >= 200 && r.status < 300 && j && j.choices && j.choices[0]) {
          var msg = j.choices[0].message || {};
          var content = msg.content;
          if (Array.isArray(content)) content = content.map(function (c) { return c.text || ''; }).join('');
          content = stripThinking(content || '');
          if (!content) {
            var e0 = new Error('Empty reply (finish: ' + (j.choices[0].finish_reason || '?') + ')'); e0.status = 502; throw e0;
          }
          return content;
        }
        var msgTxt = (j && j.error && (j.error.message || j.error)) || r.error || (r.body || '').slice(0, 200);
        if (typeof msgTxt === 'object') msgTxt = JSON.stringify(msgTxt);
        if (id === 'builtin' && r.status === 401 && RH.onAuthLost) RH.onAuthLost(msgTxt);
        var err = new Error(PROVIDERS[id].name + ': ' + (r.status ? 'HTTP ' + r.status + ' ' : '') + msgTxt);
        err.status = r.status;
        err.retryAfter = 0;
        var m = /retry in ([\d.]+)s/i.exec(msgTxt || '');
        if (m) err.retryAfter = parseFloat(m[1]);
        throw err;
      });
  }

  function isModelError(e) {
    return e.status === 404 || (e.status === 400 && /model/i.test(e.message) && /(not|invalid|unknown|exist|support|decommission)/i.test(e.message));
  }

  /**
   * chat(messages, opts) -> Promise<string>
   * Tries each enabled provider in order. Rate-limited/failed providers are cooled down and skipped.
   */
  function chat(messages, opts) {
    opts = opts || {};
    if (typeof messages === 'string') messages = [{ role: 'user', content: messages }];
    if (opts.system) messages = [{ role: 'system', content: opts.system }].concat(messages);
    var s = settings();
    var ids = active(s);
    if (!ids.length) return Promise.reject(Object.assign(new Error('No AI provider configured. Add a free API key in Settings.'), { noProvider: true }));
    var now = Date.now();
    var ready = ids.filter(function (id) { return !(cooldown[id] > now); });
    if (!ready.length) ready = ids; // all cooling down: try anyway
    var errors = [];
    var idx = 0;
    function attempt() {
      if (idx >= ready.length) {
        var e = new Error(errors.map(function (x) { return x.message; }).join(' | ') || 'All AI providers failed');
        e.all = errors;
        return Promise.reject(e);
      }
      var id = ready[idx], p = s.providers[id];
      return callOnce(id, p, messages, opts).then(function (txt) {
        lastUsed = { id: id, model: p.model, at: Date.now() };
        return txt;
      }, function (e) {
        if (isModelError(e) && !p._retriedModel && id !== 'builtin') {
          // model retired? discover what's available and retry once
          p._retriedModel = true;
          return listModels(id, p).then(function (list) {
            var m = pickModel(id, list);
            if (m && m !== p.model) {
              var s2 = settings(); s2.providers[id].model = m; saveSettings(s2);
              p.model = m;
              return callOnce(id, p, messages, opts).then(function (txt) { lastUsed = { id: id, model: m, at: Date.now() }; return txt; });
            }
            throw e;
          }).catch(function (e2) { errors.push(e2); idx++; return attempt(); });
        }
        errors.push(e);
        if (e.status === 429 || e.status >= 500 || e.status === 0) {
          cooldown[id] = Date.now() + Math.max(20, e.retryAfter || 60) * 1000;
        }
        if (e.status === 401 || e.status === 403) cooldown[id] = Date.now() + 10 * 60 * 1000;
        if (id === 'builtin' && e.status === 429 && /daily/i.test(e.message)) { var mid = new Date(); mid.setUTCHours(24, 0, 0, 0); cooldown[id] = mid.getTime(); }
        idx++;
        return attempt();
      });
    }
    return attempt();
  }

  function chatJson(messages, opts) {
    opts = opts || {};
    var sys = (opts.system ? opts.system + '\n\n' : '') + 'Reply with valid JSON only. No markdown, no commentary.';
    var o = Object.assign({}, opts, { system: sys, temperature: opts.temperature == null ? 0.2 : opts.temperature });
    return chat(messages, o).then(function (txt) {
      try { return parseJson(txt); }
      catch (e) {
        // one repair attempt
        return chat([{ role: 'user', content: 'Convert this to valid JSON only, keeping the same content:\n\n' + txt.slice(0, 12000) }], o).then(parseJson);
      }
    });
  }

  function testProvider(id) {
    var s = settings(), p = s.providers[id];
    if (!p.key) return Promise.reject(new Error('Enter an API key first'));
    p._retriedModel = false;
    return callOnce(id, p, [{ role: 'user', content: 'Reply with the single word: OK' }], { maxTokens: 400, timeout: 45000 })
      .catch(function (e) {
        if (isModelError(e)) {
          return listModels(id, p).then(function (list) {
            var m = pickModel(id, list);
            if (!m) throw e;
            s.providers[id].model = m; saveSettings(s); p.model = m;
            return callOnce(id, p, [{ role: 'user', content: 'Reply with the single word: OK' }], { maxTokens: 400 });
          });
        }
        throw e;
      })
      .then(function (txt) { return { ok: true, model: p.model, reply: txt.slice(0, 60) }; });
  }

  RH.ai = {
    PROVIDERS: PROVIDERS, ORDER: ORDER,
    settings: settings, saveSettings: saveSettings, active: active,
    chat: chat, chatJson: chatJson, parseJson: parseJson,
    listModels: function (id) { var s = settings(); return listModels(id, s.providers[id]); },
    pickModel: pickModel, testProvider: testProvider,
    available: function () { return active().length > 0; },
    lastUsed: function () { return lastUsed; },
    builtinUrl: function () { return BUILTIN_URL; },
    builtinToken: authToken,
    relayReady: function () { return !/REPLACE_ME/.test(BUILTIN_URL) && !!authToken(); },
    relayUrl: function () { return BUILTIN_URL; },
    deviceId: deviceId,
    _cooldown: cooldown
  };
})(typeof window !== 'undefined' ? window : globalThis);
