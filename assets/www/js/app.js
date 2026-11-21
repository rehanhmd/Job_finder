/* RemoteHunt app: screens, state and the autofill orchestration. */
(function (g) {
  var RH = g.RH, U = RH.util, esc = U.esc, $ = function (s, r) { return (r || document).querySelector(s); };

  var S = {
    tab: 'profile',
    profile: RH.store.get('profile', null),
    answers: Object.assign(RH.cv.defaultAnswers(), RH.store.get('answers', {})),
    memory: RH.store.get('memory', []),
    cvMeta: null,
    analyzing: '', analyzeError: '', analyzeNote: '',
    queries: RH.store.get('jobs.queries', null),
    search: { running: false, stage: '', stats: {}, done: 0, total: 0, result: RH.store.get('jobs.last', null) },
    showCount: 30,
    tracker: RH.store.get('tracker', {}),
    trackerSeg: 'all',
    sheetJob: null,
    applyJob: null,
    aiCache: {},
    lastFill: null
  };
  RH.state = S;

  // ---------------- several CVs: S.cvs = [{id, label, meta, profile, at}], one of them is "active" (being edited)
  var SHARED = ['fullName', 'firstName', 'lastName', 'email', 'phone', 'location', 'city', 'state', 'country', 'linkedin', 'github', 'website', 'portfolio'];
  function saveCvs() { RH.store.set('cvs', S.cvs); }
  function cvById(id) { return S.cvs.filter(function (c) { return c.id === id; })[0] || null; }
  function activeCv() { return cvById(S.activeCv) || S.cvs[0] || null; }
  function cvLabel(c, i) {
    if (!c) return '';
    if (i == null) i = S.cvs.indexOf(c);
    return c.label || (c.profile && ((c.profile.targetRoles || [])[0] || c.profile.currentTitle)) || ('CV ' + (i + 1));
  }
  function syncActive() {
    var c = activeCv();
    S.cvMeta = c ? c.meta : null; S.profile = c ? c.profile : null;
    if (c) { S.activeCv = c.id; RH.store.set('cv.activeId', c.id); RH.store.set('cv.meta', c.meta); }
    RH.store.set('profile', S.profile);
  }
  function loadCvMeta() {
    S.cvs = RH.store.get('cvs', null);
    if (!S.cvs) { // migrate from the single-CV version
      var m = null, raw = RH.nativeCall('cvMeta');
      if (raw) { try { m = JSON.parse(raw); } catch (e) { m = null; } } else m = RH.store.get('cv.meta.web', null);
      S.cvs = m ? [{ id: m.slot || 'main', label: '', meta: m, profile: S.profile, at: m.savedAt || Date.now() }] : [];
      if (m && !RH.isNative) { var b = RH.store.get('cv.b64', null); if (b) RH.store.set('cv.b64.' + S.cvs[0].id, b); }
      saveCvs();
    }
    S.activeCv = RH.store.get('cv.activeId', S.cvs[0] && S.cvs[0].id);
    S.searchCv = RH.store.get('jobs.cvMode', 'active');
    syncActive();
  }
  function cvB64(c) {
    c = c || activeCv(); if (!c) return null;
    if (RH.isNative) return (c.meta && c.meta.path && RH.nativeCall('cvBase64Path', c.meta.path)) || null;
    return RH.store.get('cv.b64.' + c.id, null);
  }
  function useCv(id) {
    if (S.profile) saveProfileForm(true);
    S.activeCv = id; syncActive();
    S.queries = ((S.profile && S.profile.searchKeywords) || []).slice(0, 4); RH.store.set('jobs.queries', S.queries);
  }
  /** Profile used for searching: the active CV, or all CVs merged (mode "all"). */
  function searchSetup() {
    var ready = S.cvs.filter(function (c) { return c.profile; });
    if (S.searchCv !== 'all' || ready.length < 2) return { profile: S.profile, cvs: null };
    var base = Object.assign({}, S.profile || ready[0].profile);
    ['skills', 'tools', 'targetRoles', 'searchKeywords'].forEach(function (k) {
      base[k] = U.uniq([].concat.apply([], ready.map(function (c) { return c.profile[k] || []; })));
    });
    return { profile: base, cvs: ready.map(function (c) { return { id: c.id, label: cvLabel(c), profile: c.profile }; }) };
  }
  function saveTracker() { RH.store.set('tracker', S.tracker); }
  function queries() {
    if (S.queries && S.queries.length) return S.queries;
    if (S.searchCv === 'all' && S.cvs.length > 1) return U.uniq([].concat.apply([], S.cvs.map(function (c) { return ((c.profile && c.profile.searchKeywords) || []).slice(0, 2); }))).slice(0, 6);
    return ((S.profile && S.profile.searchKeywords) || []).slice(0, 4);
  }

  // ------------------------------------------------------------------ toast / modal / sheet
  var toastT;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  RH.toast = toast;

  function modal(html) {
    closeModal();
    var bg = document.createElement('div');
    bg.className = 'modal-bg'; bg.id = 'modal';
    bg.innerHTML = '<div class="modal">' + html + '</div>';
    bg.addEventListener('click', function (e) { if (e.target === bg) closeModal(); });
    document.body.appendChild(bg);
    return bg;
  }
  function closeModal() { var m = $('#modal'); if (m) m.remove(); }

  function openSheet(html) {
    var sh = $('#sheet'); sh.innerHTML = html; sh.hidden = false; sh.scrollTop = 0;
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() { var sh = $('#sheet'); sh.hidden = true; sh.innerHTML = ''; S.sheetJob = null; document.body.style.overflow = ''; }

  RH.onBack = function () {
    if ($('#modal')) { closeModal(); return true; }
    if (!$('#sheet').hidden) { closeSheet(); render(); return true; }
    if (S.tab !== 'profile' && S.tab !== 'jobs') { go('jobs'); return true; }
    return false;
  };

  // ------------------------------------------------------------------ header + tabs
  function renderBadge() {
    var b = $('#aiBadge'), act = RH.ai.active();
    if (act.length) {
      var lu = RH.ai.lastUsed();
      b.className = 'on';
      var nm = function (id) { return id === 'builtin' ? 'Built-in' : RH.ai.PROVIDERS[id].name.replace('Google ', '').replace(/ \(.*/, ''); };
      b.textContent = 'AI ✓ ' + (lu ? nm(lu.id) : nm(act[0])) + (act.length > 1 ? ' +' + (act.length - 1) : '');
    } else { b.className = 'off'; b.textContent = 'AI not set up'; }
    b.onclick = function () { go('settings'); };
    var n = Object.keys(S.tracker).length;
    var tb = $('#tabs [data-tab=tracker]');
    var d = tb.querySelector('.dot');
    if (n) { if (!d) { d = document.createElement('span'); d.className = 'dot'; tb.appendChild(d); } d.textContent = n; } else if (d) d.remove();
    var nn = RH.sites.newCount(), jb = $('#tabs [data-tab=jobs]'), jd = jb && jb.querySelector('.dot');
    if (jb) { if (nn) { if (!jd) { jd = document.createElement('span'); jd.className = 'dot'; jb.appendChild(jd); } jd.textContent = nn; } else if (jd) jd.remove(); }
  }

  function go(tab) { S.tab = tab; closeSheet(); render(); window.scrollTo(0, 0); }

  // ------------------------------------------------------------------ ACCOUNTS (several people / job searches on one phone)
  function initials(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '?'; }
  function renderAcct() {
    var b = $('#acctBtn'); if (!b) return;
    var a = RH.account.current();
    b.innerHTML = '<span class="av">' + esc(initials(a.name)) + '</span><span class="nm">' + esc(a.name) + '</span>';
  }
  function viewAccounts(msg) {
    var cur = RH.account.currentId();
    var h = '<h3>Accounts</h3><p class="muted small">Each account has its own CVs, answers, job tracker and email settings. AI and job search are shared.</p><div class="acct-list">';
    RH.account.list().forEach(function (a) {
      h += '<div class="acct-row' + (a.id === cur ? ' on' : '') + '"><span class="av">' + esc(initials(a.name)) + '</span><b class="grow">' + esc(a.name) + '</b>' +
        (a.id === cur ? '<span class="muted small">Current</span>' : '<button class="btn sm primary" data-act="acctSwitch" data-id="' + esc(a.id) + '">Switch</button>') + '</div>';
    });
    h += '</div><input id="acctName" maxlength="40" placeholder="Name, e.g. Rahul or Data jobs">' +
      (msg ? '<div class="sp"></div><div class="note err">' + esc(msg) + '</div>' : '') +
      '<div class="sp"></div><div class="row"><button class="btn sm primary" data-act="acctAdd">+ Add account</button><button class="btn sm" data-act="acctRename">Rename current</button><div class="grow"></div>' +
      (cur !== 'main' ? '<button class="btn sm danger" data-act="acctDelete">Delete</button>' : '') + '<button class="btn sm ghost" data-act="closeModal">Close</button></div>';
    return h;
  }
  function switchAccount(id) {
    if (!RH.account.switchTo(id)) return;
    RH.nativeCall('closeApply');
    location.reload(); // every screen starts again from the new account's data
  }

  // ------------------------------------------------------------------ ACCESS
  // This personal build carries its access code (js/config.js) and signs in by itself. The code screen only
  // appears if that code stops matching the server (e.g. ACCESS_CODE was changed) or there is no built-in code.
  var AUTO_CODE = (RH.config && RH.config.accessCode) || '';
  function isLocked() { var a = RH.store.get('auth', null); return !(a && a.token); }
  function viewLock() {
    if (AUTO_CODE && !S.manualCode) {
      return '<div class="lock"><div class="logo-big"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg></div>' +
        '<h1>' + (S.lockMsg ? 'Can\'t reach your server' : 'Connecting…') + '</h1>' +
        (S.lockMsg ? '<div class="note err">' + esc(S.lockMsg) + '</div><div class="sp"></div><button class="btn primary block" data-act="autoUnlock">Try again</button>'
          : '<p class="muted"><span class="spin"></span> Signing in to your RemoteHunt server…</p>') + '</div>';
    }
    return '<div class="lock"><div class="logo-big"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg></div>' +
      '<h1>Private access</h1><p class="muted">RemoteHunt is invite-only. Enter the access code you were given to unlock the app on this phone.</p>' +
      '<input id="codeIn" class="code-in" placeholder="RH-XXXXX-XXXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16" value="' + esc(S.codeDraft || '') + '">' +
      '<div class="sp"></div><button class="btn primary block" data-act="verifyCode"' + (S.verifying ? ' disabled' : '') + '>' + (S.verifying ? '<span class="spin"></span> Verifying…' : 'Verify & unlock') + '</button>' +
      (S.lockMsg ? '<div class="sp"></div><div class="note err">' + esc(S.lockMsg) + '</div>' : '') +
      '<p class="muted tiny" style="margin-top:22px">Each code works on one phone only. No code? Ask the person who shared RemoteHunt with you.</p></div>';
  }
  function verifyCode(auto) {
    auto = auto === true;
    var code;
    if (auto) { code = AUTO_CODE; S.lastAuto = Date.now(); }
    else {
      var inp = $('#codeIn'); code = (inp ? inp.value : '').trim();
      S.codeDraft = code;
      if (code.replace(/[^A-Za-z0-9]/g, '').length < 12) { S.lockMsg = 'Enter the full code, like RH-ABCDE-FGHJK.'; render(); return; }
    }
    S.verifying = true; S.lockMsg = ''; render();
    RH.http({ method: 'POST', url: RH.ai.relayUrl() + '/activate', headers: { 'Content-Type': 'application/json' },
      body: { code: code, device: RH.ai.deviceId(), model: RH.nativeCall('deviceModel') || navigator.userAgent.slice(0, 60) }, timeout: 30000 })
      .then(function (r) {
        var j = null; try { j = JSON.parse(r.body); } catch (e) { }
        S.verifying = false;
        if (r.status === 200 && j && j.token) {
          RH.store.set('auth', { token: j.token, code: code.toUpperCase(), name: j.name || '', at: Date.now() });
          S.codeDraft = ''; S.lockMsg = ''; S.manualCode = false; render();
          if (!auto) toast('Unlocked ✓');
          return;
        }
        S.lockMsg = (j && j.error && j.error.message) || (r.status ? 'Verification failed (' + r.status + ')' : 'No internet connection — connect and try again.');
        // the built-in code no longer matches the server: let the user type the current one
        if (auto && j && j.error && j.error.code === 'bad_code') { S.manualCode = true; S.lockMsg = 'The access code built into this app no longer matches your server. Enter the current code.'; }
        render();
      });
  }
  RH.onAuthLost = function (msg) {
    if (isLocked()) return;
    RH.store.remove('auth');
    S.autoTried = !!(S.lastAuto && Date.now() - S.lastAuto < 30000); // sign in again by itself, but never in a loop
    S.lockMsg = /disabled/i.test(msg || '') ? 'Your access has been disabled by the owner.' : 'Please enter your access code again.';
    RH.nativeCall('closeApply');
    closeModal(); closeSheet(); render();
  };
  function checkAccess() {
    if (isLocked()) return;
    RH.http({ url: RH.ai.relayUrl() + '/me', headers: { Authorization: 'Bearer ' + RH.ai.builtinToken() }, timeout: 20000 }).then(function (r) {
      if (r.status === 401) { var j = null; try { j = JSON.parse(r.body); } catch (e) { } RH.onAuthLost(j && j.error && j.error.message); }
    }); // offline or server error: keep working
  }

  function render() {
    renderAcct();
    if (isLocked()) {
      if (AUTO_CODE && !S.manualCode && !S.verifying && !S.autoTried) { S.autoTried = true; verifyCode(true); return; }
      document.body.classList.add('locked');
      $('#view').innerHTML = viewLock();
      var ci = $('#codeIn');
      if (ci) ci.oninput = function () { var v = ci.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''); if (v !== ci.value) ci.value = v; S.codeDraft = v; };
      return;
    }
    document.body.classList.remove('locked');
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === S.tab); });
    var v = $('#view');
    v.innerHTML = S.tab === 'profile' ? viewProfile() : S.tab === 'jobs' ? viewJobs() : S.tab === 'tracker' ? viewTracker() : viewSettings();
    renderBadge();
  }
  RH.render = render;

  // ------------------------------------------------------------------ PROFILE
  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  function field(label, key, val, opt) {
    opt = opt || {};
    var v = esc(val == null ? '' : val);
    var attrs = ' data-' + (opt.ns || 'p') + '="' + key + '"' + (opt.arr ? ' data-arr="1"' : '') + (opt.ph ? ' placeholder="' + esc(opt.ph) + '"' : '');
    var input = opt.area ? '<textarea' + attrs + ' rows="' + (opt.rows || 3) + '">' + v + '</textarea>'
      : opt.options ? '<select' + attrs + '>' + opt.options.map(function (o) { // o = "text" or [value, label]
          var ov = Array.isArray(o) ? o[0] : o, ol = Array.isArray(o) ? o[1] : o;
          return '<option value="' + esc(ov) + '"' + (String(ov) === String(val == null ? '' : val) ? ' selected' : '') + '>' + esc(ol) + '</option>'; }).join('') + '</select>'
        : '<input' + attrs + ' type="' + (opt.type || 'text') + '" value="' + v + '">';
    return '<label class="f"><span>' + esc(label) + '</span>' + input + '</label>';
  }

  function viewProfile() {
    var h = '', p = S.profile, m = S.cvMeta, noAi = !RH.ai.available();
    if (!S.cvs.length) {
      h += '<div class="card hero"><h2>Find 100% remote jobs that fit your CV</h2>' +
        '<p class="muted small">Upload your CV once. RemoteHunt reads it with AI, searches the newest remote openings across 6 job boards, ranks them for you, and fills in application forms so you don\'t type the same details again.</p>' +
        '<div class="steps">' +
        '<div class="step"><i>1</i><div><b>Upload your CV</b><div class="muted small">PDF, DOCX or TXT — stays on your phone.</div></div></div>' +
        '<div class="step"><i>2</i><div><b>AI builds your profile</b><div class="muted small">Skills, roles, keywords and CV tips.</div></div></div>' +
        '<div class="step"><i>3</i><div><b>Get ranked remote jobs</b><div class="muted small">Latest postings scored for your fit.</div></div></div>' +
        '<div class="step"><i>4</i><div><b>Apply with ⚡ Autofill</b><div class="muted small">Forms filled from your profile; open questions answered by AI.</div></div></div>' +
        '</div><div class="sp"></div><button class="btn primary block" data-act="pickCv">Upload my CV</button></div>';
      if (noAi) h += noAiNote();
      return h;
    }
    h += '<div class="card"><div class="row"><h3 class="grow" style="margin:0">My CVs <span class="muted small">(' + S.cvs.length + '/5)</span></h3>' +
      (S.cvs.length > 1 ? '<button class="btn sm" data-act="analyzeAll"' + (S.analyzing ? ' disabled' : '') + '>✨ Analyze all</button>' : '') + '</div>' +
      '<div class="muted tiny" style="margin:4px 0 4px">Keep one CV per kind of job (e.g. Frontend, Product, Freelance). Contact details are shared by all of them.</div>';
    S.cvs.forEach(function (c, i) {
      var active = c.id === S.activeCv, busy = S.analyzingId === c.id && S.analyzing, ext = (c.meta.name.split('.').pop() || 'CV').toUpperCase().slice(0, 4);
      h += '<div class="prov' + (active ? ' ok' : '') + '"><div class="row"><div class="logo" style="width:40px;height:40px;flex:none;border-radius:10px;background:var(--card2);display:grid;place-items:center;font-weight:800;font-size:12px;color:var(--cyan)">' + esc(ext) + '</div>' +
        '<div class="grow"><input data-cvlabel="' + esc(c.id) + '" value="' + esc(c.label || '') + '" placeholder="' + esc(cvLabel(c, i)) + '" style="padding:6px 9px;font-weight:650">' +
        '<div class="muted tiny" style="margin-top:4px;overflow-wrap:anywhere">' + esc(c.meta.name) + ' • ' + fmtSize(c.meta.size || 0) + ' • ' + (busy ? (S.analyzing === 'read' ? 'reading…' : 'AI analyzing…') : c.profile ? 'analyzed' : 'not analyzed yet') + '</div></div></div>' +
        '<div class="row wrap" style="margin-top:9px">' + (active ? '<span class="pill g">✓ Editing below</span>' : '<button class="btn sm" data-act="useCv" data-id="' + esc(c.id) + '">Edit this CV</button>') +
        '<button class="btn sm" data-act="analyze" data-id="' + esc(c.id) + '"' + (S.analyzing ? ' disabled' : '') + '>' + (busy ? '<span class="spin"></span>' : '✨') + ' Re-analyze</button>' +
        '<button class="btn sm" data-act="pickCv" data-slot="' + esc(c.id) + '">Replace</button><button class="btn sm ghost" data-act="rmCv" data-id="' + esc(c.id) + '">Remove</button></div></div>';
    });
    if (S.cvs.length < 5) h += '<button class="btn sm" data-act="pickCv">+ Add another CV</button>';
    if (S.analyzing) h += '<div class="sp"></div><div class="note info">' + (S.analyzing === 'read' ? 'Reading your CV…' : 'AI is analyzing your CV… (10–40 s)') + '</div>';
    if (S.analyzeError) h += '<div class="sp"></div><div class="note err">' + esc(S.analyzeError) + '</div>';
    if (S.analyzeNote) h += '<div class="sp"></div><div class="note">' + esc(S.analyzeNote) + '</div>';
    h += '</div>';
    if (noAi) h += noAiNote();
    if (!p) return h;

    h += '<div class="muted tiny" style="margin:18px 4px 8px">PROFILE FROM: ' + esc(cvLabel(activeCv()).toUpperCase()) + '</div>';
    h += '<div class="card"><h2>' + esc(p.fullName || 'Your profile') + '</h2>' +
      (p.headline ? '<div class="small" style="color:#c7d2fe">' + esc(p.headline) + '</div>' : '') +
      '<div class="muted small" style="margin-top:4px">' + esc([p.location, p.yearsExperience ? p.yearsExperience + ' yrs experience' : '', p.seniority].filter(Boolean).join(' • ')) + '</div>';
    if (p.summary) h += '<p class="small" style="color:#cdd5e4">' + esc(p.summary) + '</p>';
    if (p.skills && p.skills.length) h += '<div class="muted tiny" style="margin:10px 0 6px">SKILLS</div><div class="chips">' + p.skills.slice(0, 24).map(function (s) { return '<span class="chip">' + esc(s) + '</span>'; }).join('') + (p.skills.length > 24 ? '<span class="chip">+' + (p.skills.length - 24) + '</span>' : '') + '</div>';
    if (p.targetRoles && p.targetRoles.length) h += '<div class="muted tiny" style="margin:12px 0 6px">ROLES TO TARGET</div><div class="chips">' + p.targetRoles.map(function (s) { return '<span class="chip on">' + esc(s) + '</span>'; }).join('') + '</div>';
    if (p.strengths && p.strengths.length) h += '<div class="muted tiny" style="margin:12px 0 0">YOUR SELLING POINTS</div><ul class="tips">' + p.strengths.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>';
    if (p.improvementTips && p.improvementTips.length) h += '<details style="margin-top:10px"><summary class="small" style="color:var(--amber);cursor:pointer">💡 ' + p.improvementTips.length + (p.improvementTips.length === 1 ? ' tip' : ' tips') + ' to improve your CV</summary><ul class="tips">' + p.improvementTips.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></details>';
    h += '<div class="sp"></div><button class="btn primary block" data-act="goJobs">Find matching remote jobs →</button></div>';

    h += '<div class="muted tiny" style="margin:18px 4px 8px">AUTOFILL DATA — CHECK & EDIT</div>';
    h += '<details class="sec"><summary>👤 Contact & links</summary><div class="in">' +
      '<div class="grid2">' + field('First name', 'firstName', p.firstName) + field('Last name', 'lastName', p.lastName) + '</div>' +
      field('Full name', 'fullName', p.fullName) + field('Email', 'email', p.email, { type: 'email' }) + field('Phone (with country code)', 'phone', p.phone, { type: 'tel' }) +
      field('Location (City, Country)', 'location', p.location) +
      '<div class="grid2">' + field('City', 'city', p.city) + field('State / Region', 'state', p.state) + '</div>' + field('Country', 'country', p.country) +
      field('LinkedIn URL', 'linkedin', p.linkedin, { type: 'url' }) + field('GitHub URL', 'github', p.github, { type: 'url' }) +
      field('Website', 'website', p.website, { type: 'url' }) + field('Portfolio', 'portfolio', p.portfolio, { type: 'url' }) + '</div></details>';
    h += '<details class="sec"><summary>💼 Career</summary><div class="in">' +
      field('Headline', 'headline', p.headline) + field('Current / last job title', 'currentTitle', p.currentTitle) + field('Current company', 'currentCompany', p.currentCompany) +
      '<div class="grid2">' + field('Years of experience', 'yearsExperience', p.yearsExperience, { type: 'number' }) + field('Seniority', 'seniority', p.seniority, { options: ['', 'junior', 'mid', 'senior', 'lead', 'principal', 'executive'] }) + '</div>' +
      field('Professional summary', 'summary', p.summary, { area: 1, rows: 4 }) +
      field('Skills (comma separated)', 'skills', (p.skills || []).join(', '), { area: 1, arr: 1 }) +
      field('Target roles (comma separated)', 'targetRoles', (p.targetRoles || []).join(', '), { area: 1, arr: 1, rows: 2 }) +
      field('Languages (e.g. English - Fluent, Hindi - Native)', 'languages', (p.languages || []).map(function (l) { return l.language + (l.level ? ' - ' + l.level : ''); }).join(', '), { arr: 1 }) +
      '</div></details>';
    h += '<details class="sec"><summary>🏢 Experience <span class="muted small">(' + (p.experience || []).length + ')</span></summary><div class="in">' +
      (p.experience || []).map(function (e, i) {
        return '<div class="prov"><div class="grid2">' + field('Title', 'title', e.title, { ns: 'exp-' + i }) + field('Company', 'company', e.company, { ns: 'exp-' + i }) +
          field('Start', 'start', e.start, { ns: 'exp-' + i }) + field('End', 'end', e.end, { ns: 'exp-' + i }) + '</div>' +
          field('Highlights (one per line)', 'highlights', (e.highlights || []).join('\n'), { ns: 'exp-' + i, area: 1 }) +
          '<div class="sp"></div><button class="btn sm danger" data-act="rmExp" data-i="' + i + '">Remove</button></div>';
      }).join('') + '<button class="btn sm" data-act="addExp">+ Add experience</button></div></details>';
    h += '<details class="sec"><summary>🎓 Education <span class="muted small">(' + (p.education || []).length + ')</span></summary><div class="in">' +
      (p.education || []).map(function (e, i) {
        return '<div class="prov">' + field('School / University', 'school', e.school, { ns: 'edu-' + i }) + '<div class="grid2">' + field('Degree', 'degree', e.degree, { ns: 'edu-' + i }) +
          field('Field of study', 'field', e.field, { ns: 'edu-' + i }) + field('Start year', 'start', e.start, { ns: 'edu-' + i }) + field('End year', 'end', e.end, { ns: 'edu-' + i }) + '</div>' +
          '<div class="sp"></div><button class="btn sm danger" data-act="rmEdu" data-i="' + i + '">Remove</button></div>';
      }).join('') + '<button class="btn sm" data-act="addEdu">+ Add education</button></div></details>';
    var a = S.answers;
    h += '<details class="sec"><summary>📝 Standard application answers</summary><div class="in"><div class="muted small">Used for the questions almost every form asks.</div>' +
      field('Work authorization (e.g. "Indian citizen, can work as contractor worldwide")', 'workAuthorization', a.workAuthorization, { ns: 'ans' }) +
      '<div class="grid2">' + field('Need visa sponsorship?', 'needsSponsorship', a.needsSponsorship, { ns: 'ans', options: [['', 'Not set (left for you on forms)'], 'No', 'Yes'] }) + field('Willing to relocate?', 'willingToRelocate', a.willingToRelocate, { ns: 'ans', options: ['No', 'Yes'] }) + '</div>' +
      '<div class="grid2">' + field('Expected salary', 'expectedSalary', a.expectedSalary, { ns: 'ans', ph: 'e.g. 60000 USD/year' }) + field('Notice period', 'noticePeriod', a.noticePeriod, { ns: 'ans' }) + '</div>' +
      '<div class="grid2">' + field('Available from', 'availableFrom', a.availableFrom, { ns: 'ans' }) + field('Your timezone', 'timezone', a.timezone, { ns: 'ans', ph: 'e.g. IST (UTC+5:30)' }) + '</div>' +
      field('How did you hear about us?', 'hearAbout', a.hearAbout, { ns: 'ans' }) +
      field('Remote work setup', 'remoteSetup', a.remoteSetup, { ns: 'ans' }) +
      '<div class="grid2">' + field('Gender', 'gender', a.gender, { ns: 'ans' }) + field('Pronouns', 'pronouns', a.pronouns, { ns: 'ans' }) + '</div>' +
      '<div class="grid2">' + field('Ethnicity', 'ethnicity', a.ethnicity, { ns: 'ans' }) + field('Disability', 'disability', a.disability, { ns: 'ans' }) + '</div>' +
      field('Veteran status', 'veteran', a.veteran, { ns: 'ans' }) + field('Writing tone', 'coverLetterTone', a.coverLetterTone, { ns: 'ans' }) +
      field('Your writing sample (optional) — paste a paragraph you wrote yourself, e.g. an old cover letter. AI answers will copy your style.', 'writingSample', a.writingSample, { ns: 'ans', area: 1, rows: 4 }) +
      '</div></details>';
    h += '<details class="sec"><summary>🧠 Remembered answers <span class="muted small">(' + S.memory.length + ')</span></summary><div class="in">' +
      (S.memory.length ? '<div class="muted small">Captured when you tap <b>Save</b> in the apply browser. Reused automatically on similar questions.</div>' +
        S.memory.slice().reverse().map(function (mm, ri) {
          var i = S.memory.length - 1 - ri;
          return '<div class="memo"><div class="row"><div class="grow"><div class="q">' + esc(mm.label) + '</div><div class="a">' + esc(mm.value) + '</div></div><button class="btn sm ghost" data-act="rmMemo" data-i="' + i + '">✕</button></div></div>';
        }).join('') : '<div class="muted small">Nothing yet. After you fill a form by hand, tap <b>Save</b> in the apply browser and your answers will be reused next time.</div>') +
      '</div></details>';
    h += '<button class="btn primary block" data-act="saveProfile">Save changes</button>';
    return h;
  }

  function noAiNote() {
    return '<div class="note" style="margin-bottom:12px">⚙️ <b>Add a free AI key</b> to unlock CV analysis, job ranking and AI-written answers. ' +
      'Google Gemini and Groq are free and take 1 minute. <a href="#" data-act="go" data-tab="settings">Open Settings →</a></div>';
  }

  function readProfileForm() {
    var p = Object.assign({}, S.profile || {});
    document.querySelectorAll('[data-p]').forEach(function (el) {
      var k = el.getAttribute('data-p'), v = el.value.trim();
      if (el.getAttribute('data-arr')) {
        var list = v.split(/[,\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
        if (k === 'languages') p.languages = list.map(function (s) { var m = s.split(/\s+-\s+/); return { language: m[0], level: m[1] || '' }; });
        else p[k] = U.uniq(list);
      } else p[k] = k === 'yearsExperience' ? (parseFloat(v) || '') : v;
    });
    ['exp', 'edu'].forEach(function (ns) {
      var list = (ns === 'exp' ? p.experience : p.education) || [];
      list = list.map(function (e, i) {
        var o = Object.assign({}, e);
        document.querySelectorAll('[data-' + ns + '-' + i + ']').forEach(function (el) {
          var k = el.getAttribute('data-' + ns + '-' + i);
          o[k] = k === 'highlights' ? el.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean) : el.value.trim();
        });
        return o;
      });
      if (ns === 'exp') p.experience = list; else p.education = list;
    });
    var a = Object.assign({}, S.answers);
    document.querySelectorAll('[data-ans]').forEach(function (el) { a[el.getAttribute('data-ans')] = el.value.trim(); });
    return { profile: p, answers: a };
  }

  function saveProfileForm(silent) {
    if (!S.profile) return;
    var r = readProfileForm();
    S.profile = r.profile; S.answers = r.answers;
    var c = activeCv(); if (c) c.profile = S.profile;
    S.cvs.forEach(function (o) { if (o.profile && o !== c) SHARED.forEach(function (k) { if (S.profile[k]) o.profile[k] = S.profile[k]; }); });
    document.querySelectorAll('[data-cvlabel]').forEach(function (el) { var x = cvById(el.getAttribute('data-cvlabel')); if (x) x.label = el.value.trim(); });
    saveCvs();
    RH.store.set('profile', S.profile); RH.store.set('answers', S.answers);
    if (!silent) toast('Profile saved');
  }

  RH.onCvPicked = function (meta) {
    if (!meta) return;
    if (meta.error) { toast('Could not open file: ' + meta.error); return; }
    var slot = meta.slot || S.pendingSlot || 'main', c = cvById(slot);
    if (!c) { c = { id: slot, label: '', meta: meta, profile: null, at: Date.now() }; S.cvs.push(c); }
    else c.meta = meta;
    saveCvs();
    if (S.profile) saveProfileForm(true);
    S.activeCv = slot; syncActive();
    analyze(slot);
  };

  function pickCv(el) {
    var slot = el && el.getAttribute ? el.getAttribute('data-slot') : null;
    if (!slot) {
      if (S.cvs.length >= 5) { toast('You can keep up to 5 CVs. Remove one first.'); return; }
      slot = RH.account.slotPrefix() + (S.cvs.length ? 'cv' + Date.now().toString(36) : 'main');
    }
    S.pendingSlot = slot;
    if (RH.isNative) { RH.nativeCall('pickCvSlot', slot); return; }
    var inp = $('#webFile');
    inp.value = '';
    inp.onchange = function () {
      var f = inp.files[0]; if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var b64 = String(fr.result).split(',')[1] || '';
        RH.store.set('cv.b64.' + slot, b64);
        var meta = { name: f.name, mime: f.type || '', size: f.size, savedAt: Date.now(), path: 'web', slot: slot };
        RH.onCvPicked(meta);
      };
      fr.readAsDataURL(f);
    };
    inp.click();
  }

  function analyze(x) {
    var id = typeof x === 'string' ? x : (x && x.getAttribute && x.getAttribute('data-id')) || S.activeCv;
    var c = cvById(id); if (!c) return Promise.resolve();
    if (S.profile && id !== S.activeCv) saveProfileForm(true);
    S.analyzingId = id; S.analyzing = 'read'; S.analyzeError = ''; S.analyzeNote = '';
    if (S.tab !== 'profile') go('profile'); else render();
    var b64 = cvB64(c), np = null;
    if (!b64) { S.analyzing = ''; S.analyzeError = 'Saved CV file not found. Please upload "' + c.meta.name + '" again.'; render(); return Promise.resolve(); }
    return RH.cv.extractText(c.meta, b64).then(function (text) {
      RH.store.set('cv.text.' + id, text);
      if (!RH.ai.available()) {
        np = mergeManual(RH.cv.normalizeProfile(RH.cv.quickParse(text), {}));
        S.analyzeNote = 'Basic (offline) parsing used because AI is unavailable right now. Tap Re-analyze later for a full profile.';
        return;
      }
      S.analyzing = 'ai'; render();
      return RH.cv.analyze(text).then(function (p) { np = mergeManual(p); }, function (e) {
        np = mergeManual(RH.cv.normalizeProfile(RH.cv.quickParse(text), {}));
        S.analyzeError = 'AI analysis failed, used basic parsing instead. ' + String(e.message || e).slice(0, 220);
      });
    }).then(function () {
      if (np) {
        c.profile = np; c.at = Date.now();
        if (!c.label) c.label = (np.targetRoles || [])[0] || np.currentTitle || '';
        saveCvs();
        if (id === S.activeCv) { syncActive(); S.queries = (np.searchKeywords || []).slice(0, 4); RH.store.set('jobs.queries', S.queries); }
      }
    }, function (e) {
      S.analyzeError = String(e.message || e);
    }).then(function () { S.analyzing = ''; S.analyzingId = null; render(); if (np && !S.analyzeError) toast('"' + cvLabel(c) + '" ready ✓'); });
  }
  RH.analyze = analyze;
  function analyzeAll() {
    var ids = S.cvs.map(function (c) { return c.id; }), i = 0;
    (function next() { if (i < ids.length) analyze(ids[i++]).then(next); })();
  }

  // contact details are shared by all CVs; keep what the user typed if a CV lacks them
  function mergeManual(np) {
    var others = S.cvs.map(function (c) { return c.profile; }).filter(Boolean);
    if (S.profile) others.unshift(S.profile);
    SHARED.forEach(function (k) { if (!np[k]) { var src = others.filter(function (p) { return p[k]; })[0]; if (src) np[k] = src[k]; } });
    return np;
  }

  // ------------------------------------------------------------------ JOBS
  function scoreColor(s) { return s >= 75 ? 'var(--green)' : s >= 55 ? 'var(--amber)' : s >= 35 ? '#fb923c' : 'var(--red)'; }

  function eligPill(j) {
    var country = (S.profile && S.profile.country) || '';
    if (j.aiRemote === 'not_remote') return '<span class="pill r">Not fully remote</span>';
    if (j.eligibility === 'worldwide' && j.aiRemote !== 'restricted') return '<span class="pill g">🌍 Worldwide</span>';
    if (j.eligibility === 'eligible') return '<span class="pill g">✓ Open to ' + esc(country) + '</span>';
    var where = j.locations.length ? j.locations.slice(0, 2).join(', ') + (j.locations.length > 2 ? '…' : '') : (j.aiRegions || 'Restricted');
    return '<span class="pill a">📍 ' + esc(where.slice(0, 40)) + '</span>';
  }

  function trustPill(j) {
    var t = j.trust || 'community';
    if (t === 'verified') return '<span class="pill g">✓ Verified employer</span>';
    if (t === 'trusted') return '<span class="pill b">Trusted board</span>';
    if (t === 'caution') return '<span class="pill a" title="' + esc((j.trustWhy || []).join('; ')) + '">⚠ Check carefully</span>';
    if (t === 'flagged') return '<span class="pill r">⛔ Possible scam</span>';
    return '<span class="pill">Community post</span>';
  }
  function srcLabel(j) { return j.source === 'Employer' ? (RH.jobs.ATS_NAME[j.ats] || 'Employer site') : j.direct ? (j.atsName || 'Company site') : j.source; }

  function jobCard(j) {
    var s = Math.round(j.score || 0), tr = S.tracker[j.id] || appliedByLink(j);
    var logo = j.logo ? '<img src="' + esc(j.logo) + '" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '';
    return '<div class="job" data-act="openJob" data-id="' + esc(j.id) + '">' +
      '<div class="logo">' + logo + '<span>' + esc((j.company || '?').charAt(0).toUpperCase()) + '</span></div>' +
      '<div class="grow"><h4>' + esc(j.title) + '</h4><div class="co">' + esc(j.company) + '</div>' +
      '<div class="meta">' + trustPill(j) + eligPill(j) + (j.salary ? '<span class="pill b">' + esc(j.salary) + '</span>' : '') +
      (j.isNew ? '<span class="pill g">NEW</span>' : '') + (j.notRemote ? '<span class="pill">On-site / hybrid</span>' : '') +
      '<span class="pill">' + (j.postedAt ? U.ago(j.postedAt) : 'recent') + '</span><span class="pill">' + esc(srcLabel(j)) + '</span>' +
      (tr ? '<span class="pill b">' + esc(statusLabel(tr.status)) + '</span>' : '') + (j.bestCv && S.cvs.length > 1 && cvById(j.bestCv) ? '<span class="pill">📄 ' + esc(cvLabel(cvById(j.bestCv))) + '</span>' : '') + '</div>' +
      (j.aiReason ? '<div class="why">' + esc(j.aiReason) + '</div>' : '') + '</div>' +
      '<div class="score" style="--p:' + s + ';--c:' + scoreColor(s) + '">' + s + '<small>' + (j.aiScore != null ? 'AI' : 'KW') + '</small></div></div>';
  }
  // the logo initial sits under the image; hide it once an image is present
  var st = document.createElement('style'); st.textContent = '.job .logo{position:relative}.job .logo img{position:absolute;inset:0}'; document.head.appendChild(st);

  var DONE_STATUS = { applied: 1, assessment: 1, interview: 1, offer: 1, rejected: 1 };
  // the same job can come back from another source with a different id: match on the application link or title+company
  function appliedByLink(j) {
    var a = String(j.applyUrl || '').split('?')[0], k = U.norm(j.title) + '|' + U.norm(j.company);
    for (var id in S.tracker) {
      var t = S.tracker[id], tj = t.job || {};
      if (!DONE_STATUS[t.status]) continue;
      if ((a && String(tj.applyUrl || '').split('?')[0] === a) || U.norm(tj.title) + '|' + U.norm(tj.company) === k) return t;
    }
    return null;
  }

  // ------------------------------------------------------------------ MY SITES (websites you follow; new jobs are marked)
  function siteWhere(s) { return s.kind === 'ats' ? (RH.jobs.ATS_NAME[s.ats] || s.ats) + ' · ' + s.slug : (function () { try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch (e) { return s.url; } })(); }
  function viewSitesCard() {
    var sites = RH.sites.list(), total = RH.sites.newCount();
    var h = '<div class="card"><div class="row"><h3 class="grow" style="margin:0">📌 My sites' + (sites.length ? ' <span class="muted small">(' + sites.length + ')</span>' : '') + '</h3>' +
      (total ? '<span class="pill g">' + total + ' new</span>' : '') +
      (sites.length ? '<button class="btn sm" data-act="sitesCheck"' + (S.sitesBusy ? ' disabled' : '') + '>' + (S.sitesBusy ? '<span class="spin"></span> Checking' : '↻ Check') + '</button>' : '') + '</div>';
    if (!sites.length) h += '<p class="muted small" style="margin:8px 0 0">Follow job pages you like: a company\'s hiring page (Greenhouse, Lever, Ashby, Workable…) or any careers page. New jobs show up here, marked NEW.</p>';
    sites.forEach(function (st) {
      var n = RH.sites.newCount(st), cnt = RH.sites.count(st), all = RH.sites.total(st);
      var cntTxt = st.remoteOnly && all > cnt ? cnt + ' remote · ' + all + ' total' : cnt + ' job' + (cnt === 1 ? '' : 's');
      h += '<div class="site-row" data-act="openSite" data-id="' + esc(st.id) + '"><div class="grow" style="min-width:0"><b>' + esc(st.name) + '</b><div class="muted tiny">' + esc(siteWhere(st)) + ' • ' + cntTxt + (st.lastCheck ? ' • checked ' + U.ago(st.lastCheck) : '') + '</div>' +
        (st.lastError ? '<div class="tiny" style="color:var(--amber)">⚠ ' + esc(st.lastError) + '</div>' : '') + '</div>' + (n ? '<span class="pill g">' + n + ' new</span>' : '') + '<span class="muted">›</span></div>';
    });
    h += '<div class="row" style="margin-top:10px"><input id="siteUrl" class="grow" placeholder="Paste a jobs page link" autocapitalize="none" autocomplete="off" spellcheck="false" value="' + esc(S.siteDraft || '') + '">' +
      '<button class="btn sm primary" data-act="siteAdd"' + (S.siteAdding ? ' disabled' : '') + '>' + (S.siteAdding ? '<span class="spin"></span>' : '+ Add') + '</button></div>' +
      (S.siteMsg ? '<div class="note' + (S.siteMsgErr ? ' err' : '') + '" style="margin-top:8px">' + esc(S.siteMsg) + '</div>' : '') + '</div>';
    return h;
  }
  function openSite(id) {
    var st = RH.sites.byId(id);
    if (!st) { S.returnSite = null; closeSheet(); render(); return; }
    S.returnSite = id; S.sheetJob = null;
    var jobs = RH.sites.visible(st), terms = S.profile ? RH.jobs.profileTerms(S.profile) : null;
    S.siteJobs = {};
    jobs.forEach(function (j) { S.siteJobs[j.id] = j; if (terms) { j.localScore = RH.jobs.localScore(j, terms); j.score = j.localScore; } });
    var fresh = jobs.filter(function (j) { return j.isNew; }), rest = jobs.filter(function (j) { return !j.isNew; }), max = S.siteShow || 60;
    var h = '<div class="sheet-top"><button class="btn sm ghost" data-act="closeSheet">‹ Back</button><div class="grow"></div><button class="btn sm ghost" data-act="ext" data-url="' + esc(st.url) + '">Open site ↗</button></div><div class="sheet-body">' +
      '<h2 style="font-size:20px">' + esc(st.name) + '</h2><div class="muted small">' + esc(siteWhere(st)) + (st.lastCheck ? ' • checked ' + U.ago(st.lastCheck) : '') + '</div>' +
      (st.lastError ? '<div class="note err" style="margin-top:10px">⚠ ' + esc(st.lastError) + '</div>' : '') +
      (st.kind === 'ats' ? '<label class="row" style="margin:12px 2px"><span class="grow small">Only remote jobs' + (st.remoteOnly && RH.sites.total(st) > jobs.length ? ' <span class="muted">(' + (RH.sites.total(st) - jobs.length) + ' on-site / hybrid hidden — untick to see them)</span>' : '') + '</span><input type="checkbox" data-site-remote="' + esc(st.id) + '"' + (st.remoteOnly ? ' checked' : '') + ' style="width:auto"></label>'
        : '<div class="note" style="margin:12px 0">This page is read for job links. If it loads its jobs with JavaScript some can be missing; the company\'s Greenhouse, Lever or Ashby link works best.</div>') +
      (fresh.length ? '<div class="muted small" style="margin:14px 2px 8px">🆕 New since you last looked (' + fresh.length + ')</div>' + fresh.map(jobCard).join('') : '') +
      (rest.length ? '<div class="muted small" style="margin:14px 2px 8px">' + (fresh.length ? 'Earlier' : 'All jobs') + ' (' + rest.length + ')</div>' + rest.slice(0, max).map(jobCard).join('') : '') +
      (rest.length > max ? '<button class="btn block" data-act="siteMore">Show more (' + (rest.length - max) + ')</button>' : '') +
      (!jobs.length ? '<div class="card empty"><b>No jobs right now</b><p class="small">' + (st.remoteOnly ? 'No remote jobs at the moment. ' : '') + 'New ones will show up here.</p></div>' : '') +
      '<div class="row" style="margin-top:18px"><button class="btn sm danger" data-act="siteRemove" data-id="' + esc(st.id) + '">Stop following</button></div></div>';
    openSheet(h);
    RH.sites.markSeen(id); renderBadge();
  }
  function sitesAuto(force) {
    if (!RH.sites.list().length) return;
    if (force) { S.sitesBusy = true; if (S.tab === 'jobs' && $('#sheet').hidden) render(); }
    RH.sites.checkAll(force).then(function (r) {
      S.sitesBusy = false; renderBadge();
      if (r.fresh) toast('📌 ' + r.fresh + ' new job' + (r.fresh > 1 ? 's' : '') + ' on your sites');
      else if (force) toast('No new jobs on your sites');
      if (S.tab === 'jobs' && $('#sheet').hidden) render();
    }, function () { S.sitesBusy = false; if (S.tab === 'jobs' && $('#sheet').hidden) render(); });
  }

  function viewJobs() {
    if (!S.profile) {
      return viewSitesCard() + '<div class="card empty"><div class="big">📄</div><b>Upload your CV first</b><p class="small">We use it to decide what to search for and to rank results.</p><button class="btn primary" data-act="go" data-tab="profile">Go to My CV</button></div>';
    }
    var pf = RH.jobs.prefs(), qs = queries(), sr = S.search, h = viewSitesCard();
    var sugg = U.uniq((S.profile.targetRoles || []).concat(S.profile.searchKeywords || [])).filter(function (r) { return qs.map(U.norm).indexOf(U.norm(r)) < 0; }).slice(0, 6);
    var readyCvs = S.cvs.filter(function (c) { return c.profile; });
    if (readyCvs.length > 1) {
      h += '<div class="card" style="padding:12px 16px"><label class="f" style="margin:0"><span>Search with</span><select data-cvmode="1">' +
        readyCvs.map(function (c) { return '<option value="' + esc(c.id) + '"' + (S.searchCv !== 'all' && c.id === S.activeCv ? ' selected' : '') + '>📄 ' + esc(cvLabel(c)) + '</option>'; }).join('') +
        '<option value="all"' + (S.searchCv === 'all' ? ' selected' : '') + '>✨ All my CVs (AI picks the best CV per job)</option></select></label></div>';
    }
    h += '<div class="card"><h3>What to search</h3><div class="chips">' +
      qs.map(function (q, i) { return '<span class="chip on x" data-act="rmQuery" data-i="' + i + '">' + esc(q) + '</span>'; }).join('') +
      sugg.map(function (q) { return '<span class="chip add" data-act="addQuery" data-q="' + esc(q) + '">+ ' + esc(q) + '</span>'; }).join('') + '</div>' +
      '<div class="row" style="margin-top:10px"><input id="qInput" placeholder="Add keyword, e.g. react developer" class="grow"><button class="btn sm" data-act="addQueryInput">Add</button></div>' +
      '<div class="grid2" style="margin-top:4px">' +
      '<label class="f"><span>Posted within</span><select data-pref="maxAgeDays">' + [1, 3, 7, 14, 30].map(function (d) { return '<option value="' + d + '"' + (pf.maxAgeDays == d ? ' selected' : '') + '>' + (d === 1 ? '24 hours' : d + ' days') + '</option>'; }).join('') + '</select></label>' +
      '<label class="f"><span>Sort by</span><select data-pref="sort"><option value="match"' + (pf.sort === 'match' ? ' selected' : '') + '>Best match</option><option value="date"' + (pf.sort === 'date' ? ' selected' : '') + '>Newest</option></select></label></div>' +
      '<div class="setrow" style="border:0;padding-bottom:0"><div class="grow small">Only jobs open to ' + esc(S.profile.country || 'my country') + (S.profile.country ? '' : ' <span class="muted tiny">(set country in My CV)</span>') + '</div>' +
      '<label class="switch"><input type="checkbox" data-pref="onlyEligible"' + (pf.onlyEligible ? ' checked' : '') + '><i></i></label></div>' +
      '<div class="sp"></div><button class="btn primary block" data-act="search"' + (sr.running ? ' disabled' : '') + '>' + (sr.running ? '<span class="spin"></span> Searching…' : '🔎 Find remote jobs') + '</button>';
    if (sr.running || (sr.stats && Object.keys(sr.stats).length && sr.stage)) {
      var pct = sr.stage === 'rank' ? Math.round(100 * sr.done / Math.max(1, sr.total)) : 0;
      var stTxt = sr.stage === 'rank' ? 'AI is ranking ' + sr.total + ' best candidates… ' + sr.done + '/' + sr.total : sr.running ? 'Fetching the latest remote jobs…' : '';
      if (stTxt) h += '<div class="sp"></div><div class="small muted">' + stTxt + '</div><div class="sp" style="height:6px"></div><div class="bar"><i style="width:' + (sr.stage === 'rank' ? pct : 30) + '%"></i></div>';
      h += '<div class="srcs">' + Object.keys(sr.stats).map(function (k) {
        var x = sr.stats[k];
        return '<span class="pill ' + (x.status === 'ok' ? 'g' : x.status === 'error' ? 'r' : '') + '" title="' + esc(x.error || '') + '">' + esc(x.name) + (x.status === 'loading' ? ' …' : x.status === 'ok' ? ' ' + x.count : ' ✕') + '</span>';
      }).join('') + '</div>';
    }
    h += '</div>';
    var res = sr.result;
    if (res && res.jobs) {
      var isDone = function (j) { var t = S.tracker[j.id] || appliedByLink(j); return t && DONE_STATUS[t.status]; };
      var direct = res.jobs.filter(function (j) { return j.source === 'Employer' || RH.jobs.directLink(j); });
      var boardN = res.jobs.length - direct.length;
      // board listings: always with "Direct links only" off; otherwise when you ask, or when nothing direct matched
      var withBoards = pf.directOnly === false || S.showBoards || !direct.length;
      var shown = withBoards ? res.jobs : direct;
      var open = shown.filter(function (j) { return !isDone(j); }), done = shown.filter(isDone);
      var list = pf.appliedMode === 'hide' ? open : open.concat(done);
      h += '<div class="row" style="margin:16px 4px 10px"><b class="grow">' + open.length + ' jobs to apply' + (done.length ? ' <span class="muted tiny">+ ' + done.length + ' applied' + (pf.appliedMode === 'hide' ? ' (hidden)' : ' (at the bottom)') + '</span>' : '') + '</b><span class="muted tiny">' + (res.rankedBy === 'ai' ? '✨ ranked by AI' : 'ranked by keywords') + ' • ' + U.ago(res.at) + '</span></div>';
      if (res.flagged) h += '<div class="note" style="margin-bottom:10px">🛡️ ' + res.flagged + ' listing' + (res.flagged > 1 ? 's' : '') + ' hidden because ' + (res.flagged > 1 ? 'they look' : 'it looks') + ' like a scam (fees, Telegram/WhatsApp-only contact, etc.).</div>';
      if (res.errors && res.errors.length) h += '<details class="note" style="margin-bottom:10px"><summary>' + res.errors.length + ' source(s) had problems — results may be partial</summary><div class="tiny" style="margin-top:6px">' + res.errors.map(esc).join('<br>') + '</div></details>';
      if (pf.directOnly !== false && boardN) {
        var bl = boardN + ' job-board listing' + (boardN > 1 ? 's' : '');
        if (!withBoards) h += '<div class="note" style="margin-bottom:10px">🔗 Showing only direct company application pages. ' + bl + ' left out (applying there may need a sign-up on the board\'s site). <button class="btn sm" data-act="showBoards">Show them too</button></div>';
        else if (!direct.length) h += '<div class="note" style="margin-bottom:10px">🔗 No direct company pages matched, so ' + bl + ' are shown. Applying may need a sign-up on the board\'s site.</div>';
        else h += '<div class="note" style="margin-bottom:10px">🔗 Including ' + bl + '. <button class="btn sm" data-act="hideBoards">Direct pages only</button></div>';
      } else if (res.middlemen && !boardN) h += '<div class="note" style="margin-bottom:10px">🔗 ' + res.middlemen + ' job-board listing' + (res.middlemen > 1 ? 's were' : ' was') + ' left out. Search again to see them.</div>';
      if (!list.length) h += '<div class="card empty"><div class="big">🔍</div><b>No matches</b><p class="small">Try broader keywords (e.g. "developer" instead of a specific framework) or a longer "Posted within" period.</p></div>';
      h += list.slice(0, S.showCount).map(function (j, i) { return (i === open.length && done.length && pf.appliedMode !== 'hide' ? '<div class="muted small" style="margin:18px 4px 8px">✓ Already applied</div>' : '') + jobCard(j); }).join('');
      if (list.length > S.showCount) h += '<button class="btn block" data-act="more">Show more (' + (list.length - S.showCount) + ')</button>';
    }
    return h;
  }

  function doSearch() {
    var sr = S.search;
    if (sr.running) return;
    saveQueryInput();
    sr.running = true; sr.stage = 'fetch'; sr.stats = {}; sr.done = 0; sr.total = 0; S.showCount = 30;
    render();
    RH.jobs.search({
      queries: queries(), profile: searchSetup().profile, cvs: searchSetup().cvs, prefs: RH.jobs.prefs(),
      onProgress: function (pr) {
        sr.stage = pr.stage; sr.stats = pr.stats; if (pr.stage === 'rank') { sr.done = pr.done; sr.total = pr.total; }
        if (S.tab === 'jobs' && $('#sheet').hidden) render();
      }
    }).then(function (res) {
      res.at = Date.now();
      // keep a lighter copy for next launch
      var keep = { at: res.at, rankedBy: res.rankedBy, errors: res.errors, flagged: res.flagged, middlemen: res.middlemen, jobs: res.jobs.slice(0, 200) };
      RH.store.set('jobs.last', keep);
      sr.result = keep;
      if (!res.jobs.length && res.errors.length) toast('Some job boards failed — check your connection');
    }, function (e) {
      toast(String(e.message || e));
    }).then(function () { sr.running = false; sr.stage = ''; render(); });
  }

  function saveQueryInput() {
    var inp = $('#qInput');
    if (inp && inp.value.trim()) { addQuery(inp.value.trim()); inp.value = ''; }
  }
  function addQuery(q) {
    var qs = queries().slice();
    if (qs.map(U.norm).indexOf(U.norm(q)) < 0) qs.push(q);
    S.queries = qs.slice(-6); RH.store.set('jobs.queries', S.queries);
  }

  function findJob(id) {
    var r = S.search.result;
    var j = r && r.jobs && r.jobs.filter(function (x) { return x.id === id; })[0];
    if (!j && S.siteJobs) j = S.siteJobs[id];
    if (!j && S.tracker[id]) j = S.tracker[id].job;
    return j;
  }

  // ------------------------------------------------------------------ job detail
  function statusLabel(s) { return { saved: '★ Saved', applying: '⏳ In progress', applied: '✓ Applied', assessment: '📝 Assessment', interview: '🎤 Interview', offer: '🎉 Offer', rejected: '✕ Closed' }[s] || s; }
  var MAIL_ICON = { received: '📨', assessment: '📝', interview: '🎤', rejected: '✕', offer: '🎉' };

  function slimJob(j) {
    var o = {};
    ['id', 'source', 'title', 'company', 'logo', 'url', 'applyUrl', 'tags', 'locations', 'salary', 'type', 'postedAt', 'score', 'aiScore', 'aiReason', 'aiMissing', 'aiRemote', 'aiRegions', 'eligibility', 'localScore', 'category', 'ats', 'slug', 'jid', 'descLazy', 'descLoaded', 'direct', 'atsName', 'trust', 'trustWhy', 'bestCv'].forEach(function (k) { o[k] = j[k]; });
    o.description = String(j.description || '').slice(0, 20000);
    return o;
  }
  function track(j, status) {
    var t = S.tracker[j.id] || { job: slimJob(j), created: Date.now() };
    t.status = status; t.updated = Date.now();
    if (status === 'applied' && !t.appliedAt) t.appliedAt = Date.now();
    S.tracker[j.id] = t; saveTracker();
  }

  function openJob(id) {
    var j = findJob(id);
    if (!j) { toast('Job not found'); return; }
    S.sheetJob = j;
    var s = Math.round(j.score || 0), tr = S.tracker[j.id];
    var h = '<div class="sheet-top"><button class="btn sm ghost" data-act="closeSheet">‹ Back</button><div class="grow"></div>' +
      '<button class="btn sm ghost" data-act="ext" data-url="' + esc(j.url) + '">Open ↗</button></div><div class="sheet-body">' +
      '<div class="row" style="align-items:flex-start"><div class="grow"><h2 style="font-size:20px">' + esc(j.title) + '</h2><div class="muted" style="margin-top:3px">' + esc(j.company) + '</div></div></div>' +
      '<div class="meta row wrap" style="margin-top:10px;gap:5px">' + trustPill(j) + eligPill(j) + (j.salary ? '<span class="pill b">' + esc(j.salary) + '</span>' : '') + (j.type ? '<span class="pill">' + esc(j.type) + '</span>' : '') +
      '<span class="pill">' + (j.postedAt ? 'Posted ' + U.ago(j.postedAt) : '') + '</span><span class="pill">via ' + esc(srcLabel(j)) + (j.alsoOn && j.alsoOn.length ? ' +' + j.alsoOn.length : '') + '</span>' +
      (tr ? '<span class="pill b">' + esc(statusLabel(tr.status)) + '</span>' : '') + '</div>' +
      '<div class="card" style="margin-top:14px"><div class="match"><div class="score" style="--p:' + s + ';--c:' + scoreColor(s) + '">' + s + '<small>' + (j.aiScore != null ? 'AI' : 'KW') + '</small></div><div class="grow small">' +
      (j.aiReason ? esc(j.aiReason) : 'Keyword match with your profile. ' + (RH.ai.available() ? 'Run a new search to get an AI fit score.' : 'Add an AI key for smarter ranking.')) +
      (j.aiMissing && j.aiMissing.length ? '<div class="tiny" style="margin-top:6px;color:var(--amber)">Gaps: ' + j.aiMissing.map(esc).join(', ') + '</div>' : '') +
      (j.locations && j.locations.length ? '<div class="tiny muted" style="margin-top:6px">Location: ' + esc(j.locations.join(', ')) + (j.remoteNote ? ' — ' + esc(j.remoteNote) : '') + '</div>' : '') +
      '</div></div></div>' +
      '<div class="row wrap" style="margin-bottom:14px"><button class="btn sm" data-act="cover">✍️ Cover letter</button><button class="btn sm" data-act="toggleSave">' + (tr ? '★ In tracker' : '☆ Save') + '</button>' +
      '<button class="btn sm" data-act="markApplied">' + (tr && tr.status === 'applied' ? '✓ Applied' : 'Mark applied') + '</button></div>' +
      (j.tags && j.tags.length ? '<div class="chips" style="margin-bottom:12px">' + j.tags.slice(0, 12).map(function (t) { return '<span class="chip">' + esc(t) + '</span>'; }).join('') + '</div>' : '') +
      (j.trust === 'caution' || j.trust === 'flagged' ? '<div class="note err" style="margin-bottom:12px">⚠ Possible scam signals: ' + esc((j.trustWhy || []).join(' · ')) + '. Never pay fees or share bank details to get a job.</div>' : '') +
      (j.trust === 'verified' ? '<div class="note info" style="margin-bottom:12px">✓ Posted on ' + esc(j.company) + '\'s own hiring system (' + esc(srcLabel(j)) + '). The apply button opens their official application form.</div>' : '') +
      '<div class="desc" id="jobDesc">' + (j.descLazy && !j.descLoaded ? '<div class="muted small">Loading full description…</div>' + U.safeHtml(j.description) : U.safeHtml(j.description) || '<div class="muted small">No description provided — open the job page for details.</div>') + '</div></div>' +
      '<div class="sheet-actions"><button class="btn primary grow" data-act="apply">⚡ Apply with Autofill</button></div>';
    openSheet(h);
    if (j.descLazy && !j.descLoaded) {
      RH.jobs.loadDescription(j).then(function () { if (S.sheetJob && S.sheetJob.id === j.id) { var sh = $('#sheet'), y = sh.scrollTop; openJob(j.id); sh.scrollTop = y; } });
    }
  }

  function coverLetter(regen) {
    var j = S.sheetJob; if (!j) return;
    var key = 'cover.' + U.hash(j.id);
    var cached = !regen && RH.store.get(key, null);
    var show = function (txt) {
      modal('<h3>Cover letter</h3><div class="muted tiny" style="margin-bottom:8px">' + esc(j.title) + ' — ' + esc(j.company) + '</div><textarea id="coverTxt" rows="14">' + esc(txt) + '</textarea>' +
        '<div class="sp"></div><div class="row wrap"><button class="btn sm primary" data-act="copyCover">Copy</button><button class="btn sm" data-act="shareCover">Share</button>' +
        '<button class="btn sm" data-act="regenCover">↻ Rewrite</button><div class="grow"></div><button class="btn sm ghost" data-act="closeModal">Close</button></div>');
    };
    if (cached) return show(cached);
    if (!RH.ai.available()) { toast('Add an AI key in Settings first'); return; }
    modal('<div class="row"><span class="spin" style="border-color:rgba(255,255,255,.2);border-top-color:#818cf8;width:18px;height:18px"></span><b>Writing a tailored cover letter…</b></div>');
    var bc = cvForJob(j), p = (bc && bc.profile) || S.profile || {};
    var prompt = 'Write a short cover letter for this remote job, as the candidate. 150-230 words, no placeholders like [Company], ' +
      'no invented facts. Pick 2 concrete things from the profile that match what this job actually needs and explain them plainly. Start with "Hi [hiring manager name]," if named, otherwise "Hi there,". Sign with the candidate\'s first name. Plain text only.\n' +
      RH.voice.styleBlock(S.memory, S.answers) + '\n' +
      'PROFILE: ' + JSON.stringify({ name: p.fullName, headline: p.headline, summary: p.summary, years: p.yearsExperience, skills: (p.skills || []).slice(0, 25), experience: (p.experience || []).slice(0, 4), achievements: p.achievements, email: p.email, phone: p.phone }) +
      '\n\nJOB: ' + JSON.stringify({ title: j.title, company: j.company, description: U.stripHtml(j.description).slice(0, 5000) });
    RH.ai.chat(prompt, { system: 'You help a job seeker write in their own natural voice. Plain, specific, human. Never sound like a template or a chatbot.', temperature: 0.75, maxTokens: 3000 }).then(function (txt) {
      txt = RH.voice.humanize(txt.replace(/^```\w*\n?|```$/g, '').trim());
      RH.store.set(key, txt);
      if ($('#modal')) show(txt);
    }, function (e) {
      if ($('#modal')) modal('<div class="note err">' + esc(e.message || e) + '</div><div class="sp"></div><button class="btn sm" data-act="closeModal">Close</button>');
    });
  }

  function cvForJob(j) { return (j && j.bestCv && cvById(j.bestCv)) || activeCv(); }
  function startApply() {
    var j = S.sheetJob; if (!j) return;
    if (!S.profile) { toast('Upload your CV first'); return; }
    S.applyJob = j;
    S.applyCv = cvForJob(j);
    if (S.applyCv) RH.store.set('cv.meta', S.applyCv.meta); // the file the native side attaches
    var t = S.tracker[j.id];
    if (!t || t.status === 'saved') track(j, 'applying');
    var go2 = function () { RH.nativeCall('openApply', j.applyUrl || j.url); };
    if (j.descLazy && !j.descLoaded) RH.jobs.loadDescription(j).then(go2, go2); else go2();
    if (!RH.isNative && !(RH.mockNative && RH.mockNative.openApply) && !window.Android) window.open(j.applyUrl || j.url, '_blank');
  }

  RH.onApplyClosed = function () {
    var j = S.applyJob; if (!j) return;
    var t = S.tracker[j.id];
    if (t && (t.status === 'applied' || t.status === 'interview' || t.status === 'offer')) return;
    modal('<h3>Did you submit the application?</h3><p class="muted small">' + esc(j.title) + ' at ' + esc(j.company) + '</p><div class="row"><button class="btn primary grow" data-act="confirmApplied">Yes, mark applied</button><button class="btn grow" data-act="closeModal">Not yet</button></div>');
  };

  // ------------------------------------------------------------------ AUTOFILL orchestration (called by native)
  function status(t) { RH.nativeCall('setApplyStatus', t); }
  var ATS = /(greenhouse|lever\.co|ashbyhq|workable|smartrecruiters|bamboohr|recruitee|teamtailor|breezy|jobvite|icims|myworkdayjobs|workday|personio|jazzhr|applytojob|rippling|pinpointhq|homerun|dover|wellfound|gem\.com|comeet|freshteam|zoho|polymer|manatal|hire\.)/i;

  function urlHost(u) { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } }
  /** Automatic fill (no tap) only on known hiring systems, or on the site of the job you chose to apply to when
   *  that job isn't flagged. Anywhere else — ads, redirects, pages reached by links — you tap ⚡ Autofill yourself. */
  function autoFillAllowed(pageUrl) {
    if (!/^https:\/\//i.test(pageUrl || '')) return false;
    var ats = RH.jobs.atsOf(pageUrl);
    if (ats && ats !== 'Company page') return true;
    var j = S.applyJob, host = urlHost(pageUrl);
    if (!j || !host || j.trust === 'flagged' || j.trust === 'caution') return false;
    return [j.applyUrl, j.url].some(function (u) { return u && urlHost(u) === host; });
  }

  RH.autofill = {
    onFields: function (raw, pageUrl, pageTitle, auto) {
      var data;
      S.autoDone = S.autoDone || {};
      if (auto && (S.autoDone[pageUrl] || !RH.jobs.prefs().autoFill)) return;
      try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { status('Could not read this page.'); return; }
      if (!data || data.error) { status('Could not scan this page (' + (data && data.error) + ').'); return; }
      if (!S.profile) { status('Upload your CV in the app first.'); return; }
      var fields = data.fields || [];
      var meaningful = fields.filter(function (f) { return f.kind !== 'checkbox' || f.label; });
      if (meaningful.length < (auto ? 3 : 2)) {
        // automatic: only frames on known hiring systems; manual tap: any large web frame
        var fr = (data.frames || []).filter(function (f) { return /^https?:\/\//i.test(f.src || '') && (auto ? !!RH.jobs.atsOf(f.src) : (ATS.test(f.src) || (f.w > 250 && f.h > 300))); })[0];
        if (fr) { S.autoDone[pageUrl] = true; status('The form is embedded from another site — opening it directly…'); RH.nativeCall('loadInApply', fr.src); return; }
        if (!auto) status('No form found here. Tap the site\'s "Apply" button to open the form, then ⚡ Autofill again.');
        return;
      }
      if (auto && !autoFillAllowed(pageUrl)) {
        S.autoDone[pageUrl] = true;
        status('This form isn\'t on a known hiring site, so it wasn\'t filled automatically. Tap ⚡ Autofill to fill it.');
        return;
      }
      if (auto) S.autoDone[pageUrl] = true;
      S.lastAuto = !!auto;
      var aprof = (S.applyCv && S.applyCv.profile) || S.profile;
      var plan = RH.fillplan.plan(fields, aprof, S.answers, S.memory, S.applyJob && S.applyJob.company);
      var hasCv = !!(S.applyCv || S.cvMeta);
      var fills = plan.fills.filter(function (f) { return f.kind !== 'file' || hasCv; });
      var job = S.applyJob;
      var cacheKey = function (f) { return (job ? job.id : pageUrl) + '|' + U.norm(f.label); };
      var aiNeeded = plan.ai.filter(function (f) {
        var c = S.aiCache[cacheKey(f)];
        if (c != null) { fills.push({ id: f.id, kind: f.kind, value: c, source: 'ai', label: f.label }); return false; }
        return true;
      });
      status('Found ' + fields.length + ' fields — filling ' + fills.length + ' from your profile' + (aiNeeded.length ? ', writing ' + aiNeeded.length + ' answers with AI…' : '…'));
      var aiP = aiNeeded.length && RH.ai.available()
        ? RH.fillplan.aiAnswers(aiNeeded, aprof, S.answers, job, pageTitle, S.memory).catch(function (e) { S.lastAiError = String(e.message || e); return []; })
        : Promise.resolve([]);
      aiP.then(function (aiFills) {
        aiFills.forEach(function (f) { S.aiCache[cacheKey(f)] = f.value; });
        var all = fills.concat(aiFills);
        S.lastFill = { total: fields.length, planned: all.length, ai: aiFills.length + fills.filter(function (f) { return f.source === 'ai'; }).length, mem: all.filter(function (f) { return f.source === 'memory'; }).length, unanswered: aiNeeded.length - aiFills.length, noAi: aiNeeded.length && !RH.ai.available() };
        if (!all.length) { status('Nothing to fill on this page' + (S.lastAiError ? ' (AI: ' + S.lastAiError.slice(0, 80) + ')' : '') + '.'); return; }
        var needsFile = all.some(function (f) { return f.kind === 'file'; });
        RH.nativeCall('applyFills', JSON.stringify(all.map(function (f) { return { id: f.id, kind: f.kind, value: f.value, ai: f.source === 'ai' }; })), needsFile);
      });
    },
    onFilled: function (raw) {
      var r; try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { r = null; }
      var lf = S.lastFill || {};
      if (!r || r.error) { status('Fill failed: ' + (r && r.error || 'unknown error')); return; }
      var parts = [(S.lastAuto ? '⚡ Auto-filled ' : '✓ Filled ') + r.filled + ' of ' + lf.total + ' fields'];
      if (lf.ai) parts.push(lf.ai + ' by AI');
      if (lf.mem) parts.push(lf.mem + ' remembered');
      if (r.files) parts.push('CV attached');
      if (r.kept) parts.push(r.kept + ' you typed meanwhile left as is');
      var tail = (r.ai ? '. Yellow = written by AI, skim it' : '') + '. Review, complete blanks' + (lf.noAi ? ' (add an AI key to auto-answer questions)' : '') + ', then submit. Tap Save to remember your edits.';
      status(parts.join(', ') + tail);
      if (S.applyJob) { var t = S.tracker[S.applyJob.id]; if (t) { t.autofilled = (t.autofilled || 0) + 1; t.updated = Date.now(); saveTracker(); } }
    },
    onCapture: function (raw) {
      var r; try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { r = { items: [] }; }
      var res = RH.fillplan.remember(S.memory, (r && r.items) || [], S.profile, S.applyJob && S.applyJob.company);
      S.memory = res.memory; RH.store.set('memory', S.memory);
      status(res.added ? '💾 Saved ' + res.added + ' answer' + (res.added > 1 ? 's' : '') + ' — they\'ll be reused on future forms.' : 'Nothing new to save on this page.');
    }
  };

  // ------------------------------------------------------------------ TRACKER
  function viewTracker() {
    var items = Object.keys(S.tracker).map(function (k) { return S.tracker[k]; }).sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    var counts = { saved: 0, applying: 0, applied: 0, assessment: 0, interview: 0, offer: 0, rejected: 0 };
    items.forEach(function (t) { counts[t.status] = (counts[t.status] || 0) + 1; });
    var week = items.filter(function (t) { return t.appliedAt && Date.now() - t.appliedAt < 7 * 86400000; }).length;
    var mc = RH.mail.cfg(), segs = [['all', 'All'], ['saved', 'Saved'], ['applied', 'Applied'], ['interview', 'Next steps'], ['closed', 'Closed']];
    var h = '<div class="card"><div class="row"><div class="grow"><h2>Application tracker</h2><div class="muted small">' + (counts.applied + counts.assessment + counts.interview + counts.offer + counts.rejected) + ' applied • ' + week + ' this week • ' + (counts.assessment + counts.interview) + ' next steps</div></div></div>' +
      '<div class="row wrap" style="margin-top:10px">' + (mc ? '<button class="btn sm" data-act="checkMail"' + (S.mailBusy ? ' disabled' : '') + '>' + (S.mailBusy ? '<span class="spin"></span> Checking…' : '📧 Check email for replies') + '</button><span class="muted tiny">' + (mc.lastCheck ? 'checked ' + U.ago(mc.lastCheck) : '') + (mc.lastError ? ' • ' + esc(mc.lastError) : '') + '</span>'
        : '<button class="btn sm" data-act="go" data-tab="settings">📧 Connect email to track replies</button>') + '</div></div>';
    if (S.mailNote) h += '<div class="note info" style="margin-bottom:10px">' + esc(S.mailNote) + '</div>';
    h += '<div class="seg" style="margin-bottom:12px">' + segs.map(function (sg) { return '<button data-act="seg" data-seg="' + sg[0] + '" class="' + (S.trackerSeg === sg[0] ? 'on' : '') + '">' + sg[1] + '</button>'; }).join('') + '</div>';
    var list = items.filter(function (t) {
      var sg = S.trackerSeg;
      return sg === 'all' || (sg === 'saved' && (t.status === 'saved' || t.status === 'applying')) || (sg === 'applied' && t.status === 'applied') || (sg === 'interview' && (t.status === 'interview' || t.status === 'assessment')) || (sg === 'closed' && (t.status === 'offer' || t.status === 'rejected'));
    });
    if (!list.length) h += '<div class="card empty"><div class="big">🗂️</div><b>Nothing here yet</b><p class="small">Save jobs or apply with ⚡ Autofill — they\'ll show up here automatically.</p></div>';
    h += list.map(function (t) {
      var j = t.job, last = t.mail && t.mail[0];
      var quiet = t.status === 'applied' && t.appliedAt && Date.now() - t.appliedAt > 7 * 86400000 && !last;
      return '<div class="card" style="padding:12px 14px"><div class="row" data-act="openJob" data-id="' + esc(j.id) + '" style="cursor:pointer"><div class="grow"><b>' + esc(j.title) + '</b><div class="muted small">' + esc(j.company) + ' • ' + esc(t.site || j.source) + (t.autoDetected ? ' • auto-tracked' : '') + '</div></div>' +
        '<div class="score" style="--p:' + Math.round(j.score || 0) + ';--c:' + scoreColor(j.score || 0) + ';width:38px;height:38px;font-size:12px">' + Math.round(j.score || 0) + '</div></div>' +
        (last ? '<div class="small" style="margin-top:8px">' + (MAIL_ICON[last.type] || '📧') + ' <b>' + esc(last.subject) + '</b><div class="muted tiny">' + esc(last.from) + ' • ' + U.ago(last.date) + (t.mail.length > 1 ? ' • ' + t.mail.length + ' emails' : '') + '</div></div>' : '') +
        (quiet ? '<div class="tiny" style="margin-top:8px;color:var(--amber)">⏰ No reply for a week — check the portal or send a short follow-up.</div>' : '') +
        '<div class="row" style="margin-top:10px"><select data-status="' + esc(j.id) + '" class="grow" style="padding:7px 30px 7px 10px;font-size:13px">' +
        ['saved', 'applying', 'applied', 'assessment', 'interview', 'offer', 'rejected'].map(function (sv) { return '<option value="' + sv + '"' + (t.status === sv ? ' selected' : '') + '>' + statusLabel(sv) + '</option>'; }).join('') +
        '</select><button class="btn sm" data-act="checkStatus" data-id="' + esc(j.id) + '">Check status</button><button class="btn sm ghost" data-act="rmTrack" data-id="' + esc(j.id) + '">✕</button></div></div>';
    }).join('');
    var acc = RH.store.get('accounts', {}), hosts = Object.keys(acc).sort(function (a, b) { return (acc[b].last || 0) - (acc[a].last || 0); });
    if (hosts.length) {
      h += '<div class="muted tiny" style="margin:18px 4px 8px">MY JOB SITE ACCOUNTS</div><div class="card" style="padding:6px 14px">' + hosts.map(function (k) {
        var a = acc[k];
        return '<div class="setrow"><div class="grow"><b class="small">' + esc(k) + '</b><div class="muted tiny">' + (a.jobs || []).length + ' application' + ((a.jobs || []).length === 1 ? '' : 's') + ' • last used ' + U.ago(a.last) + '</div></div><button class="btn sm" data-act="openSite" data-url="' + esc(a.origin) + '">Open</button></div>';
      }).join('') + '<div class="muted tiny" style="padding:8px 0">You stay signed in to these inside the app. Let your phone\'s password manager save the passwords.</div></div>';
    }
    return h;
  }

  // ---------------- page reports from the apply browser (submitted / needs account)
  RH.onPageInfo = function (info) {
    if (!info || !S.applyJob) return;
    var j = S.applyJob, host = String(info.host || '').replace(/^www\./, '');
    if (info.hasPassword || info.login) {
      var acc = RH.store.get('accounts', {}), a = acc[host] || { host: host, origin: info.origin, first: Date.now(), jobs: [] };
      a.last = Date.now(); a.origin = info.origin; if (a.jobs.indexOf(j.id) < 0) a.jobs.push(j.id);
      acc[host] = a; RH.store.set('accounts', acc);
      var t0 = S.tracker[j.id]; if (t0) { t0.site = host; t0.portal = info.origin; saveTracker(); }
    }
    if (info.submitted) {
      var t = S.tracker[j.id];
      if (!t || ['saved', 'applying'].indexOf(t.status) >= 0) {
        track(j, 'applied'); t = S.tracker[j.id]; t.autoDetected = true; t.site = t.site || host; t.portal = t.portal || info.origin; saveTracker();
        RH.nativeCall('setApplyStatus', '✓ Application submitted — saved to your Tracker' + (RH.mail.cfg() ? '. Replies will be picked up from your email.' : '.'));
      }
    }
  };

  function checkMail(silent) {
    if (S.mailBusy || !RH.mail.cfg()) return Promise.resolve();
    S.mailBusy = true; if (!silent && S.tab === 'tracker') render();
    return RH.mail.check(S.tracker).then(function (r) {
      S.mailBusy = false; saveTracker();
      if (r.error) S.mailNote = silent ? '' : 'Email check failed: ' + r.error;
      else {
        var ch = r.updates.filter(function (u) { return u.changed; });
        S.mailNote = ch.length ? '📬 ' + ch.map(function (u) { return u.job.company + ': ' + statusLabel(u.type === 'received' ? 'applied' : u.type); }).join(' • ') : (silent ? '' : 'Checked ' + r.checked + ' recent emails — no new replies from companies you applied to.');
        if (ch.length && silent) toast('📬 ' + ch.length + ' application update' + (ch.length > 1 ? 's' : '') + ' from your email');
      }
      renderBadge(); if (S.tab === 'tracker' && $('#sheet').hidden) render();
    });
  }

  RH.onResume = function () {
    sitesAuto(false);
    var c = RH.mail.cfg();
    if (!isLocked() && c && (!c.lastCheck || Date.now() - c.lastCheck > 2 * 3600e3)) checkMail(true);
  };

  // ------------------------------------------------------------------ SETTINGS
  function viewSettings() {
    var s = RH.ai.settings(), P = RH.ai.PROVIDERS, pf = RH.jobs.prefs(), h = '';
    h += '<div class="card"><h2>AI providers</h2><p class="muted small">AI works out of the box. Optionally add your own <b>free</b> keys for more daily capacity — they are used top-to-bottom, switching automatically when a free limit is reached.</p>';
    s.order.forEach(function (id, i) {
      var p = s.providers[id], d = P[id], ok = p.key && p.enabled;
      if (id === 'builtin') {
        h += '<div class="prov' + (p.enabled ? ' ok' : '') + '"><div class="row"><div class="grow"><h4>✨ ' + esc(d.name) + '</h4><div class="muted tiny">' + esc(d.note) + ' Your own keys below (optional) are used first.</div></div>' +
          '<label class="switch"><input type="checkbox" data-prov-en="builtin"' + (p.enabled ? ' checked' : '') + '><i></i></label></div>' +
          '<div class="row" style="margin-top:10px"><button class="btn sm" data-act="testProv" data-id="builtin">Test</button><span class="tiny grow" id="test-builtin"></span></div></div>' +
          '<div class="muted tiny" style="margin:14px 2px 0">OPTIONAL — YOUR OWN FREE KEYS (more daily capacity)</div>';
        return;
      }
      h += '<div class="prov' + (ok ? ' ok' : '') + '"><div class="row"><div class="grow"><h4>' + i + '. ' + esc(d.name) + '</h4><div class="muted tiny">' + esc(d.note) + '</div></div>' +
        '<label class="switch"><input type="checkbox" data-prov-en="' + id + '"' + (p.enabled ? ' checked' : '') + '><i></i></label></div>' +
        (id === 'custom' ? field('Base URL (…/v1)', 'base', p.base, { ns: 'prov-' + id, ph: 'https://api.example.com/v1' }) : '') +
        '<label class="f"><span>API key' + (d.keyUrl ? ' — <a href="#" data-act="ext" data-url="' + d.keyUrl + '">get a free key ↗</a>' : '') + '</span><input type="password" data-prov-' + id + '="key" value="' + esc(p.key || '') + '" placeholder="Paste key" autocomplete="off"></label>' +
        '<label class="f"><span>Model</span><div class="row"><input data-prov-' + id + '="model" value="' + esc(p.model || '') + '" class="grow"><button class="btn sm" data-act="models" data-id="' + id + '">List</button></div></label>' +
        '<div class="row" style="margin-top:10px"><button class="btn sm" data-act="testProv" data-id="' + id + '">Test</button><span class="tiny grow" id="test-' + id + '"></span>' +
        '<button class="btn sm ghost" data-act="provUp" data-i="' + i + '"' + (i <= 1 ? ' disabled' : '') + '>↑</button><button class="btn sm ghost" data-act="provDown" data-i="' + i + '"' + (i === s.order.length - 1 ? ' disabled' : '') + '>↓</button></div></div>';
    });
    h += '<button class="btn primary block" data-act="saveAi">Save AI settings</button></div>';

    h += '<div class="card"><h2>Job sources</h2><p class="muted small"><b>Verified employers</b> are read straight from companies\' own hiring systems (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee) — the list grows automatically as new employers are found. The others are trusted remote-only boards and the monthly Hacker News hiring thread.</p>';
    Object.keys(RH.jobs.SOURCES).forEach(function (k) {
      h += '<div class="setrow"><div class="grow">' + esc(RH.jobs.SOURCES[k].name) + '</div><label class="switch"><input type="checkbox" data-src="' + k + '"' + (pf.sources[k] ? ' checked' : '') + '><i></i></label></div>';
    });
    h += '<div class="setrow"><div class="grow">Autofill automatically when a form opens<div class="muted tiny">Fills the application as soon as it loads — just review and submit</div></div><label class="switch"><input type="checkbox" data-pref="autoFill"' + (pf.autoFill ? ' checked' : '') + '><i></i></label></div>';
    h += '<div class="setrow"><div class="grow">Direct company links only<div class="muted tiny">Hide job-board / middleman listings that need an extra sign-up</div></div><label class="switch"><input type="checkbox" data-pref="directOnly"' + (pf.directOnly !== false ? ' checked' : '') + '><i></i></label></div>';
    h += '<div class="setrow"><div class="grow">Jobs I already applied to</div><select data-pref="appliedMode" style="width:150px"><option value="bottom"' + (pf.appliedMode !== 'hide' ? ' selected' : '') + '>Move to bottom</option><option value="hide"' + (pf.appliedMode === 'hide' ? ' selected' : '') + '>Hide</option></select></div>';
    h += '<div class="setrow"><div class="grow">Hide possible scams<div class="muted tiny">Fees, Telegram/WhatsApp-only contact, personal-email recruiters…</div></div><label class="switch"><input type="checkbox" data-pref="hideFlagged"' + (pf.hideFlagged ? ' checked' : '') + '><i></i></label></div>';
    h += '<div class="setrow"><div class="grow">Hide hybrid / on-site jobs</div><label class="switch"><input type="checkbox" data-pref="hideNotRemote"' + (pf.hideNotRemote ? ' checked' : '') + '><i></i></label></div>';
    h += '<div class="setrow"><div class="grow">Jobs ranked by AI per search<div class="muted tiny">More = better ranking, uses more free quota</div></div><select data-pref="aiRankCount" style="width:90px">' + [16, 24, 40, 64].map(function (n) { return '<option' + (pf.aiRankCount == n ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></div></div>';

    var mc = RH.mail.cfg(), mp = (mc && mc.provider) || S.mailProv || 'gmail', MP = RH.mail.PROVIDERS;
    h += '<div class="card"><h2>📧 Email tracking</h2><p class="muted small">Connect your inbox so replies from companies (assessments, interview invites, rejections, offers) update your Tracker automatically. Emails are read <b>on this phone only</b>, never sent to any server, and the app only reads, never sends or deletes.</p>';
    if (mc) {
      h += '<div class="kv"><b>Account</b><span>' + esc(mc.user) + '</span><b>Last check</b><span>' + (mc.lastCheck ? U.ago(mc.lastCheck) + (mc.lastCount != null ? ' (' + mc.lastCount + ' emails)' : '') : 'never') + '</span></div>' +
        (mc.lastError ? '<div class="sp"></div><div class="note err">' + esc(mc.lastError) + '</div>' : '') +
        '<div class="sp"></div><div class="row wrap"><button class="btn sm" data-act="checkMail">Check now</button><button class="btn sm danger" data-act="disconnectMail">Disconnect</button></div>';
    } else {
      h += '<label class="f"><span>Email provider</span><select data-mailprov="1">' + Object.keys(MP).map(function (k) { return '<option value="' + k + '"' + (k === mp ? ' selected' : '') + '>' + esc(MP[k].name) + '</option>'; }).join('') + '</select></label>' +
        (mp === 'other' ? field('IMAP server (e.g. imap.example.com)', 'host', '', { ns: 'mail' }) : '') +
        field('Email address', 'user', (S.profile && S.profile.email) || '', { ns: 'mail', type: 'email' }) +
        '<label class="f"><span>App password' + (MP[mp].help ? ' — <a href="#" data-act="ext" data-url="' + MP[mp].help + '">create one ↗</a>' : '') + '</span><input type="password" data-mail="pass" placeholder="16-character app password" autocomplete="off"></label>' +
        (mp === 'gmail' ? '<div class="muted tiny" style="margin-top:6px">Gmail: turn on 2-Step Verification, then Google Account → Security → <b>App passwords</b> → create one named "RemoteHunt". Use that, not your normal password.</div>' : '') +
        '<div class="sp"></div><button class="btn primary block" data-act="connectMail"' + (S.mailBusy ? ' disabled' : '') + '>' + (S.mailBusy ? '<span class="spin"></span> Connecting…' : 'Connect & test') + '</button>' +
        (S.mailErr ? '<div class="sp"></div><div class="note err">' + esc(S.mailErr) + '</div>' : '');
    }
    h += '</div>';
    var au = RH.store.get('auth', {}) || {};
    h += '<div class="card"><h2>Access</h2><div class="kv"><b>Code</b><span>' + esc((au.code || '').replace(/^(RH-\w{2})\w+/, '$1•••')) + '</span><b>Name</b><span>' + esc(au.name || '—') + '</span><b>Since</b><span>' + (au.at ? U.ago(au.at) : '—') + '</span></div></div>';
    h += '<div class="card"><h2>Your data</h2><p class="muted small">Everything (CV, profile, keys, tracker) is stored only on this phone. Your CV text and form questions are sent for AI processing to the RemoteHunt built-in AI relay (not stored or logged) or to providers whose keys you add.</p><div class="row wrap">' +
      '<button class="btn sm" data-act="export">Export backup</button><button class="btn sm" data-act="import">Import backup</button><button class="btn sm" data-act="clearCache">Clear job cache</button>' +
      '<button class="btn sm danger" data-act="reset">Erase everything</button></div></div>';
    h += '<div class="card"><h2>How autofill works</h2><ul class="tips"><li>Open a job and tap <b>⚡ Apply with Autofill</b>. The job page opens inside the app.</li>' +
      '<li>Jobs from verified employers open straight on the application form and are <b>filled automatically</b>. On other sites, press the site\'s own <b>Apply</b> button — autofill starts as soon as the form appears (or tap <b>⚡ Autofill</b>).</li>' +
      '<li>Name, email, phone, links, location, education, salary etc. come from your profile; your CV is attached to resume upload fields; open questions and cover letters are written by AI using your CV and the job description.</li>' +
      '<li>Always review before submitting. Tap <b>Save</b> after editing to remember your answers for next time.</li>' +
      '<li>Multi-page forms: tap ⚡ Autofill again on each page.</li></ul><div class="muted tiny" style="margin-top:10px">RemoteHunt v1.0 (personal) • jobs from employers’ own hiring pages (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee and more)</div></div>';
    return h;
  }

  function readAiForm() {
    var s = RH.ai.settings();
    s.order.forEach(function (id) {
      var p = s.providers[id];
      document.querySelectorAll('[data-prov-' + id + ']').forEach(function (el) { p[el.getAttribute('data-prov-' + id)] = el.value.trim(); });
      var en = document.querySelector('[data-prov-en="' + id + '"]'); if (en) p.enabled = en.checked;
    });
    return s;
  }

  // ------------------------------------------------------------------ events
  var ACT = {
    go: function (el) { go(el.getAttribute('data-tab')); },
    goJobs: function () { saveProfileForm(true); go('jobs'); if (!S.search.result) doSearch(); },
    pickCv: pickCv, analyze: analyze, verifyCode: verifyCode, analyzeAll: analyzeAll,
    autoUnlock: function () { S.lockMsg = ''; verifyCode(true); },
    showBoards: function () { S.showBoards = true; render(); },
    hideBoards: function () { S.showBoards = false; render(); },
    accounts: function () { if (!isLocked()) modal(viewAccounts()); },
    acctSwitch: function (el) { switchAccount(el.getAttribute('data-id')); },
    acctAdd: function () {
      var n = ($('#acctName') || {}).value || '';
      if (!n.trim()) { modal(viewAccounts('Type a name for the new account first.')); return; }
      switchAccount(RH.account.add(n));
    },
    acctRename: function () {
      var n = ($('#acctName') || {}).value || '';
      if (!n.trim()) { modal(viewAccounts('Type the new name first.')); return; }
      RH.account.rename(RH.account.currentId(), n); renderAcct(); modal(viewAccounts());
    },
    acctDelete: function () {
      var a = RH.account.current();
      modal('<h3>Delete "' + esc(a.name) + '"?</h3><p class="muted small">Deletes this account\'s CVs, answers, tracker and email settings from this phone. Other accounts are not affected.</p><div class="row"><button class="btn danger grow" data-act="acctDoDelete">Delete</button><button class="btn grow" data-act="closeModal">Cancel</button></div>');
    },
    acctDoDelete: function () { RH.account.remove(RH.account.currentId()); RH.nativeCall('closeApply'); location.reload(); },
    checkMail: function () { checkMail(false); },
    connectMail: function () {
      var v = {}; document.querySelectorAll('[data-mail]').forEach(function (el) { v[el.getAttribute('data-mail')] = el.value.trim(); });
      var prov = S.mailProv || 'gmail', host = prov === 'other' ? v.host : RH.mail.PROVIDERS[prov].host;
      if (!host || !v.user || !v.pass) { S.mailErr = 'Fill in the email address and app password.'; render(); return; }
      S.mailBusy = true; S.mailErr = ''; render();
      RH.mailFetch({ host: host, port: 993, user: v.user, pass: v.pass.replace(/\s+/g, ''), days: 2, max: 5 }).then(function (r) {
        S.mailBusy = false;
        if (r.status !== 200) { S.mailErr = r.error || 'Could not connect'; render(); return; }
        RH.mail.saveCfg({ provider: prov, host: host, port: 993, user: v.user, pass: v.pass.replace(/\s+/g, ''), connectedAt: Date.now() });
        toast('Email connected ✓'); render(); checkMail(true);
      });
    },
    disconnectMail: function () { RH.store.remove('mail.cfg'); S.mailNote = ''; toast('Email disconnected'); render(); },
    checkStatus: function (el) {
      var t = S.tracker[el.getAttribute('data-id')]; if (!t) return;
      S.applyJob = t.job; S.applyCv = cvForJob(t.job);
      RH.nativeCall('openApply', t.portal || t.job.applyUrl || t.job.url);
    },
    openSite: function (el) { S.applyJob = null; RH.nativeCall('openApply', el.getAttribute('data-url')); },
    useCv: function (el) { useCv(el.getAttribute('data-id')); render(); window.scrollTo(0, 0); },
    rmCv: function (el) {
      var id = el.getAttribute('data-id'), c = cvById(id); if (!c) return;
      modal('<h3>Remove this CV?</h3><p class="muted small">' + esc(cvLabel(c)) + ' — ' + esc(c.meta.name) + '</p><div class="row"><button class="btn danger grow" data-act="doRmCv" data-id="' + esc(id) + '">Remove</button><button class="btn grow" data-act="closeModal">Cancel</button></div>');
    },
    doRmCv: function (el) {
      var id = el.getAttribute('data-id');
      S.cvs = S.cvs.filter(function (c) { return c.id !== id; }); saveCvs();
      RH.nativeCall('deleteCvSlot', id); RH.store.remove('cv.b64.' + id); RH.store.remove('cv.text.' + id);
      if (S.activeCv === id) { S.activeCv = S.cvs[0] && S.cvs[0].id; }
      syncActive(); closeModal(); render();
    },
    saveProfile: function () { saveProfileForm(); render(); },
    addExp: function () { saveProfileForm(true); S.profile.experience = (S.profile.experience || []).concat([{ title: '', company: '', start: '', end: '', highlights: [] }]); render(); openSec(2); },
    rmExp: function (el) { saveProfileForm(true); S.profile.experience.splice(+el.getAttribute('data-i'), 1); RH.store.set('profile', S.profile); render(); openSec(2); },
    addEdu: function () { saveProfileForm(true); S.profile.education = (S.profile.education || []).concat([{ school: '', degree: '', field: '', start: '', end: '' }]); render(); openSec(3); },
    rmEdu: function (el) { saveProfileForm(true); S.profile.education.splice(+el.getAttribute('data-i'), 1); RH.store.set('profile', S.profile); render(); openSec(3); },
    rmMemo: function (el) { S.memory.splice(+el.getAttribute('data-i'), 1); RH.store.set('memory', S.memory); render(); openSec(5); },
    search: doSearch,
    more: function () { S.showCount += 30; render(); },
    rmQuery: function (el) { var qs = queries().slice(); qs.splice(+el.getAttribute('data-i'), 1); S.queries = qs; RH.store.set('jobs.queries', qs); render(); },
    addQuery: function (el) { addQuery(el.getAttribute('data-q')); render(); },
    addQueryInput: function () { saveQueryInput(); render(); },
    openJob: function (el) { openJob(el.getAttribute('data-id')); },
    closeSheet: function () {
      var back = S.sheetJob && S.returnSite;
      closeSheet();
      if (back) { openSite(back); return; }
      S.returnSite = null; render();
    },
    openSite: function (el) { S.siteShow = 60; openSite(el.getAttribute('data-id')); },
    siteMore: function () { S.siteShow = (S.siteShow || 60) + 60; var y = $('#sheet').scrollTop; openSite(S.returnSite); $('#sheet').scrollTop = y; },
    siteAdd: function () {
      var inp = $('#siteUrl'), url = inp ? inp.value.trim() : '';
      S.siteDraft = url;
      if (!url) { S.siteMsg = 'Paste the link of a jobs page first.'; S.siteMsgErr = true; render(); return; }
      S.siteAdding = true; S.siteMsg = 'Reading the site…'; S.siteMsgErr = false; render();
      RH.sites.add(url).then(function (st) {
        var n = RH.sites.count(st);
        var all = RH.sites.total(st);
        S.siteMsg = '✓ Following ' + st.name + ': ' + (st.remoteOnly && all > n ? n + ' remote job' + (n === 1 ? '' : 's') + ' (' + all + ' in total)' : n + ' job' + (n === 1 ? '' : 's')) + ' there now. New ones will be marked NEW.' +
          (st.kind === 'page' && !st.jobs.length ? ' No job links were found: this page builds its job list with JavaScript, so new jobs can\'t be detected. Try the company\'s Greenhouse, Lever or Ashby link instead.' : '');
        S.siteMsgErr = false; S.siteDraft = '';
      }, function (e) { S.siteMsg = String(e && e.message || e); S.siteMsgErr = true; }).then(function () { S.siteAdding = false; render(); });
    },
    sitesCheck: function () { sitesAuto(true); },
    siteRemove: function (el) { RH.sites.remove(el.getAttribute('data-id')); S.returnSite = null; closeSheet(); render(); renderBadge(); toast('Stopped following'); },
    closeModal: closeModal,
    ext: function (el) { var u = el.getAttribute('data-url'); if (RH.isNative) RH.nativeCall('openExternal', u); else window.open(u, '_blank'); },
    apply: startApply,
    cover: function () { coverLetter(false); },
    regenCover: function () { coverLetter(true); },
    copyCover: function () { var t = $('#coverTxt').value; if (RH.isNative) RH.nativeCall('copy', t); else if (navigator.clipboard) navigator.clipboard.writeText(t); toast('Copied'); },
    shareCover: function () { var t = $('#coverTxt').value; if (RH.isNative) RH.nativeCall('share', t); else if (navigator.share) navigator.share({ text: t }); },
    toggleSave: function () { var j = S.sheetJob; if (S.tracker[j.id]) { delete S.tracker[j.id]; saveTracker(); toast('Removed from tracker'); } else { track(j, 'saved'); toast('Saved to tracker'); } openJob(j.id); },
    markApplied: function () { track(S.sheetJob, 'applied'); toast('Marked as applied'); openJob(S.sheetJob.id); },
    confirmApplied: function () { if (S.applyJob) track(S.applyJob, 'applied'); closeModal(); toast('Marked as applied ✓'); if (S.sheetJob) openJob(S.sheetJob.id); else render(); },
    seg: function (el) { S.trackerSeg = el.getAttribute('data-seg'); render(); },
    rmTrack: function (el) { delete S.tracker[el.getAttribute('data-id')]; saveTracker(); render(); },
    saveAi: function () { RH.ai.saveSettings(readAiForm()); toast('AI settings saved'); render(); },
    testProv: function (el) {
      var id = el.getAttribute('data-id'); RH.ai.saveSettings(readAiForm());
      var out = $('#test-' + id); out.textContent = 'Testing…'; out.style.color = 'var(--muted)';
      RH.ai.testProvider(id).then(function (r) { out.textContent = '✓ Works (' + r.model + ')'; out.style.color = 'var(--green)'; var m = document.querySelector('[data-prov-' + id + '="model"]'); if (m) m.value = r.model; renderBadge(); },
        function (e) { out.textContent = '✕ ' + String(e.message || e).slice(0, 140); out.style.color = '#fca5a5'; });
    },
    models: function (el) {
      var id = el.getAttribute('data-id'); RH.ai.saveSettings(readAiForm());
      var out = $('#test-' + id); out.textContent = 'Loading models…';
      RH.ai.listModels(id).then(function (list) {
        out.textContent = list.length + ' models';
        var cur = document.querySelector('[data-prov-' + id + '="model"]');
        var sel = document.createElement('select');
        sel.className = 'grow'; sel.setAttribute('data-prov-' + id, 'model');
        list.sort().forEach(function (m) { var o = document.createElement('option'); o.textContent = m; if (m === cur.value) o.selected = true; sel.appendChild(o); });
        if (list.indexOf(cur.value) < 0) { var o = document.createElement('option'); o.textContent = cur.value; o.selected = true; sel.insertBefore(o, sel.firstChild); }
        cur.replaceWith(sel);
      }, function (e) { out.textContent = '✕ ' + String(e.message || e).slice(0, 120); });
    },
    provUp: function (el) { moveProv(+el.getAttribute('data-i'), -1); },
    provDown: function (el) { moveProv(+el.getAttribute('data-i'), 1); },
    clearCache: function () { RH.jobs.clearCache(); RH.store.remove('rank.cache'); toast('Job cache cleared'); },
    export: function () {
      var data = { v: 1, at: Date.now(), profile: S.profile, answers: S.answers, memory: S.memory, tracker: S.tracker, queries: S.queries, ai: RH.ai.settings(), prefs: RH.jobs.prefs() };
      var txt = JSON.stringify(data);
      modal('<h3>Backup</h3><p class="muted small">Contains your profile, answers, tracker and API keys (keep it private). Your CV file is not included.</p><textarea id="bk" rows="8">' + esc(txt) + '</textarea><div class="sp"></div><div class="row"><button class="btn sm primary" data-act="copyBk">Copy</button><button class="btn sm" data-act="shareBk">Share</button><div class="grow"></div><button class="btn sm ghost" data-act="closeModal">Close</button></div>');
    },
    copyBk: function () { var t = $('#bk').value; if (RH.isNative) RH.nativeCall('copy', t); else if (navigator.clipboard) navigator.clipboard.writeText(t); },
    shareBk: function () { var t = $('#bk').value; if (RH.isNative) RH.nativeCall('share', t); },
    import: function () { modal('<h3>Import backup</h3><textarea id="bkIn" rows="8" placeholder="Paste backup JSON"></textarea><div class="sp"></div><div class="row"><button class="btn sm primary" data-act="doImport">Import</button><div class="grow"></div><button class="btn sm ghost" data-act="closeModal">Cancel</button></div>'); },
    doImport: function () {
      try {
        var d = JSON.parse($('#bkIn').value);
        if (d.profile) { S.profile = d.profile; RH.store.set('profile', d.profile); }
        if (d.answers) { S.answers = Object.assign(RH.cv.defaultAnswers(), d.answers); RH.store.set('answers', S.answers); }
        if (d.memory) { S.memory = d.memory; RH.store.set('memory', d.memory); }
        if (d.tracker) {
          // a backup is untrusted text: keep only known statuses
          var OK_STATUS = /^(saved|applying|applied|assessment|interview|offer|rejected)$/;
          Object.keys(d.tracker).forEach(function (k) { var t = d.tracker[k]; if (!t || typeof t !== 'object') delete d.tracker[k]; else if (!OK_STATUS.test(t.status)) t.status = 'saved'; });
          S.tracker = d.tracker; saveTracker();
        }
        if (d.queries) { S.queries = d.queries; RH.store.set('jobs.queries', d.queries); }
        if (d.ai) RH.ai.saveSettings(d.ai);
        if (d.prefs) RH.jobs.savePrefs(d.prefs);
        closeModal(); toast('Backup imported'); render();
      } catch (e) { toast('Invalid backup: ' + e.message); }
    },
    reset: function () { modal('<h3>Erase everything?</h3><p class="muted small">Deletes your profile, answers, tracker and API keys from this app.</p><div class="row"><button class="btn danger grow" data-act="doReset">Erase</button><button class="btn grow" data-act="closeModal">Cancel</button></div>'); },
    doReset: function () {
      ['profile', 'answers', 'memory', 'tracker', 'jobs.queries', 'jobs.last', 'jobs.prefs', 'ai.settings', 'rank.cache', 'cv.text', 'cv.b64', 'cv.meta.web', 'cv.meta', 'mail.cfg', 'accounts'].forEach(function (k) { RH.store.remove(k); });
      RH.jobs.clearCache();
      S.cvs.forEach(function (c) { RH.nativeCall('deleteCvSlot', c.id); RH.store.remove('cv.b64.' + c.id); RH.store.remove('cv.text.' + c.id); });
      ['cvs', 'cv.activeId', 'jobs.cvMode'].forEach(function (k) { RH.store.remove(k); });
      S.cvs = []; S.activeCv = null;
      S.profile = null; S.answers = RH.cv.defaultAnswers(); S.memory = []; S.tracker = {}; S.queries = null; S.search.result = null; S.cvMeta = null;
      closeModal(); go('profile');
    }
  };
  function moveProv(i, d) {
    var s = readAiForm(), j = i + d; if (j < 1 || j >= s.order.length || i < 1) return;
    var t = s.order[i]; s.order[i] = s.order[j]; s.order[j] = t; RH.ai.saveSettings(s); render();
  }
  function openSec(n) { var d = document.querySelectorAll('details.sec')[n]; if (d) { d.open = true; } }

  document.addEventListener('click', function (e) {
    var tab = e.target.closest('#tabs button');
    if (tab) { if (S.tab === 'profile' && S.profile) saveProfileForm(true); go(tab.getAttribute('data-tab')); return; }
    var a = e.target.closest('a[data-ext]');
    if (a) { e.preventDefault(); ACT.ext({ getAttribute: function () { return a.getAttribute('href'); } }); return; }
    var el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.tagName === 'A') e.preventDefault();
    var fn = ACT[el.getAttribute('data-act')];
    if (fn) fn(el, e);
  });
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.hasAttribute('data-pref')) {
      var pf = RH.jobs.prefs(), k = el.getAttribute('data-pref');
      pf[k] = el.type === 'checkbox' ? el.checked : (/^\d+$/.test(el.value) ? +el.value : el.value);
      RH.jobs.savePrefs(pf);
      if (k === 'autoFill') RH.store.set('autofill.auto', !!pf.autoFill);
      if (k === 'appliedMode' || k === 'directOnly') { render(); return; }
      if (k === 'sort' && S.search.result) { RH.jobs.sortJobs(S.search.result, pf.sort); render(); }
      return;
    }
    if (el.hasAttribute('data-site-remote')) { var sid = el.getAttribute('data-site-remote'); RH.sites.setRemoteOnly(sid, el.checked); openSite(sid); renderBadge(); return; }
    if (el.hasAttribute('data-mailprov')) { S.mailProv = el.value; S.mailErr = ''; render(); return; }
    if (el.hasAttribute('data-cvlabel')) { var lc = cvById(el.getAttribute('data-cvlabel')); if (lc) { lc.label = el.value.trim(); saveCvs(); } return; }
    if (el.hasAttribute('data-cvmode')) {
      var v = el.value; S.searchCv = v === 'all' ? 'all' : 'active'; RH.store.set('jobs.cvMode', S.searchCv);
      if (v !== 'all') useCv(v); else { S.queries = null; RH.store.remove('jobs.queries'); }
      render(); return;
    }
    if (el.hasAttribute('data-src')) { var p2 = RH.jobs.prefs(); p2.sources[el.getAttribute('data-src')] = el.checked; RH.jobs.savePrefs(p2); return; }
    if (el.hasAttribute('data-status')) {
      var id = el.getAttribute('data-status'); var t = S.tracker[id];
      if (t) { t.status = el.value; t.updated = Date.now(); if (el.value === 'applied' && !t.appliedAt) t.appliedAt = Date.now(); saveTracker(); render(); }
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.id === 'qInput') { e.preventDefault(); ACT.addQueryInput(); }
    if (e.key === 'Enter' && e.target.id === 'codeIn') { e.preventDefault(); verifyCode(); }
    if (e.key === 'Enter' && e.target.id === 'siteUrl') { e.preventDefault(); ACT.siteAdd(); }
  });

  // ------------------------------------------------------------------ boot
  loadCvMeta();
  RH.store.set('autofill.auto', !!RH.jobs.prefs().autoFill);
  S.tab = S.profile ? 'jobs' : 'profile';
  render();
  checkAccess();
  sitesAuto(false);
})(window);
