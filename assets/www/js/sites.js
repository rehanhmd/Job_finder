/* My sites: websites you follow. The app checks them and shows the jobs that appeared since you last looked.
 * - Company hiring pages (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee) are read through their
 *   public job APIs, so every job comes with its location and a direct application link. A company's own careers
 *   page that embeds one of these is recognised too.
 * - Any other page is read as HTML: links that look like job postings are listed, and new links are "new jobs".
 * Sites are stored per account (key "sites"). */
(function (g) {
  var RH = g.RH, U = RH.util;
  var MAX_JOBS = 300, CHECK_EVERY = 30 * 60000, FORGET_AFTER = 60 * 86400000;

  var REMOTE = /\b(remote|anywhere|work from home|wfh|distributed|worldwide|global)\b/i;
  var NOT_REMOTE = /\b(hybrid|on-?site|in[- ]office)\b/i;
  function remoteLoc(l) { return REMOTE.test(l) && !NOT_REMOTE.test(l); }
  function ms(v) { if (!v) return 0; if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; var t = Date.parse(String(v).replace(' UTC', 'Z').replace(' ', 'T')); return isNaN(t) ? 0 : t; }
  function money(min, max, cur, per) {
    min = Number(min) || 0; max = Number(max) || 0; if (!min && !max) return '';
    var f = function (n) { return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); };
    var c = !cur || cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur + ' ';
    return c + (min && max && min !== max ? f(min) + '–' + f(max) : f(max || min)) + (per && !/year|annual/i.test(per) ? '/' + String(per).toLowerCase().replace(/ly$/, '') : '');
  }
  function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  function pretty(slug) { return String(slug || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  // ---------------------------------------------------------------- recognise hiring systems
  var NOT_SLUG = /^(embed|static|api|v\d|j|oneclick|www|careers|jobs|job|search|login|apply|assets|js|css|widget)$/i;
  var ATS_PATTERNS = [
    ['greenhouse', /greenhouse\.io\/embed\/job_(?:board|app)(?:\/js)?\?(?:[^"'\s<>]*?&(?:amp;)?)?for=([a-z0-9_-]+)/i],
    ['greenhouse', /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/i],
    ['greenhouse', /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i],
    ['lever', /(?:jobs|api)(?:\.eu)?\.lever\.co\/(?:v0\/postings\/)?([a-z0-9_.-]+)/i],
    ['ashby', /jobs\.ashbyhq\.com\/([^/?#"'\s<>]+)/i],
    ['ashby', /api\.ashbyhq\.com\/posting-api\/job-board\/([^/?#"'\s<>]+)/i],
    ['workable', /apply\.workable\.com\/(?:api\/v\d\/(?:widget\/)?accounts\/)?([a-z0-9_-]+)/i],
    ['smartrecruiters', /(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)/i],
    ['recruitee', /\b([a-z0-9-]+)\.recruitee\.com/i]
  ];
  /** First hiring-system board named in a URL or a page's HTML → {ats, slug} or null. */
  function atsFrom(text) {
    text = String(text || '');
    for (var i = 0; i < ATS_PATTERNS.length; i++) {
      var re = new RegExp(ATS_PATTERNS[i][1].source, 'gi'), m;
      while ((m = re.exec(text))) {
        var slug = m[1]; try { slug = decodeURIComponent(slug); } catch (e) { }
        if (slug && !NOT_SLUG.test(slug) && /^[\w.\- ]{2,80}$/.test(slug)) return { ats: ATS_PATTERNS[i][0], slug: slug };
      }
    }
    return null;
  }

  function boardUrl(ats, slug) {
    var s = encodeURIComponent(slug);
    return {
      greenhouse: 'https://boards-api.greenhouse.io/v1/boards/' + s + '/jobs',
      lever: 'https://api.lever.co/v0/postings/' + s + '?mode=json',
      ashby: 'https://api.ashbyhq.com/posting-api/job-board/' + s + '?includeCompensation=true',
      smartrecruiters: 'https://api.smartrecruiters.com/v1/companies/' + s + '/postings?limit=100',
      workable: 'https://apply.workable.com/api/v1/widget/accounts/' + s,
      recruitee: 'https://' + s + '.recruitee.com/api/offers/'
    }[ats];
  }

  /** A board's API answer → {name, jobs} in the compact feed format (all jobs; r = remote or not). */
  function parseBoard(ats, slug, data) {
    var out = [], name = '';
    var add = function (j) { j.t = String(j.t || '').replace(/\s+/g, ' ').trim(); if (j.i && j.t) out.push(j); };
    if (ats === 'greenhouse') {
      (data.jobs || []).forEach(function (j) {
        var loc = (j.location && j.location.name) || ''; name = name || j.company_name || '';
        add({ i: String(j.id), t: j.title, l: loc, u: j.absolute_url, a: 'https://job-boards.greenhouse.io/embed/job_app?for=' + slug + '&token=' + j.id, p: ms(j.first_published || j.updated_at), r: remoteLoc(loc) });
      });
    } else if (ats === 'lever') {
      (Array.isArray(data) ? data : []).forEach(function (j) {
        var c = j.categories || {}, loc = [c.location].concat(c.allLocations || []).filter(Boolean).join(' / '), wt = String(j.workplaceType || '').toLowerCase(), sr = j.salaryRange || {};
        add({ i: j.id, t: j.text, l: loc, d: c.team || c.department || '', e: c.commitment || '', u: j.hostedUrl, a: j.applyUrl || (j.hostedUrl + '/apply'), p: ms(j.createdAt),
          s: money(sr.min, sr.max, sr.currency, sr.interval), x: String(j.descriptionPlain || '').replace(/\s+/g, ' ').slice(0, 700), r: wt === 'remote' || (wt !== 'hybrid' && wt !== 'onsite' && remoteLoc(loc)) });
      });
    } else if (ats === 'ashby') {
      (data.jobs || []).forEach(function (j) {
        if (j.isListed === false) return;
        var wt = String(j.workplaceType || '').toLowerCase(), loc = [j.location].concat((j.secondaryLocations || []).map(function (s) { return s.location; })).filter(Boolean).join(' / ');
        add({ i: j.id, t: j.title, l: loc, d: j.department || j.team || '', e: j.employmentType || '', u: j.jobUrl, a: j.applyUrl || (j.jobUrl + '/application'), p: ms(j.publishedAt),
          s: (j.compensation && (j.compensation.compensationTierSummary || j.compensation.scrapeableCompensationSalarySummary)) || '',
          x: String(j.descriptionPlain || U.stripHtml(j.descriptionHtml || '')).replace(/\s+/g, ' ').slice(0, 700), r: wt === 'remote' || (!!j.isRemote && wt !== 'hybrid' && wt !== 'onsite') });
      });
    } else if (ats === 'smartrecruiters') {
      (data.content || []).forEach(function (j) {
        var l = j.location || {}, cid = (j.company && j.company.identifier) || slug; name = name || (j.company && j.company.name) || '';
        add({ i: String(j.id), t: j.name, l: [l.remote || l.fullyRemote ? 'Remote' : '', l.city, l.country && String(l.country).toUpperCase()].filter(Boolean).join(', '),
          d: (j.department && j.department.label) || '', e: (j.typeOfEmployment && j.typeOfEmployment.label) || '', u: 'https://jobs.smartrecruiters.com/' + cid + '/' + j.id,
          a: 'https://jobs.smartrecruiters.com/oneclick-ui/company/' + cid + '/publication/' + (j.uuid || j.id), p: ms(j.releasedDate), r: !!(l.remote || l.fullyRemote) && !l.hybrid });
      });
    } else if (ats === 'workable') {
      name = data.name || '';
      (data.jobs || []).forEach(function (j) {
        var loc = (j.locations && j.locations.length ? j.locations.map(function (x) { return [x.city, x.country].filter(Boolean).join(', '); }).join(' / ') : [j.city, j.country].filter(Boolean).join(', '));
        var remote = (j.telecommuting === true || String(j.workplace || '').toLowerCase() === 'remote') && String(j.workplace || '').toLowerCase() !== 'hybrid';
        add({ i: j.shortcode, t: j.title, l: (remote ? 'Remote' + (loc ? ' — ' : '') : '') + loc, d: j.department || '', e: j.employment_type || '', u: j.url || j.shortlink, a: j.application_url || ((j.url || '') + '/apply'), p: ms(j.published_on || j.created_at), r: remote });
      });
    } else if (ats === 'recruitee') {
      (data.offers || []).forEach(function (j) {
        var sal = j.salary || {}, remote = j.remote === true && !j.hybrid && !j.on_site; name = name || j.company_name || '';
        add({ i: String(j.id), t: j.title, l: [remote ? 'Remote' : '', j.location || [j.city, j.country].filter(Boolean).join(', ')].filter(Boolean).join(' — '), d: j.department || '',
          e: j.employment_type_code || '', u: j.careers_url, a: j.careers_apply_url || j.careers_url, p: ms(j.published_at || j.created_at), s: money(sal.min, sal.max, sal.currency, sal.period), x: U.stripHtml(j.description || '').slice(0, 700), r: remote });
      });
    }
    return { name: name, jobs: out };
  }

  // ---------------------------------------------------------------- any other page: links that look like job postings
  var JOB_PATH = /\/(jobs?|careers?|positions?|openings?|vacanc(y|ies)|roles?|opportunit(y|ies)|postings?|job-?board|apply)(\/|$|-|\?)/i;
  var TITLE_WORD = /\b(engineer|developer|designer|manager|scientist|analyst|architect|lead|director|specialist|trainer|tutor|writer|editor|reviewer|annotator|evaluator|expert|consultant|coordinator|associate|assistant|intern|researcher|translator|linguist|marketer|recruiter|representative|administrator|technician|tester|contractor|freelance|accountant|counsel|teacher|instructor)s?\b/i;
  var NAV = /^(home|about( us)?|blog|news|press|log ?in|sign ?(in|up)|register|contact( us)?|privacy( policy)?|terms.*|cookies?.*|faq|help|our team|team|careers?|jobs|all jobs|view (all )?jobs|see all.*|open (positions|roles)|apply|apply now|learn more|read more|menu|search|next|previous|back|benefits|culture|life at .*|why join .*|(explore|view|see|browse|search|find)\b.*\b(roles|jobs|positions|openings|opportunities)|.*\b(open roles|open positions|all (open )?(roles|jobs|positions)))$/i;
  // links on a careers page that lead to the actual list of jobs
  var LIST_LINK = /\b(open (roles|positions|jobs)|(view|explore|see|browse|search) (all |open )?(roles|jobs|positions|openings|opportunities)|(current|job|all) (openings|jobs|roles)|job board|careers?|jobs|join (us|our team)|work with us)\b/i;
  function listLinks(html, base) {
    if (typeof DOMParser === 'undefined') return [];
    var doc = new DOMParser().parseFromString(String(html || ''), 'text/html'), ats = [], other = [], seen = {};
    var self = String(base || '').split('#')[0].replace(/\/$/, ''), baseHost = host(base);
    Array.prototype.forEach.call(doc.querySelectorAll('a[href]'), function (a) {
      var href; try { href = new URL(a.getAttribute('href'), base).href.split('#')[0]; } catch (e) { return; }
      if (!/^https?:/i.test(href) || seen[href] || href.replace(/\/$/, '') === self) return;
      seen[href] = 1;
      if (atsFrom(href)) { ats.push(href); return; }
      var text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (host(href) === baseHost && (LIST_LINK.test(text) || /\/(careers?|jobs|openings|positions)\/?$/i.test(new URL(href).pathname))) other.push(href);
    });
    return ats.concat(other).slice(0, 3);
  }
  // "Careers \ Labelbox", "Careers at Scale AI", "Jobs | Acme" -> "Labelbox", "Scale AI", "Acme"
  function cleanName(title, fallback) {
    var parts = String(title || '').split(/\s*[|\\–—]\s*|\s+-\s+/).map(function (x) {
      return x.replace(/\b(careers?|jobs?|open (roles|positions)|join (us|our team)|work (with|at) us|we('re| are) hiring|at|in)\b/gi, ' ').replace(/^[\s&,:]+|[\s&,:]+$/g, '').replace(/\s+/g, ' ').trim();
    }).filter(function (x) { return x.length >= 2; });
    // the brand is usually the shortest part ("Train the next generation of AI | Outlier AI" -> "Outlier AI")
    parts.sort(function (a, b) { return a.length - b.length; });
    return parts[0] || fallback || '';
  }

  /** A page with no readable jobs: try the company's likely board names on the big hiring systems. */
  function probeBoards(name, url) {
    var word = (host(url).split('.').slice(-2, -1)[0] || '').toLowerCase(), n = U.norm(name);
    var cands = U.uniq([word, n.replace(/ /g, ''), n.replace(/ /g, '-'), word + 'ai', word + 'hq'].filter(function (c) { return /^[a-z0-9-]{2,40}$/.test(c); })).slice(0, 4);
    var tries = []; cands.forEach(function (c) { ['greenhouse', 'lever', 'ashby'].forEach(function (a) { tries.push({ ats: a, slug: c }); }); });
    var i = 0;
    var next = function () {
      if (i >= tries.length) return null;
      var t = tries[i++];
      return RH.http({ url: boardUrl(t.ats, t.slug), headers: { Accept: 'application/json' }, timeout: 15000 }).then(function (r) {
        if (r.status !== 200) return next();
        var d; try { d = JSON.parse(r.body); } catch (e) { return next(); }
        var b = parseBoard(t.ats, t.slug, d);
        if (!b.jobs.length) return next();
        // only accept it when the board is clearly this company (its own name matches, or the slug is the site's name)
        var bn = U.norm(b.name).replace(/\b(inc|llc|ltd|gmbh|corp|co|technologies|technology|labs|hq)\b/g, '').replace(/ /g, '');
        var same = bn ? (bn === word || bn === n.replace(/ /g, '')) : (t.slug === word || t.slug === n.replace(/ /g, ''));
        return same ? { kind: 'ats', ats: t.ats, slug: t.slug, url: url, name: b.name || name, guessed: true } : next();
      }, next);
    };
    return next();
  }
  function pageJobs(html, base) {
    if (typeof DOMParser === 'undefined') return [];
    var doc = new DOMParser().parseFromString(String(html || ''), 'text/html'), seen = {}, out = [];
    var self = String(base || '').split('#')[0].replace(/\/$/, '');
    Array.prototype.forEach.call(doc.querySelectorAll('a[href]'), function (a) {
      var href; try { href = new URL(a.getAttribute('href'), base).href.split('#')[0]; } catch (e) { return; }
      if (!/^https?:/i.test(href) || seen[href] || href.replace(/\/$/, '') === self) return;
      var text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 4 || text.length > 140 || NAV.test(text)) return;
      if (a.closest && a.closest('nav, header, footer, [role=navigation]')) return; // site menus, not postings
      var path = ''; try { path = new URL(href).pathname; } catch (e) { return; }
      var deep = path.split('/').filter(Boolean).length >= 2, words = text.split(' ').length;
      var byPath = JOB_PATH.test(path) && deep && !/\/(blog|news|press|stories|articles?)\//i.test(path);
      var byTitle = TITLE_WORD.test(text) && words >= 2 && !/^(our|meet|about|for|become|join|why|how|what)\b/i.test(text) && !/\/(blog|news|press|stories|articles?)\//i.test(path);
      if (!(byPath || byTitle)) return;
      seen[href] = 1;
      out.push({ i: href, t: text, u: href, a: href });
    });
    return { name: (doc.title || '').replace(/\s+/g, ' ').trim().slice(0, 60), jobs: out.slice(0, MAX_JOBS) };
  }

  // ---------------------------------------------------------------- storage (per account)
  function list() { var l = RH.store.get('sites', []); return Array.isArray(l) ? l : []; }
  function save(l) { RH.store.set('sites', l); }
  function byId(id) { return list().filter(function (s) { return s.id === id; })[0] || null; }
  function update(site) { var l = list(); for (var i = 0; i < l.length; i++) if (l[i].id === site.id) l[i] = site; save(l); }

  function normUrl(u) {
    u = String(u || '').trim();
    if (u && !/^[a-z]+:\/\//i.test(u)) u = 'https://' + u;
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(u)) throw new Error('Paste a full web address, e.g. jobs.ashbyhq.com/company');
    return u;
  }

  /** Work out what kind of site a link is: a hiring-system board (directly, or embedded in a careers page) or a plain page. */
  function resolve(url) {
    try { url = normUrl(url); } catch (e) { return Promise.reject(e); }
    var hit = atsFrom(url);
    if (hit) return Promise.resolve({ kind: 'ats', ats: hit.ats, slug: hit.slug, url: url, name: pretty(hit.slug) });
    return RH.http({ url: url, timeout: 30000 }).then(function (r) {
      if (!r.status) throw new Error('Could not open this page' + (r.error ? ' (' + String(r.error).slice(0, 80) + ')' : ''));
      if (r.status >= 400) throw new Error('This page answered HTTP ' + r.status);
      var finalUrl = r.url || url, emb = atsFrom(finalUrl) || atsFrom(r.body), here = pageJobs(r.body, finalUrl);
      var siteName = cleanName(here.name, pretty(host(finalUrl).split('.').slice(-2, -1)[0] || host(finalUrl)));
      if (emb) return { kind: 'ats', ats: emb.ats, slug: emb.slug, url: url, name: pretty(emb.slug), pageName: siteName };
      var best = { kind: 'page', url: finalUrl, name: siteName, n: here.jobs.length };
      if (here.jobs.length >= 3) return best;
      // few or no jobs here: follow the page's own "Open roles" / "Careers" links (one level)
      var links = listLinks(r.body, finalUrl), i = 0;
      var next = function () {
        if (i >= links.length) return best;
        var link = links[i++], direct = atsFrom(link);
        if (direct) return { kind: 'ats', ats: direct.ats, slug: direct.slug, url: url, name: pretty(direct.slug), pageName: siteName };
        return RH.http({ url: link, timeout: 30000 }).then(function (r2) {
          if (r2.status !== 200) return next();
          var e2 = atsFrom(r2.url || link) || atsFrom(r2.body);
          if (e2) return { kind: 'ats', ats: e2.ats, slug: e2.slug, url: url, name: pretty(e2.slug), pageName: siteName };
          var j2 = pageJobs(r2.body, r2.url || link);
          if (j2.jobs.length > best.n) best = { kind: 'page', url: r2.url || link, name: siteName, n: j2.jobs.length };
          return next();
        }, next);
      };
      return Promise.resolve(next()).then(function (res) {
        if (res.kind !== 'page' || res.n) return res;
        return probeBoards(siteName, finalUrl).then(function (pb) { return pb || res; });
      });
    });
  }

  function fetchJobs(site) {
    if (site.kind === 'ats') {
      return RH.http({ url: boardUrl(site.ats, site.slug), headers: { Accept: 'application/json' }, timeout: 45000 }).then(function (r) {
        if (r.status === 404) throw new Error('This board no longer exists (404)');
        if (r.status !== 200) throw new Error(r.status ? 'HTTP ' + r.status : 'No connection' + (r.error ? ': ' + String(r.error).slice(0, 80) : ''));
        var d; try { d = JSON.parse(r.body); } catch (e) { throw new Error('Unexpected answer from the hiring system'); }
        return parseBoard(site.ats, site.slug, d);
      });
    }
    return RH.http({ url: site.url, timeout: 45000 }).then(function (r) {
      if (r.status !== 200) throw new Error(r.status ? 'HTTP ' + r.status : 'No connection' + (r.error ? ': ' + String(r.error).slice(0, 80) : ''));
      return pageJobs(r.body, r.url || site.url);
    });
  }

  /** Check one site: refresh its job list; jobs not seen before become "new". Resolves to the number of new jobs. */
  function check(site) {
    var now = Date.now();
    return fetchJobs(site).then(function (res) {
      var first = !site.lastOk, seen = site.seen = site.seen || {}, newly = [];
      res.jobs.forEach(function (j) { if (!seen[j.i]) { seen[j.i] = now; if (!first) newly.push(j.i); } });
      var ids = {}; res.jobs.forEach(function (j) { ids[j.i] = 1; });
      site.newIds = U.uniq((site.newIds || []).concat(newly)).filter(function (id) { return ids[id]; });
      Object.keys(seen).forEach(function (k) { if (!ids[k] && now - seen[k] > FORGET_AFTER) delete seen[k]; });
      // newest first (by posting date, else by when we first saw it)
      site.jobs = res.jobs.sort(function (a, b) { return (b.p || seen[b.i] || 0) - (a.p || seen[a.i] || 0); }).slice(0, MAX_JOBS);
      // a board that reports its company name replaces the name guessed from the link (unless you renamed it);
      // otherwise a careers page's own name is used when it is more than the link's slug
      if (site.kind === 'ats' && !site.customName && site.name === pretty(site.slug)) {
        if (res.name) site.name = res.name;
        else if (site.pageName && site.pageName.length > 2 && U.norm(site.pageName) !== U.norm(site.slug)) site.name = site.pageName;
      }
      site.lastCheck = site.lastOk = now; site.lastError = '';
      site._fresh = newly; // not stored: read by checkAll for alerts
      return newly.length;
    }, function (e) {
      site.lastCheck = now; site.lastError = String(e && e.message || e).slice(0, 160);
      return 0;
    });
  }

  /** Add a site and read it once (its current jobs are the starting point; later ones show as new). */
  function add(url) {
    return resolve(url).then(function (r) {
      var l = list();
      var dup = l.filter(function (s) { return (r.kind === 'ats' && s.kind === 'ats' && s.ats === r.ats && String(s.slug).toLowerCase() === String(r.slug).toLowerCase()) || (r.kind === 'page' && s.url === r.url); })[0];
      if (dup) { var e = new Error('You already follow this site (' + dup.name + ')'); e.dup = dup.id; throw e; }
      delete r.n;
      var site = Object.assign({ id: 's' + Date.now().toString(36), addedAt: Date.now(), remoteOnly: r.kind === 'ats', newIds: [], seen: {}, jobs: [] }, r);
      return check(site).then(function () {
        if (!site.lastOk) throw new Error(site.lastError || 'Could not read this site');
        l = list(); l.push(site); save(l);
        if (site.kind === 'ats') reportBoard(site);
        return site;
      });
    });
  }

  // also let the server's crawler watch the board, so its remote jobs show up in normal searches
  function reportBoard(site) {
    try {
      if (!RH.ai.relayReady()) return;
      RH.http({ method: 'POST', url: RH.ai.relayUrl() + '/discover', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RH.ai.builtinToken() },
        body: { items: [{ ats: site.ats, slug: String(site.slug).toLowerCase(), name: site.name }] }, timeout: 20000 });
    } catch (e) { }
  }

  function remove(id) { save(list().filter(function (s) { return s.id !== id; })); }
  function setRemoteOnly(id, on) { var s = byId(id); if (s) { s.remoteOnly = !!on; update(s); } }
  function rename(id, name) { var s = byId(id); name = String(name || '').trim().slice(0, 60); if (s && name) { s.name = name; s.customName = true; update(s); } }
  function markSeen(id) { var s = byId(id); if (s && s.newIds && s.newIds.length) { s.newIds = []; update(s); } }
  function shown(s) { return (s.jobs || []).filter(function (j) { return !(s.remoteOnly && j.r === false); }); }
  /** Jobs listed for a site (after its "remote only" setting); cheap, used for counts and badges. */
  function count(s) { return shown(s).length; }
  function total(s) { return (s.jobs || []).length; }
  function newCount(s) {
    if (!s) return list().reduce(function (n, x) { return n + newCount(x); }, 0);
    var ids = {}; (s.newIds || []).forEach(function (id) { ids[id] = 1; });
    return shown(s).filter(function (j) { return ids[j.i]; }).length;
  }

  /**
   * Check every site that is due (or all, when forced). Resolves to {checked, fresh, items}: `items` are the jobs
   * that are new in this run and shown under the site's "remote only" setting (what alerts tell you about).
   * maxAgeMs: how old a check may be before the site is due again (default 30 minutes).
   */
  var running = null;
  function checkAll(force, maxAgeMs) {
    if (running) return running;
    var age = maxAgeMs || CHECK_EVERY;
    var now = Date.now(), l = list(), due = l.filter(function (s) { return force || !s.lastCheck || now - s.lastCheck > age; });
    if (!due.length) return Promise.resolve({ checked: 0, fresh: 0, items: [] });
    running = U.pool(due, 3, check).then(function (counts) {
      var items = [];
      due.forEach(function (s) {
        var fresh = {}; (s._fresh || []).forEach(function (id) { fresh[id] = 1; });
        shown(s).forEach(function (j) { if (fresh[j.i]) items.push({ siteId: s.id, site: s.name, title: j.t, location: j.l || '', url: j.u || j.a, applyUrl: j.a || j.u }); });
        delete s._fresh;
      });
      var cur = list(); // keep edits made meanwhile (e.g. a site removed); store the checked copies
      due.forEach(function (s) { for (var i = 0; i < cur.length; i++) if (cur[i].id === s.id) cur[i] = s; });
      save(cur);
      return { checked: due.length, fresh: counts.reduce(function (n, c) { return n + (typeof c === 'number' ? c : 0); }, 0), items: items };
    }).then(function (r) { running = null; return r; }, function (e) { running = null; throw e; });
    return running;
  }

  /** The site's jobs as app job objects (job cards, details, apply, tracker), filtered by its "remote only" setting. */
  function visible(site) {
    var newSet = {}; (site.newIds || []).forEach(function (id) { newSet[id] = 1; });
    var jobs = shown(site);
    var out = site.kind === 'ats'
      ? RH.jobs.normalize.employers({ companies: [{ a: site.ats, s: site.slug, n: site.name, j: jobs.map(function (j) { var c = Object.assign({}, j); if (!c.l) delete c.l; return c; }) }] })
      : RH.jobs.normalize.site(site, jobs);
    out.forEach(function (j, i) {
      var raw = jobs[i];
      j.siteId = site.id; j.isNew = !!newSet[raw.i];
      if (site.kind === 'ats' && raw.r === false && (!raw.l || !raw.l.length)) j.locations = [];
      if (site.kind === 'ats' && raw.r === false) j.notRemote = true;
      if (!j.postedAt && site.seen && site.seen[raw.i]) j.postedAt = site.seen[raw.i];
      RH.jobs.trust(j);
    });
    return out;
  }

  RH.sites = {
    list: list, byId: byId, add: add, remove: remove, check: check, checkAll: checkAll, visible: visible, markSeen: markSeen,
    setRemoteOnly: setRemoteOnly, rename: rename, newCount: newCount, count: count, total: total, CHECK_EVERY: CHECK_EVERY,
    _atsFrom: atsFrom, _parseBoard: parseBoard, _pageJobs: pageJobs, _resolve: resolve, _cleanName: cleanName, _listLinks: listLinks
  };
})(typeof window !== 'undefined' ? window : globalThis);
