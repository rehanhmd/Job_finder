/* Fill planner: maps scanned form fields to profile data, remembered answers and AI-written answers. */
(function (g) {
  var RH = g.RH, U = RH.util;

  // Each rule: test against "label name placeholder autocomplete" (lower-case). First match wins.
  // `not`: the rule is skipped when this also matches (e.g. "Company name" is not your name).
  // value(ctx) returns a string (or array for checkbox groups) — empty string means "no answer".
  var RULES = [
    { key: 'resume', kinds: ['file'], re: /(resume|résumé|\bcv\b|curriculum)/, value: function () { return '__CV__'; } },
    { key: 'coverFile', kinds: ['file'], re: /cover/, value: function () { return ''; } },
    { key: 'firstName', re: /(first|given|fore)[ _-]?name|\bfname\b|given-name/, value: function (c) { return c.p.firstName; } },
    { key: 'lastName', re: /(last|family|sur)[ _-]?name|\blname\b|family-name/, value: function (c) { return c.p.lastName; } },
    { key: 'middleName', re: /middle[ _-]?name/, value: function () { return ''; } },
    { key: 'preferredName', re: /(preferred|nick)[ _-]?name/, value: function (c) { return c.p.firstName; } },
    { key: 'email', re: /e-?mail/, value: function (c) { return c.p.email; } },
    { key: 'years', re: /(years|yrs).{0,30}experience|experience.{0,20}(years|yrs)|how many years/, value: function (c) { return c.p.yearsExperience ? String(c.p.yearsExperience) : ''; } },
    // "cell" only as a word ("excellent" is not a phone field); "mobile" not when it means mobile apps/development
    { key: 'phone', re: /(phone|telephone|whatsapp|\btel\b|\bcell\b|\bmobile\b(?!\s*(app|apps|application|development|developer|dev|engineer|engineering|experience|platform|game|design|ui|ux)))/, value: function (c) { return c.p.phone; } },
    { key: 'linkedin', re: /linked ?in/, value: function (c) { return c.p.linkedin; } },
    { key: 'github', re: /git ?hub|gitlab/, value: function (c) { return c.p.github; } },
    { key: 'twitter', re: /(twitter|\bx\.com\b)/, value: function () { return ''; } },
    { key: 'portfolio', re: /(portfolio|personal (web)?site|website|blog|\burl\b|other link|homepage)/, value: function (c) { return c.p.portfolio || c.p.website || c.p.github || c.p.linkedin; } },
    { key: 'currentCompany', re: /(current|present|most recent) (company|employer|organi[sz]ation)|^company$|^employer$|^(current |present )?(company|employer)( name)?$|^name of (your )?(current |present )?(company|employer)$/, value: function (c) { return c.p.currentCompany; } },
    { key: 'fullName', re: /(full[ _-]?name|your name|^name\b|\bname$|legal name|^name \(|candidate name)/,
      not: /(compan|employer|school|universit|college|institut|referr|referee|reference|manager|supervisor|emergency|recruiter|organi[sz]ation|project|product|team|parent|guardian|spouse|business|brand|account|user ?name|file|nick|preferred|middle|pet|contact person|hiring|degree|course|program)/,
      value: function (c) { return c.p.fullName; } },
    { key: 'currentTitle', re: /(current|present|most recent) (title|role|position|job title)|^job title$|^title$/, value: function (c) { return c.p.currentTitle; } },
    { key: 'salary', re: /(salary|compensation|pay expectation|desired pay|expected (pay|rate|ctc)|\bctc\b|hourly rate|rate expectation)/, value: function (c) { return c.a.expectedSalary; } },
    { key: 'notice', re: /(notice period|how soon|earliest start|start date|when can you start|availability to start|available to start)/, value: function (c) { return c.f.kind === 'date' ? '' : (c.a.noticePeriod || c.a.availableFrom); } },
    // legal statements: filled only from your own Standard answers, never guessed by AI (see LEGAL)
    { key: 'sponsorship', re: /sponsor/, value: function (c) { return c.a.needsSponsorship; } },
    { key: 'authorized', re: /(authori[sz]ed|eligible|legally|right) to work|work (authori[sz]ation|permit)/, value: function (c) { return c.a.workAuthorization; } },
    { key: 'visa', re: /\bvisa\b|immigration status|citizenship|nationality/, value: function () { return ''; } },
    { key: 'relocate', re: /relocat/, value: function (c) { return c.a.willingToRelocate; } },
    { key: 'over18', re: /(18 years|over 18|at least 18|legal age)/, value: function (c) { return c.a.over18; } },
    { key: 'gender', re: /\bgender\b|\bsex\b/, value: function (c) { return c.a.gender; } },
    { key: 'pronouns', re: /pronoun/, value: function (c) { return c.a.pronouns; } },
    { key: 'ethnicity', re: /(race|ethnic|hispanic|latino)/, value: function (c) { return c.a.ethnicity; } },
    { key: 'veteran', re: /veteran|military/, value: function (c) { return c.a.veteran; } },
    { key: 'disability', re: /disabilit/, value: function (c) { return c.a.disability; } },
    { key: 'hear', re: /(hear about|how did you (find|learn|hear)|referr?al source|source of application|where did you)/, value: function (c) { return c.a.hearAbout; } },
    { key: 'timezone', re: /time ?zone/, value: function (c) { return c.a.timezone; } },
    { key: 'location', re: /(location|where (are you|do you) (live|reside)|current residence|based in)/, not: /countr|\bcity\b|\bstate\b|province|time ?zone/, value: function (c) { return c.p.location; } },
    { key: 'city', re: /\bcity\b|town/, value: function (c) { return c.p.city; } },
    { key: 'state', re: /\bstate\b|province|region/, not: /countr/, value: function (c) { return c.p.state; } },
    { key: 'country', re: /countr(y|ies)? ?(of residence)?$|^country|where are you (based|located)|country/, value: function (c) { return c.p.country; } },
    { key: 'zip', re: /(zip|postal|post code|postcode)/, value: function () { return ''; } },
    { key: 'address', re: /(street|address line|^address)/, value: function () { return ''; } },
    { key: 'school', re: /(school|university|college|institution)/, value: function (c) { return (c.p.education[0] || {}).school || ''; } },
    { key: 'degree', re: /\bdegree\b|qualification/, value: function (c) { return (c.p.education[0] || {}).degree || ''; } },
    { key: 'discipline', re: /(discipline|major|field of study)/, value: function (c) { return (c.p.education[0] || {}).field || ''; } },
    { key: 'gradYear', re: /(graduation|grad) (year|date)|year of graduation/, value: function (c) { return ((c.p.education[0] || {}).end || '').replace(/\D/g, '').slice(0, 4); } },
    { key: 'english', re: /english (level|proficiency)|proficien.{0,10}english|speak english/, value: function (c) { var l = (c.p.languages || []).filter(function (x) { return /english/i.test(x.language); })[0]; return l ? (l.level || 'Fluent') : ''; } },
    { key: 'remoteSetup', re: /(home office|internet connection|remote (setup|work environment)|work remotely)/, value: function (c) { return c.f.kind === 'radio' || c.f.kind === 'select' || c.f.kind === 'checkbox' ? 'Yes' : c.a.remoteSetup; } },
    { key: 'privacy', kinds: ['checkbox'], re: /(privacy|consent|agree|terms|gdpr|acknowledge|certify|confirm)/, value: function () { return ''; } } // leave consent to the user
  ];

  var DECLINE = /decline|prefer not|don.?t wish|do not wish|not to (say|answer|disclose)|choose not/i;
  var LEGAL = /^(sponsorship|authorized|visa)$/; // left for you when your Standard answers don't cover them

  function haystack(f) {
    return (f.label + ' ' + (f.name || '').replace(/[_\[\]-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2') + ' ' + (f.placeholder || '') + ' ' + (f.autocomplete || '')).toLowerCase();
  }
  function labelText(f) { return String(f.label || '').toLowerCase().replace(/[*:]+/g, ' ').replace(/\(required\)|\(optional\)/g, ' ').replace(/\s+/g, ' ').trim(); }
  function attrText(f) {
    return ((f.name || '').replace(/[_\[\]-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2') + ' ' + (f.placeholder || '') + ' ' + (f.autocomplete || '')).toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function findRule(f) {
    var texts = [labelText(f), attrText(f)];
    for (var t = 0; t < texts.length; t++) {
      if (!texts[t]) continue;
      for (var i = 0; i < RULES.length; i++) {
        var r = RULES[i];
        if (r.kinds && r.kinds.indexOf(f.kind) < 0) continue;
        if (!r.kinds && f.kind === 'file') continue;
        if (r.re.test(texts[t]) && !(r.not && r.not.test(texts[t]))) return r;
      }
    }
    return null;
  }

  function isOpenQuestion(f) {
    if (f.kind === 'textarea') return true;
    if (f.kind !== 'text' && f.kind !== 'email' && f.kind !== 'url' && f.kind !== 'tel' && f.kind !== 'number') return false;
    var l = f.label || '';
    return f.kind === 'text' && (/\?/.test(l) || l.split(/\s+/).length >= 6);
  }

  function similarity(a, b) {
    var ta = U.tokens(a), tb = U.tokens(b);
    if (!ta.length || !tb.length) return 0;
    var setB = {}; tb.forEach(function (t) { setB[t] = 1; });
    var inter = ta.filter(function (t) { return setB[t]; }).length;
    var union = U.uniq(ta.concat(tb)).length;
    return inter / union;
  }

  function memoryLookup(memory, f, company) {
    var best = null, bestS = 0, cur = U.norm(company || '');
    var longQ = U.tokens(f.label).length > 6;
    (memory || []).forEach(function (m) {
      var exact = U.norm(m.label) === U.norm(f.label);
      // long questions must match exactly: "Why do you want to work at Acme?" is not "...at Globex?"
      var s = exact ? 1 : (longQ ? 0 : similarity(m.label, f.label));
      if (s < 0.75) return;
      // an answer that names the company it was written for is never reused for another company
      var mc = U.norm(m.company || '');
      if (mc.length > 1 && mc !== cur && (' ' + U.norm(m.value) + ' ').indexOf(' ' + mc + ' ') >= 0) return;
      if (s > bestS) { bestS = s; best = m; }
    });
    if (best && bestS >= 0.75) {
      if ((f.kind === 'select' || f.kind === 'radio') && f.options && RH.fillplan.pickOption(f.options, best.value) < 0) return null;
      return best;
    }
    return null;
  }

  function pickOption(options, want) {
    // mirrors bestOption in the page agent
    var w = U.norm(want); if (!w) return -1;
    var best = -1, bestScore = 0;
    options.forEach(function (op, i) {
      var o = U.norm(op); if (!o) return;
      var s = 0;
      // whole words only: "No" must not pick "Not applicable" or "...sponsorship now"
      if (o === w) s = 100; else if ((o + ' ').indexOf(w + ' ') === 0 || (w + ' ').indexOf(o + ' ') === 0) s = 80;
      else if ((' ' + o + ' ').indexOf(' ' + w + ' ') >= 0 || (' ' + w + ' ').indexOf(' ' + o + ' ') >= 0) s = 60;
      else { var wt = w.split(' '), ot = o.split(' '), hit = wt.filter(function (t) { return t.length > 1 && ot.indexOf(t) >= 0; }).length; s = hit ? 20 + 30 * hit / Math.max(wt.length, ot.length) : 0; }
      if (s > bestScore) { bestScore = s; best = i; }
    });
    return bestScore >= 20 ? best : -1;
  }

  function placeholderOption(o) { return /^(select|choose|please|--|—|pick)/i.test(String(o).trim()) || !String(o).trim(); }

  /**
   * plan(fields, profile, answers, memory) -> {fills:[{id,kind,value,source}], ai:[field], skipped:[field]}
   * Deterministic part only; open questions go to `ai`.
   */
  function plan(fields, profile, answers, memory, company) {
    var p = Object.assign({ education: [], languages: [] }, profile || {});
    var a = Object.assign(RH.cv.defaultAnswers(), answers || {});
    var fills = [], ai = [], skipped = [];
    fields.forEach(function (f) {
      if (f.kind === 'checkbox' && f.value) { skipped.push(f); return; }
      if (f.kind !== 'file' && f.kind !== 'checkbox' && f.value && String(f.value).trim() && f.kind !== 'select' && f.kind !== 'radio') { skipped.push(f); return; }
      if ((f.kind === 'select' || f.kind === 'radio') && f.value && !placeholderOption(f.value)) { skipped.push(f); return; }
      if (f.kind === 'file' && f.value) { skipped.push(f); return; }
      var hay = haystack(f);
      var ctx = { p: p, a: a, f: f };
      // 1) remembered answer for this exact question
      var mem = f.kind !== 'file' ? memoryLookup(memory, f, company) : null;
      if (mem && !/^(email|phone|first|last|full)/.test(hay)) {
        fills.push({ id: f.id, kind: f.kind, value: mem.value, source: 'memory', label: f.label });
        return;
      }
      // 2) rules
      var rule = findRule(f);
      // long free-text questions that merely mention e.g. "location" should go to AI instead
      if (rule && f.kind === 'textarea' && ['resume', 'privacy'].indexOf(rule.key) < 0 && !/^(address|location|salary|notice)$/.test(rule.key)) rule = null;
      if (rule && rule.key === 'coverLetter') rule = null;
      if (rule) {
        var v = rule.value(ctx);
        if (f.kind === 'file') {
          if (v === '__CV__') fills.push({ id: f.id, kind: 'file', value: '', source: 'cv', label: f.label });
          else skipped.push(f);
          return;
        }
        if ((f.kind === 'select' || f.kind === 'radio' || f.kind === 'checkboxgroup') && f.options) {
          var opts = f.options;
          var idx = v ? pickOption(opts, v) : -1;
          if (idx < 0 && /^(gender|ethnicity|veteran|disability|pronouns)$/.test(rule.key)) {
            idx = opts.findIndex(function (o) { return DECLINE.test(o); });
          }
          if (idx < 0 && /^(sponsorship|authorized|relocate|over18|remoteSetup)$/.test(rule.key) && v) {
            var yes = /^(yes|y|true)/i.test(v), no = /^(no|n|false)/i.test(v);
            idx = opts.findIndex(function (o) { return yes ? /^yes\b/i.test(o) : no ? /^no\b/i.test(o) : false; });
          }
          if (idx >= 0 && !placeholderOption(opts[idx])) { fills.push({ id: f.id, kind: f.kind, value: opts[idx], source: 'profile', label: f.label }); return; }
          if (LEGAL.test(rule.key)) { skipped.push(f); return; }
          ai.push(f); return;
        }
        if (f.kind === 'checkbox') { skipped.push(f); return; }
        if (v) { fills.push({ id: f.id, kind: f.kind, value: String(v), source: 'profile', label: f.label }); return; }
        if (/^(salary|years|notice|english|remoteSetup)$/.test(rule.key)) { ai.push(f); return; }
        skipped.push(f); return;
      }
      if (f.kind === 'file') { skipped.push(f); return; }
      if (f.kind === 'checkbox') { skipped.push(f); return; }
      // 3) cover letter / open-ended / unknown choice → AI
      if (/cover ?letter|motivation/.test(hay) || isOpenQuestion(f) || ((f.kind === 'select' || f.kind === 'radio' || f.kind === 'checkboxgroup') && f.options && f.options.length)) {
        ai.push(f); return;
      }
      if (f.kind === 'text' && f.required) { ai.push(f); return; }
      skipped.push(f);
    });
    return { fills: fills, ai: ai, skipped: skipped };
  }

  function profileBrief(p) {
    return {
      name: p.fullName, headline: p.headline, summary: p.summary, location: p.location, years: p.yearsExperience,
      currentTitle: p.currentTitle, currentCompany: p.currentCompany, skills: (p.skills || []).slice(0, 30),
      experience: (p.experience || []).slice(0, 5), education: (p.education || []).slice(0, 3),
      languages: p.languages, certifications: p.certifications, achievements: p.achievements, strengths: p.strengths,
      links: { linkedin: p.linkedin, github: p.github, website: p.website || p.portfolio }
    };
  }

  /** Ask AI to answer the open questions / unresolved choices in one go. */
  function aiAnswers(aiFields, profile, answers, job, pageTitle, memory) {
    if (!aiFields.length) return Promise.resolve([]);
    var qs = aiFields.slice(0, 25).map(function (f, i) {
      var q = { i: i, question: f.label || f.placeholder || f.name, type: f.kind, required: !!f.required };
      if (f.options) q.options = f.options.filter(function (o) { return !placeholderOption(o); }).slice(0, 40);
      if (f.maxLength) q.maxChars = f.maxLength;
      return q;
    });
    var jobInfo = job ? { title: job.title, company: job.company, description: U.stripHtml(job.description).slice(0, 3500) } : { page: pageTitle };
    var prompt = 'Fill in a job application on behalf of the candidate. Write in first person as the candidate, natural and specific, using only facts from the profile ' +
      '(never invent employers, degrees, numbers or contact details).\n' +
      '- For "select"/"radio" questions return exactly one of the given options (copy the text). For "checkboxgroup" return an array of options.\n' +
      '- For short text fields return a short value. For textareas / open questions write 60-180 words unless maxChars is smaller. Cover letters: 150-250 words.\n' +
      '- For demographic / EEO questions choose the "decline / prefer not to say" option if present.\n' +
      '- If you truly cannot answer from the profile (e.g. an ID number), return "" for that item.\n' +
      (RH.voice ? RH.voice.styleBlock(memory, answers) : '') + '\n' +
      'Candidate profile: ' + JSON.stringify(profileBrief(profile)) + '\n' +
      'Candidate preferences: ' + JSON.stringify(Object.assign({}, answers || {}, { writingSample: undefined })) + '\n' +
      'Job: ' + JSON.stringify(jobInfo) + '\n\n' +
      'Questions: ' + JSON.stringify(qs) + '\n\n' +
      'Return JSON: {"answers":[{"i":0,"value":"..."}]}';
    return RH.ai.chatJson(prompt, { system: 'You help a job seeker fill in their own applications. You write the way they write: plain, specific, human. Never sound like a template or a chatbot.', maxTokens: 6000, temperature: 0.7 })
      .then(function (res) {
        var list = (res && (res.answers || res.results)) || (Array.isArray(res) ? res : []);
        var out = [];
        list.forEach(function (r) {
          var f = aiFields[Number(r.i)];
          if (!f) return;
          var v = r.value;
          if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
          if (f.kind === 'select' || f.kind === 'radio') {
            var idx = pickOption(f.options || [], Array.isArray(v) ? v[0] : v);
            if (idx < 0 || placeholderOption(f.options[idx])) return;
            v = f.options[idx];
          }
          if (f.kind !== 'checkboxgroup' && Array.isArray(v)) v = v.join(', ');
          if (RH.voice && typeof v === 'string' && (f.kind === 'textarea' || (f.kind === 'text' && v.length > 60))) v = RH.voice.humanize(v);
          out.push({ id: f.id, kind: f.kind, value: v, source: 'ai', label: f.label });
        });
        return out;
      });
  }

  /** Merge captured answers into memory (skip things already in the profile). */
  function remember(memory, items, profile, company) {
    var co = company ? String(company).slice(0, 80) : '';
    memory = (memory || []).slice();
    var p = profile || {};
    var known = [p.email, p.phone, p.firstName, p.lastName, p.fullName].filter(Boolean).map(U.norm);
    var added = 0;
    items.forEach(function (it) {
      var v = Array.isArray(it.value) ? it.value.join(', ') : String(it.value || '');
      if (!it.label || !v.trim() || v.length > 4000) return;
      if (known.indexOf(U.norm(v)) >= 0) return;
      if (/^(select|choose)/i.test(v)) return;
      var ex = memory.filter(function (m) { return U.norm(m.label) === U.norm(it.label); })[0];
      if (ex) { if (ex.value !== v) { ex.value = v; ex.at = Date.now(); ex.company = co; added++; } }
      else { memory.push({ label: it.label.slice(0, 300), value: v, kind: it.kind, company: co, at: Date.now() }); added++; }
    });
    if (memory.length > 400) memory = memory.slice(memory.length - 400);
    return { memory: memory, added: added };
  }

  RH.fillplan = { plan: plan, aiAnswers: aiAnswers, remember: remember, pickOption: pickOption, isOpenQuestion: isOpenQuestion, similarity: similarity, RULES: RULES };
})(typeof window !== 'undefined' ? window : globalThis);
