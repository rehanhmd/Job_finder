/* Jobs: fetch from free remote-job boards, normalize, de-duplicate, filter, score and AI-rank. */
(function (g) {
  var RH = g.RH, U = RH.util;
  var DAY = 86400000;

  function toMs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    var n = Number(v);
    if (!isNaN(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    var s = String(v);
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(s)) s += 'Z'; // Remotive dates are UTC without zone
    var t = Date.parse(s);
    return isNaN(t) ? 0 : t;
  }
  function arr(x) { return Array.isArray(x) ? x : (x == null || x === '' ? [] : String(x).split(/\s*[,;|\/]\s*/)); }
  function money(min, max, cur, per) {
    min = Number(min) || 0; max = Number(max) || 0;
    if (!min && !max) return '';
    var f = function (n) { return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); };
    var c = cur ? (cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur + ' ') : '$';
    return c + (min && max && min !== max ? f(min) + '–' + f(max) : f(max || min)) + (per && !/year|annual/i.test(per) ? '/' + per.replace(/ly$/, '') : '');
  }
  function mk(o) {
    o.title = U.stripHtml(o.title || '').trim();
    o.company = U.stripHtml(o.company || '').trim();
    o.tags = U.uniq(arr(o.tags)).slice(0, 15);
    o.locations = U.uniq(arr(o.locations).map(function (l) { return String(l).trim(); }));
    o.id = o.source + ':' + (o.sid || U.hash(o.url || o.title + o.company));
    o.key = U.norm(o.title).replace(/\b(sr|senior|jr|junior|remote|m w d|f m d)\b/g, '').replace(/\s+/g, ' ').trim() + '|' + U.norm(o.company);
    delete o.sid;
    return o;
  }

  // ---------------------------------------------------------------- normalizers (exported for tests)
  var N = {
    remotive: function (j) {
      return (j.jobs || []).map(function (x) {
        return mk({ source: 'Remotive', sid: x.id, title: x.title, company: x.company_name, logo: x.company_logo || x.company_logo_url || '',
          url: x.url, applyUrl: x.url, description: x.description || '', tags: x.tags, locations: x.candidate_required_location,
          salary: x.salary || '', type: x.job_type || '', category: x.category || '', postedAt: toMs(x.publication_date) });
      });
    },
    remoteok: function (j) {
      return (Array.isArray(j) ? j : []).filter(function (x) { return x && x.position; }).map(function (x) {
        return mk({ source: 'RemoteOK', sid: x.id, title: x.position, company: x.company, logo: x.company_logo || x.logo || '',
          url: x.url, applyUrl: x.apply_url || x.url, description: x.description || '', tags: x.tags, locations: x.location || '',
          salary: money(x.salary_min, x.salary_max, 'USD'), type: '', category: '', postedAt: toMs(x.epoch || x.date) });
      });
    },
    jobicy: function (j) {
      return (j.jobs || []).map(function (x) {
        return mk({ source: 'Jobicy', sid: x.id, title: x.jobTitle, company: x.companyName, logo: x.companyLogo || '',
          url: x.url, applyUrl: x.url, description: x.jobDescription || x.jobExcerpt || '', tags: arr(x.jobIndustry).concat(arr(x.jobLevel)),
          locations: x.jobGeo || '', salary: money(x.salaryMin || x.annualSalaryMin, x.salaryMax || x.annualSalaryMax, x.salaryCurrency, x.salaryPeriod),
          type: arr(x.jobType).join(', '), category: arr(x.jobIndustry).join(', '), postedAt: toMs(x.pubDate) });
      });
    },
    himalayas: function (j) {
      return (j.jobs || []).map(function (x) {
        return mk({ source: 'Himalayas', sid: x.guid || x.applicationLink, title: x.title, company: x.companyName, logo: x.companyLogo || '',
          url: x.applicationLink || x.guid, applyUrl: x.applicationLink || x.guid, description: x.description || x.excerpt || '',
          tags: arr(x.categories).map(function (c) { return String(c).replace(/-/g, ' '); }).concat(arr(x.seniority)),
          locations: arr(x.locationRestrictions), salary: money(x.minSalary, x.maxSalary, x.currency, x.salaryPeriod),
          type: x.employmentType || '', category: arr(x.parentCategories).join(', '), postedAt: toMs(x.pubDate) });
      });
    },
    arbeitnow: function (j) {
      return (j.data || []).filter(function (x) { return x.remote === true; }).map(function (x) {
        return mk({ source: 'Arbeitnow', sid: x.slug, title: x.title, company: x.company_name, logo: '', url: x.url, applyUrl: x.url,
          description: x.description || '', tags: x.tags, locations: x.location ? [x.location] : [], salary: '',
          type: arr(x.job_types).join(', '), category: '', postedAt: toMs(x.created_at), remoteNote: 'Remote (may require residence near ' + (x.location || 'the company') + ')' });
      });
    },
    wwr: function (xml) {
      var doc = new DOMParser().parseFromString(xml, 'text/xml');
      var items = doc.getElementsByTagName('item'), out = [];
      function t(it, tag) { var n = it.getElementsByTagName(tag)[0]; return n ? n.textContent : ''; }
      for (var i = 0; i < items.length; i++) {
        var it = items[i], raw = t(it, 'title'), idx = raw.indexOf(':');
        var company = idx > 0 ? raw.slice(0, idx) : '', title = idx > 0 ? raw.slice(idx + 1) : raw;
        var link = t(it, 'link') || t(it, 'guid');
        out.push(mk({ source: 'WeWorkRemotely', sid: link, title: title, company: company, logo: '', url: link, applyUrl: link,
          description: t(it, 'description'), tags: [t(it, 'category')].concat(t(it, 'skills') ? arr(t(it, 'skills')) : []),
          locations: t(it, 'region') ? arr(t(it, 'region')) : [], salary: '', type: t(it, 'type') || '', category: t(it, 'category'),
          postedAt: toMs(t(it, 'pubDate')) }));
      }
      return out;
    }
  };

  var ATS_NAME = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters', workable: 'Workable', recruitee: 'Recruitee' };
  function pretty(slug) { return String(slug || '').replace(/[-_.]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  /** Employer feed from the RemoteHunt relay: jobs read from companies' own hiring systems. */
  N.employers = function (feed) {
    var out = [];
    (feed.companies || []).forEach(function (c) {
      (c.j || []).forEach(function (x) {
        var j = mk({ source: 'Employer', ats: c.a, slug: c.s, sid: c.a + ':' + c.s + ':' + x.i, jid: x.i, title: x.t, company: c.n || pretty(c.s), logo: '',
          url: x.u || x.a, applyUrl: x.a || x.u, description: x.x || '', tags: [x.d, x.e].filter(Boolean), locations: String(x.l || 'Remote').split(/\s+\/\s+/),
          salary: x.s || '', type: x.e || '', category: x.d || '', postedAt: x.p || 0 });
        j.descLazy = true; j.direct = true;
        out.push(j);
      });
    });
    return out;
  };

  /** Job links collected from a page you follow (My sites); same order as `list`. */
  N.site = function (site, list) {
    return (list || []).map(function (x) {
      return mk({ source: 'My sites', sid: U.hash(x.i), title: x.t, company: site.name || hostOf(site.url), logo: '',
        url: x.u, applyUrl: x.a || x.u, description: x.x || '', tags: [], locations: x.l ? [x.l] : [], postedAt: x.p || 0 });
    });
  };

  /** Hacker News "Ask HN: Who is hiring?" — remote posts from the latest monthly thread. */
  function decodeEntities(s) {
    return String(s || '').replace(/&#x2F;/g, '/').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  }
  var ROLE = /(engineer|developer|designer|manager|scientist|analyst|architect|lead|director|marketer|writer|recruiter|specialist|devops|sre|consultant|head of|product|support|sales|qa|tester|intern)/i;
  N.hn = function (item) {
    var out = [];
    (item.children || []).forEach(function (c) {
      if (!c || !c.text) return;
      var html = c.text, first = decodeEntities(html.split(/<p>/i)[0].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (!/\bremote\b/i.test(first) || /\b(no remote|not remote|onsite only|on-site only|remote not)\b/i.test(first)) return;
      var parts = first.split(/\s+\|\s+/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (parts.length < 2) return;
      var company = parts[0].replace(/\(.*?\)/g, '').trim().slice(0, 60);
      var title = parts.slice(1).filter(function (x) { return ROLE.test(x) && x.length < 120; })[0] || parts[1];
      var locs = parts.filter(function (x) { return /remote|us|usa|eu|europe|uk|global|worldwide|anywhere|timezone|tz|est|pst|cet/i.test(x) && x !== title && x.length < 80; });
      var hrefs = [], hm, hre = /href="([^"]+)"/ig;
      while ((hm = hre.exec(html))) hrefs.push(decodeEntities(hm[1]));
      var link = hrefs.filter(function (u) { return atsOf(u) || /\/(careers?|jobs?|apply|join|hiring|positions|openings|work-with-us)\b/i.test(u); })[0] || 'https://news.ycombinator.com/item?id=' + c.id;
      out.push(mk({ source: 'HN Hiring', sid: c.id, title: title, company: company, logo: '', url: 'https://news.ycombinator.com/item?id=' + c.id, applyUrl: link,
        description: html, tags: [], locations: locs.length ? locs : ['Remote'], salary: (first.match(/\$\s?\d[\d,.]*k?(\s?[-–]\s?\$?\d[\d,.]*k?)?/i) || [''])[0],
        type: '', category: '', postedAt: (c.created_at_i || 0) * 1000 }));
    });
    return out;
  };

  // ---------------------------------------------------------------- trust & scam signals
  var SCAM_STRONG = [
    /\b(registration|training|processing|onboarding|application|security|starter[- ]kit|equipment)\s+(fee|deposit|charge|cost)s?\b/i,
    /\b(pay|send|transfer)\s+(us|a|the|an)?\s*(fee|deposit|money|payment|bitcoin|btc|usdt|gift ?cards?)\b/i,
    /\b(western union|moneygram|check cashing|cash a check|deposit (a|the) check|reshipping|package forwarding)\b/i,
    /\b(t\.me|wa\.me)\//i,
    /\b(contact|message|text|reach|dm|chat with|apply)\s+(us|me|hr|the recruiter|our recruiter)?\s*(on|via|through|at)\s+(telegram|whatsapp|signal|wechat)\b/i
  ];
  var SCAM_SOFT = [
    /\b[a-z0-9._%+-]+@(gmail|yahoo|outlook|hotmail|aol|proton|icloud)\.com\b/i,
    /\bearn\s+(up to\s+)?\$?\d{3,}[\d,]*\s*(\+\s*)?(per|a|\/)\s*(day|week)\b/i,
    /\b(no (experience|interview|skills?) (required|needed)|guaranteed (income|salary|pay)|get paid to (type|chat|like))\b/i,
    /\b(data entry clerk|copy[- ]paste job|typing job|mystery shopper|envelope stuffing)\b/i,
    /\b(crypto|bitcoin|usdt)\s+(wallet|payment)s?\s+(required|needed)\b/i
  ];
  var BAD_HOSTS = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|forms\.gle|t\.me|wa\.me|linktr\.ee|rb\.gy|cutt\.ly)$/i;
  // Sites that sit between the candidate and the employer (job boards, aggregators, talent marketplaces).
  // Their links mean an extra sign-up and an extra hop, so by default only the employer's own page is shown.
  var MIDDLEMEN = ('remotive.com jobicy.com himalayas.app remoteok.com remoteok.io weworkremotely.com arbeitnow.com linkedin.com indeed.com ' +
    'glassdoor.com ziprecruiter.com wellfound.com angel.co angellist.com dice.com monster.com simplyhired.com flexjobs.com workingnomads.com remote.co ' +
    'jobgether.com jooble.org adzuna.com talent.com builtin.com welcometothejungle.com otta.com naukri.com foundit.in shine.com instahyre.com cutshort.io ' +
    'hirist.com hirist.tech internshala.com upwork.com fiverr.com freelancer.com toptal.com turing.com crossover.com braintrust.com remotehub.com nodesk.co ' +
    'dynamitejobs.com justremote.co jobspresso.co remoterocketship.com lensa.com careerbuilder.com snagajob.com joinrise.co jobright.ai remotely.jobs ' +
    'echojobs.io startup.jobs workatastartup.com ycombinator.com news.ycombinator.com wellfound.co jobs.lever.careers jobboard.io getonbrd.com ' +
    'remotewx.com 4dayweek.io nofluffjobs.com justjoin.it stepstone.de xing.com reed.co.uk totaljobs.com cv-library.co.uk seek.com.au jobstreet.com ' +
    'bayt.com naukrigulf.com gulftalent.com wuzzuf.net jobberman.com hired.com vettery.com arc.dev andela.com x-team.com gun.io lemon.io index.dev ' +
    'mercor.com micro1.ai outlier.ai remotasks.com jobsora.com whatjobs.com jora.com careerjet.com neuvoo.com recruit.net jobrapido.com trabajo.org ' +
    'remotive.io remote.io remotepeople.com workew.com remoteleaf.com pangian.com virtualvocations.com skipthedrive.com powertofly.com diversifytech.co').split(' ');
  var MID = {}; MIDDLEMEN.forEach(function (d) { MID[d] = 1; });
  function isMiddleman(host) {
    host = String(host || '').toLowerCase().replace(/^www\./, '');
    if (!host) return true;
    var parts = host.split('.');
    for (var i = 0; i < parts.length - 1; i++) if (MID[parts.slice(i).join('.')]) return true;
    return /(^|\.)(indeed|glassdoor|linkedin|monster|jooble|adzuna|careerjet)\.[a-z.]+$/.test(host);
  }
  // employers' own hiring systems (the page where the application form is)
  var ATS_HOSTS = [
    [/(^|\.)greenhouse\.io$/, 'Greenhouse'], [/(^|\.)lever\.co$/, 'Lever'], [/(^|\.)ashbyhq\.com$/, 'Ashby'], [/(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$|(^|\.)workday\.com$/, 'Workday'],
    [/(^|\.)smartrecruiters\.com$/, 'SmartRecruiters'], [/(^|\.)workable\.com$/, 'Workable'], [/(^|\.)recruitee\.com$/, 'Recruitee'], [/(^|\.)icims\.com$/, 'iCIMS'],
    [/(^|\.)bamboohr\.com$/, 'BambooHR'], [/(^|\.)jobvite\.com$/, 'Jobvite'], [/(^|\.)teamtailor\.com$/, 'Teamtailor'], [/(^|\.)personio\.(de|com)$/, 'Personio'],
    [/(^|\.)breezy\.hr$/, 'Breezy'], [/(^|\.)applytojob\.com$/, 'JazzHR'], [/(^|\.)rippling(-ats)?\.com$/, 'Rippling'], [/(^|\.)pinpointhq\.com$/, 'Pinpoint'],
    [/(^|\.)comeet\.(co|com)$/, 'Comeet'], [/(^|\.)freshteam\.com$/, 'Freshteam'], [/(^|\.)zohorecruit\.(com|in|eu)$/, 'Zoho Recruit'], [/(^|\.)oraclecloud\.com$/, 'Oracle'],
    [/(^|\.)successfactors\.(com|eu)$/, 'SuccessFactors'], [/(^|\.)taleo\.net$/, 'Taleo'], [/(^|\.)dover\.com$/, 'Dover'], [/(^|\.)gem\.com$/, 'Gem'],
    [/(^|\.)homerun\.co$/, 'Homerun'], [/(^|\.)join\.com$/, 'JOIN'], [/(^|\.)hire\.trakstar\.com$/, 'Trakstar'], [/(^|\.)paylocity\.com$/, 'Paylocity'],
    [/(^|\.)ultipro\.com$|(^|\.)ukg\.net$/, 'UKG'], [/(^|\.)adp\.com$/, 'ADP'], [/(^|\.)avature\.net$/, 'Avature'], [/(^|\.)eightfold\.ai$/, 'Eightfold'],
    [/(^|\.)keka\.com$/, 'Keka'], [/(^|\.)darwinbox\.in$/, 'Darwinbox'], [/(^|\.)hrmos\.co$/, 'HRMOS'], [/(^|\.)polymer\.co$/, 'Polymer'], [/(^|\.)notion\.site$/, 'Company page']
  ];
  function atsOf(u) {
    var h = hostOf(u);
    if (!h) return '';
    for (var i = 0; i < ATS_HOSTS.length; i++) if (ATS_HOSTS[i][0].test(h)) return ATS_HOSTS[i][1];
    return '';
  }
  /** 'direct' = the employer's own application page, 'middleman' = a job board / marketplace, 'bad' = shortener or no link */
  function linkKind(u) {
    if (!/^https?:\/\//i.test(String(u || ''))) return 'bad';
    var h = hostOf(u);
    if (!h || BAD_HOSTS.test(h)) return 'bad';
    if (atsOf(u)) return 'direct';
    return isMiddleman(h) ? 'middleman' : 'direct';
  }
  /** pick the employer's own link for a job, or '' if it only exists on a middleman site */
  function directLink(j) {
    var c = [j.applyUrl, j.url].filter(Boolean);
    for (var i = 0; i < c.length; i++) if (linkKind(c[i]) === 'direct') return c[i];
    return '';
  }
  /** guess the company's own hiring-system address from its name, so the crawler can check it */
  function guessBoards(company) {
    var base = U.norm(company).replace(/\b(inc|llc|ltd|gmbh|corp|corporation|co|limited|plc|bv|ag|sa|srl|pvt)\b/g, '').trim();
    var a = base.replace(/[^a-z0-9]/g, ''), b = base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (a.length < 3 || a.length > 40) return [];
    var out = [{ ats: 'greenhouse', slug: a }, { ats: 'lever', slug: b || a }, { ats: 'ashby', slug: a }];
    return out;
  }

  var TRUSTED_SOURCES = { Remotive: 1, Jobicy: 1, Himalayas: 1, RemoteOK: 1, WeWorkRemotely: 1, Arbeitnow: 1, 'My sites': 1 };

  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  // reassurances like "we never charge an application fee" or "we cover equipment costs" are not scam signals
  var FEE_OK = new RegExp([
    "\\b(never|not|no|don'?t|do not|won'?t|will not)\\s+(ask|asks|require|requires|request|requests|charge|charges|take|collect)\\b[^.!?\\n]{0,40}?\\b(fees?|deposits?|charges?|costs?|payments?|money)\\b",
    "\\bno\\s+(application|registration|hiring|processing|training|placement|recruitment|joining)?\\s*(fees?|charges?|costs?|deposits?)\\b",
    "\\bfree of (charge|cost)\\b",
    "\\b(we|company|employer)\\s+(will\\s+)?(cover|covers|provide|provides|pay for|pays for)\\b[^.!?\\n]{0,40}?\\b(fees?|costs?|charges?)\\b" // not "reimburse": "buy it and we reimburse you" is a classic scam
  ].join('|'), 'gi');
  function trust(job) {
    var text = (job.title + ' ' + U.stripHtml(job.description || '').slice(0, 8000)).replace(FEE_OK, ' ');
    var reasons = [];
    SCAM_STRONG.forEach(function (re) { var m = text.match(re); if (m) reasons.push({ s: 2, why: m[0] }); });
    SCAM_SOFT.forEach(function (re) { var m = text.match(re); if (m) reasons.push({ s: 1, why: m[0] }); });
    var h = hostOf(job.applyUrl || job.url);
    if (h && BAD_HOSTS.test(h)) reasons.push({ s: 1, why: 'link via ' + h });
    var score = reasons.reduce(function (n, r) { return n + r.s; }, 0);
    var base = job.source === 'Employer' || atsOf(job.applyUrl) ? 'verified' : TRUSTED_SOURCES[job.source] ? 'trusted' : 'community';
    job.trust = score >= 2 ? 'flagged' : score === 1 ? 'caution' : base;
    job.trustBase = base;
    job.trustWhy = reasons.map(function (r) { return r.why; }).slice(0, 3);
    return job.trust;
  }

  // ---------------------------------------------------------------- discovery of new employer boards
  var ATS_LINKS = [
    [/(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]{2,60})/ig, 'greenhouse'],
    [/boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]{2,60})/ig, 'greenhouse'],
    [/greenhouse\.io\/embed\/job_app\?for=([a-z0-9_-]{2,60})/ig, 'greenhouse'],
    [/jobs\.(?:eu\.)?lever\.co\/([a-z0-9_.-]{2,60})/ig, 'lever'],
    [/jobs\.ashbyhq\.com\/([a-z0-9_.%-]{2,60})/ig, 'ashby'],
    [/apply\.workable\.com\/([a-z0-9_-]{2,60})/ig, 'workable'],
    [/([a-z0-9-]{2,60})\.recruitee\.com/ig, 'recruitee'],
    [/(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]{2,60})/ig, 'smartrecruiters']
  ];
  var NOT_SLUG = /^(j|api|embed|jobs|job|www|careers|oneclick-ui|v1|static|assets|o|c)$/i;
  function findBoards(text) {
    var found = {};
    ATS_LINKS.forEach(function (pair) {
      var re = new RegExp(pair[0].source, 'ig'), m;
      while ((m = re.exec(text))) {
        var slug = decodeURIComponent(m[1]).toLowerCase().replace(/[.]+$/, '');
        if (NOT_SLUG.test(slug)) continue;
        found[pair[1] + ':' + slug] = { ats: pair[1], slug: slug };
      }
    });
    return Object.keys(found).map(function (k) { return found[k]; });
  }
  function reportBoards(jobs) {
    if (!RH.ai.relayReady()) return;
    var sent = RH.store.get('discover.sent', {}), fresh = [];
    jobs.forEach(function (j) {
      if (j.source === 'Employer') return;
      findBoards([j.url, j.applyUrl, j.description].join(' ')).forEach(function (b) {
        var k = b.ats + ':' + b.slug;
        if (!sent[k]) { sent[k] = Date.now(); b.name = j.company; fresh.push(b); }
      });
    });
    if (!fresh.length) return;
    var keys = Object.keys(sent); if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach(function (k) { delete sent[k]; });
    RH.store.set('discover.sent', sent);
    for (var i = 0; i < fresh.length; i += 40) {
      RH.http({ method: 'POST', url: RH.ai.builtinUrl() + '/discover', headers: { Authorization: 'Bearer ' + RH.ai.builtinToken(), 'Content-Type': 'application/json' }, body: { items: fresh.slice(i, i + 40) } });
    }
  }

  // ---------------------------------------------------------------- full descriptions on demand (employer jobs)
  function loadDescription(job) {
    if (!job || !job.descLazy || job.descLoaded) return Promise.resolve(job);
    var a = job.ats, s = encodeURIComponent(job.slug), id = encodeURIComponent(job.jid), url = null, pick = null;
    if (a === 'greenhouse') { url = 'https://boards-api.greenhouse.io/v1/boards/' + s + '/jobs/' + id; pick = function (d) { return decodeEntities(d.content || ''); }; }
    else if (a === 'lever') { url = 'https://api.lever.co/v0/postings/' + s + '/' + id; pick = function (d) { return (d.description || '') + (d.lists || []).map(function (l) { return '<h3>' + U.esc(l.text) + '</h3><ul>' + l.content + '</ul>'; }).join('') + (d.additional || ''); }; }
    else if (a === 'smartrecruiters') { url = 'https://api.smartrecruiters.com/v1/companies/' + s + '/postings/' + id; pick = function (d) { var se = (d.jobAd && d.jobAd.sections) || {}; return ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'].map(function (k) { return se[k] ? '<h3>' + U.esc(se[k].title || '') + '</h3>' + (se[k].text || '') : ''; }).join(''); }; }
    else if (a === 'workable') { url = 'https://apply.workable.com/api/v2/accounts/' + s + '/jobs/' + id; pick = function (d) { return (d.description || '') + (d.requirements ? '<h3>Requirements</h3>' + d.requirements : '') + (d.benefits ? '<h3>Benefits</h3>' + d.benefits : ''); }; }
    if (!url) { job.descLoaded = true; return Promise.resolve(job); }
    return RH.httpJson({ url: url, timeout: 20000 }).then(function (d) {
      var html = pick(d);
      if (html && html.length > (job.description || '').length) job.description = html;
      job.descLoaded = true; trust(job);
      return job;
    }, function () { job.descLoaded = true; return job; });
  }

  // ---------------------------------------------------------------- sources
  function enc(q) { return encodeURIComponent(q); }
  var SOURCES = {
    remotive: { name: 'Remotive', searchable: true, fetch: function (q) { return RH.httpJson({ url: 'https://remotive.com/api/remote-jobs?limit=150&search=' + enc(q) }).then(N.remotive); } },
    // Jobicy allows 1 request per second: space the keyword searches out and retry once if it still says "too many"
    jobicy: { name: 'Jobicy', searchable: true, fetch: function (q) {
      var get = function () { return spaced('jobicy', 1200, function () { return RH.httpJson({ url: 'https://jobicy.com/api/v2/remote-jobs?count=100&tag=' + enc(q) }); }); };
      return get().catch(function (e) { if (e.status === 429) return U.sleep(2000).then(get); throw e; }).then(N.jobicy);
    } },
    himalayas: { name: 'Himalayas', searchable: true, fetch: function (q) { return RH.httpJson({ url: 'https://himalayas.app/jobs/api/search?q=' + enc(q) + '&limit=50' }).then(N.himalayas); } },
    remoteok: { name: 'RemoteOK', searchable: false, fetch: function () { return RH.httpJson({ url: 'https://remoteok.com/api' }).then(N.remoteok); } },
    wwr: { name: 'WeWorkRemotely', searchable: false, fetch: function () { return RH.http({ url: 'https://weworkremotely.com/remote-jobs.rss' }).then(function (r) { if (r.status !== 200) throw new Error('HTTP ' + r.status); return N.wwr(r.body); }); } },
    arbeitnow: { name: 'Arbeitnow', searchable: false, fetch: function () { return RH.httpJson({ url: 'https://www.arbeitnow.com/api/job-board-api' }).then(N.arbeitnow); } },
    employers: { name: 'Verified employers', searchable: false, ttl: 10 * 60000, fetch: function () {
      if (!RH.ai.relayReady()) return Promise.resolve([]);
      return RH.httpJson({ url: RH.ai.builtinUrl() + '/jobs', headers: { Authorization: 'Bearer ' + RH.ai.builtinToken() }, timeout: 90000 }).then(N.employers, function (e) {
        if (e.status === 401 && RH.onAuthLost) RH.onAuthLost(e.message);
        throw e;
      });
    } },
    hn: { name: 'HN Who is hiring', searchable: false, ttl: 6 * 3600000, fetch: function () {
      return RH.httpJson({ url: 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=6' }).then(function (r) {
        var st = (r.hits || []).filter(function (h) { return /who is hiring/i.test(h.title || ''); })[0];
        if (!st) return [];
        return RH.httpJson({ url: 'https://hn.algolia.com/api/v1/items/' + st.objectID, timeout: 90000 }).then(N.hn);
      });
    } }
  };

  // feeds (non-search sources) are cached for 30 min; search results per query for 3 hours
  var memCache = {};
  // companies seen only on job boards: ask the crawler to look for their own hiring page next time
  function reportGuesses(jobs, have) {
    if (!RH.ai.relayReady() || !jobs.length) return;
    var known = {};
    Object.keys(have || {}).forEach(function (k) { var j = have[k]; if (j.source === 'Employer') known[U.norm(j.company)] = 1; });
    var sent = RH.store.get('discover.guess', {}), items = [], cos = 0;
    for (var i = 0; i < jobs.length && cos < 12; i++) {
      var co = U.norm(jobs[i].company);
      if (!co || known[co] || sent[co]) continue;
      var g = guessBoards(jobs[i].company);
      if (!g.length) continue;
      sent[co] = Date.now(); cos++;
      g.forEach(function (b) { b.name = jobs[i].company; items.push(b); });
    }
    var keys = Object.keys(sent); if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach(function (k) { delete sent[k]; });
    RH.store.set('discover.guess', sent);
    if (items.length) RH.http({ method: 'POST', url: RH.ai.builtinUrl() + '/discover', headers: { Authorization: 'Bearer ' + RH.ai.builtinToken(), 'Content-Type': 'application/json' }, body: { items: items.slice(0, 40) } });
  }

  function cached(key, ttl, fn) {
    var c = memCache[key] || RH.store.get('cache.' + key, null);
    if (c && Date.now() - c.at < ttl) { memCache[key] = c; return Promise.resolve(c.data); }
    return fn().then(function (data) {
      var entry = { at: Date.now(), data: data };
      memCache[key] = entry;
      try {
        RH.store.set('cache.' + key, entry);
        var idx = RH.store.get('cache.index', []);
        if (idx.indexOf(key) < 0) { idx.push(key); RH.store.set('cache.index', idx.slice(-200)); }
      } catch (e) { }
      return data;
    });
  }

  // ---------------------------------------------------------------- filtering
  var GENERIC = { developer: 1, engineer: 1, engineering: 1, manager: 1, senior: 1, junior: 1, lead: 1, remote: 1, specialist: 1, sr: 1, jr: 1, the: 1, and: 1, of: 1, for: 1, 'full': 1, stack: 0 };
  /** Rough word stem so "trainer" matches "training" and "evaluation" matches "evaluators". */
  function stem(t) { return t.length > 4 ? t.replace(/(ations?|ators?|ings?|ers?|ors?|ions?|ies|es|s|ed)$/, '') : t; }
  function stems(s) { return ' ' + U.norm(s).split(' ').map(stem).join(' ') + ' '; }
  function queryMatch(job, q) {
    var qt = U.tokens(q);
    if (!qt.length) return true;
    var title = stems(job.title), tags = stems((job.tags || []).join(' '));
    var core = qt.filter(function (t) { return !GENERIC[t]; });
    if (!core.length) core = qt;
    core = core.map(stem);
    var hit = core.filter(function (t) { return title.indexOf(' ' + t + ' ') >= 0 || tags.indexOf(' ' + t + ' ') >= 0; });
    return hit.length >= Math.min(core.length, 2) || (core.length === 1 && hit.length === 1);
  }

  var NOT_REMOTE = /\b(hybrid|on[- ]?site|in[- ]office|office[- ]based)\b/i;
  function isRemote(job) {
    if (NOT_REMOTE.test(job.title)) return false;
    if (job.locations.some(function (l) { return NOT_REMOTE.test(l); })) return false;
    return true;
  }

  var REGIONS = {
    india: ['asia', 'apac', 'asia pacific', 'south asia', 'india'], pakistan: ['asia', 'apac', 'south asia', 'emea'], bangladesh: ['asia', 'apac', 'south asia'],
    philippines: ['asia', 'apac', 'southeast asia', 'sea'], indonesia: ['asia', 'apac', 'southeast asia'], vietnam: ['asia', 'apac', 'southeast asia'],
    singapore: ['asia', 'apac', 'southeast asia'], malaysia: ['asia', 'apac', 'southeast asia'], 'sri lanka': ['asia', 'apac', 'south asia'],
    nepal: ['asia', 'apac', 'south asia'], japan: ['asia', 'apac'], china: ['asia', 'apac'], australia: ['apac', 'oceania', 'anz'], 'new zealand': ['apac', 'oceania', 'anz'],
    'united states': ['usa', 'us', 'u s', 'america', 'north america', 'americas', 'united states'], usa: ['usa', 'us', 'america', 'north america', 'americas', 'united states'],
    canada: ['canada', 'north america', 'americas'], mexico: ['latam', 'latin america', 'americas', 'north america'], brazil: ['latam', 'latin america', 'americas', 'south america'],
    argentina: ['latam', 'latin america', 'americas', 'south america'], colombia: ['latam', 'latin america', 'americas', 'south america'],
    'united kingdom': ['uk', 'u k', 'united kingdom', 'europe', 'emea', 'great britain', 'england'], uk: ['uk', 'united kingdom', 'europe', 'emea', 'england'],
    germany: ['europe', 'eu', 'emea', 'dach', 'germany'], france: ['europe', 'eu', 'emea'], spain: ['europe', 'eu', 'emea'], italy: ['europe', 'eu', 'emea'],
    netherlands: ['europe', 'eu', 'emea'], poland: ['europe', 'eu', 'emea', 'cee', 'eastern europe'], portugal: ['europe', 'eu', 'emea'], ireland: ['europe', 'eu', 'emea'],
    romania: ['europe', 'eu', 'emea', 'cee', 'eastern europe'], ukraine: ['europe', 'emea', 'eastern europe', 'cee'], turkey: ['europe', 'emea'],
    egypt: ['africa', 'emea', 'mena', 'middle east'], nigeria: ['africa', 'emea'], kenya: ['africa', 'emea'], 'south africa': ['africa', 'emea'],
    'united arab emirates': ['uae', 'middle east', 'mena', 'emea'], uae: ['uae', 'middle east', 'mena', 'emea'], 'saudi arabia': ['middle east', 'mena', 'emea', 'ksa']
  };
  var WORLD = /\b(worldwide|anywhere|global|globally|world|international|any location|everywhere)\b/i;
  // "Remote" on its own is open to everyone; "Remote - US only" or "Remote (Canada)" is not
  function worldLoc(l) {
    if (WORLD.test(l)) return true;
    return !U.norm(l).replace(/\b(100|fully|full|remote|remotely|first|only|work|from|home|wfh|job|position|role|team|distributed)\b/g, ' ').trim();
  }

  function eligibility(job, country) {
    var locs = job.locations.filter(Boolean);
    if (!locs.length || locs.some(worldLoc)) return 'worldwide';
    if (!country) return 'restricted';
    var c = U.norm(country);
    var aliases = (REGIONS[c] || []).concat([c]);
    var hay = ' ' + U.norm(locs.join(' , ')) + ' ';
    var ok = aliases.some(function (a) { return hay.indexOf(' ' + U.norm(a) + ' ') >= 0; });
    return ok ? 'eligible' : 'restricted';
  }

  // ---------------------------------------------------------------- local scoring
  function profileTerms(p) {
    var skills = (p.skills || []).concat(p.tools || []).map(U.norm).filter(Boolean);
    var roles = (p.targetRoles || []).concat([p.currentTitle || '']).concat(p.searchKeywords || []);
    var roleTok = {};
    roles.forEach(function (r) { U.tokens(r).forEach(function (t) { if (!GENERIC[t]) roleTok[t] = 1; }); });
    return { skills: U.uniq(skills), roleTok: Object.keys(roleTok) };
  }

  function localScore(job, terms) {
    var title = ' ' + U.norm(job.title) + ' ';
    var body = ' ' + U.norm(job.title + ' ' + job.tags.join(' ') + ' ' + U.stripHtml(job.description).slice(0, 4000)) + ' ';
    var roleHits = terms.roleTok.filter(function (t) { return title.indexOf(' ' + t + ' ') >= 0; }).length;
    var skillHits = terms.skills.filter(function (s) { return s && body.indexOf(' ' + s + ' ') >= 0; }).length;
    var roleScore = terms.roleTok.length ? Math.min(1, roleHits / Math.min(3, terms.roleTok.length)) : 0.5;
    var skillScore = terms.skills.length ? Math.min(1, skillHits / Math.min(8, terms.skills.length)) : 0.5;
    var ageDays = job.postedAt ? (Date.now() - job.postedAt) / DAY : 30;
    var fresh = Math.max(0, 1 - ageDays / 30);
    var trustBonus = job.trust === 'verified' ? 0.04 : job.trust === 'caution' ? -0.1 : 0;
    return Math.max(0, Math.min(100, Math.round(100 * (0.45 * roleScore + 0.45 * skillScore + 0.10 * fresh + trustBonus))));
  }

  // ---------------------------------------------------------------- AI ranking
  function rankCacheKey(job, profile, multi) {
    var basis = multi ? multi.map(function (c) { return c.id + (c.profile.headline || '') + (c.profile.skills || []).slice(0, 10).join(','); }).join('|')
      : (profile.headline || '') + (profile.skills || []).join(',') + (profile.targetRoles || []).join(',');
    return job.id + '|' + U.hash(basis);
  }
  function brief(p) {
    return { headline: p.headline || p.currentTitle, years: p.yearsExperience, seniority: p.seniority, skills: (p.skills || []).slice(0, multiCap), targetRoles: p.targetRoles };
  }
  var multiCap = 30;

  function aiRank(jobs, profile, onProgress, multi) {
    var cache = RH.store.get('rank.cache', {});
    var todo = jobs.filter(function (j) { var c = cache[rankCacheKey(j, profile, multi)]; if (c) { Object.assign(j, c); return false; } return true; });
    if (!todo.length) return Promise.resolve(jobs);
    multiCap = multi ? 18 : 30;
    var cand = multi
      ? { cvs: multi.map(function (c, i) { return Object.assign({ cv: i, label: c.label }, brief(c.profile)); }), location: profile.country || profile.location, languages: (profile.languages || []).map(function (l) { return l.language; }) }
      : Object.assign(brief(profile), { location: profile.country || profile.location, languages: (profile.languages || []).map(function (l) { return l.language; }) });
    var batches = [];
    for (var i = 0; i < todo.length; i += 8) batches.push(todo.slice(i, i + 8));
    var done = 0;
    return U.pool(batches, 2, function (batch) {
      var list = batch.map(function (j, k) {
        return { i: k, title: j.title, company: j.company, locations: j.locations.join(', ') || 'unspecified', tags: j.tags.slice(0, 8).join(', '),
          description: U.stripHtml(j.description).replace(/\s+/g, ' ').slice(0, 700) };
      });
      var prompt = 'Candidate:\n' + JSON.stringify(cand) + '\n\nJobs:\n' + JSON.stringify(list) +
        '\n\nFor each job, rate how well the candidate fits (0-100; consider role, seniority, required skills, years, languages, location eligibility). ' +
        'Also judge remoteness: "worldwide" (hire from anywhere), "restricted" (remote but limited to certain countries/regions/timezones), "not_remote" (hybrid/onsite) or "unclear".\n' +
        (multi ? 'The candidate has several CVs (field "cvs"). For each job pick the CV that fits best ("cv": its number) and score the job against that CV.\n' : '') +
        'Return JSON: {"results":[{"i":0,' + (multi ? '"cv":0,' : '') + '"score":0,"reason":"max 18 words why","missing":["up to 3 key missing skills"],"remote":"worldwide|restricted|not_remote|unclear","regions":"allowed regions if restricted"}]}';
      return RH.ai.chatJson(prompt, { system: 'You are a precise job-matching assistant for remote jobs.', maxTokens: 3000 }).then(function (res) {
        var rs = (res && (res.results || res.jobs)) || (Array.isArray(res) ? res : []);
        rs.forEach(function (r) {
          var j = batch[Number(r.i)];
          if (!j) return;
          var info = {
            aiScore: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))), aiReason: String(r.reason || ''),
            aiMissing: Array.isArray(r.missing) ? r.missing.slice(0, 3).map(String) : [], aiRemote: String(r.remote || 'unclear'), aiRegions: String(r.regions || '')
          };
          if (multi && multi[Number(r.cv)]) info.bestCv = multi[Number(r.cv)].id;
          Object.assign(j, info);
          cache[rankCacheKey(j, profile, multi)] = info;
        });
        done += batch.length;
        if (onProgress) onProgress(done, todo.length);
      });
    }).then(function (results) {
      var keys = Object.keys(cache);
      if (keys.length > 800) keys.slice(0, keys.length - 800).forEach(function (k) { delete cache[k]; });
      RH.store.set('rank.cache', cache);
      var errs = results.filter(function (r) { return r && r.error; });
      if (errs.length === results.length && results.length) throw errs[0].error;
      return jobs;
    });
  }

  // ---------------------------------------------------------------- search orchestration
  function defaultPrefs() {
    return { sources: { employers: true, remotive: true, jobicy: true, himalayas: true, remoteok: true, wwr: true, hn: true, arbeitnow: false },
      maxAgeDays: 14, onlyEligible: false, hideNotRemote: true, hideFlagged: true, autoFill: true, aiRankCount: 24, sort: 'match', directOnly: true, appliedMode: 'bottom' };
  }
  function prefs() { var p = RH.store.get('jobs.prefs', null); var d = defaultPrefs(); if (!p) return d; p.sources = Object.assign(d.sources, p.sources || {}); return Object.assign(d, p, { sources: p.sources }); }

  /**
   * search({queries, profile, prefs, onProgress}) -> {jobs, stats, errors}
   */
  // the server reads employers' hiring pages a few at a time; each search nudges it along in the background
  var crawling = false;
  function crawlPing(rounds) {
    if (crawling || !RH.ai.relayReady()) return Promise.resolve(0);
    crawling = true;
    var n = 0;
    function step() {
      return RH.httpJson({ method: 'POST', url: RH.ai.builtinUrl() + '/crawl', headers: { Authorization: 'Bearer ' + RH.ai.builtinToken() }, timeout: 30000 }).then(function (r) {
        n++;
        if (n < rounds && r && r.ran && r.due > 0) return RH.util.sleep(1500).then(step);
      }, function () { });
    }
    return step().then(function () { crawling = false; return n; }, function () { crawling = false; return n; });
  }

  /** Run fn for `key` one at a time, at least gapMs apart (for sources with a per-second limit). */
  var spacedLast = {}, spacedQueue = {};
  function spaced(key, gapMs, fn) {
    var p = (spacedQueue[key] || Promise.resolve()).then(function () {
      return U.sleep(Math.max(0, (spacedLast[key] || 0) + gapMs - Date.now())).then(function () { spacedLast[key] = Date.now(); return fn(); });
    });
    spacedQueue[key] = p.catch(function () { });
    return p;
  }

  function search(opts) {
    if (!opts.skipCrawl) crawlPing(6);
    var profile = opts.profile || {}, pf = opts.prefs || prefs();
    var queries = U.uniq(opts.queries || []).slice(0, 5);
    if (!queries.length) queries = U.uniq((profile.searchKeywords || []).concat(profile.targetRoles || [])).slice(0, 3);
    // no keywords (e.g. the AI couldn't read the CV): fall back to job titles and top skills
    if (!queries.length) queries = U.uniq([profile.currentTitle].concat((profile.experience || []).map(function (e) { return e && e.title; }), (profile.skills || []).slice(0, 2))).slice(0, 3);
    if (!queries.length) return Promise.reject(new Error('Type a job title in the search box (e.g. "react developer"), or tap Re-analyze on your CV.'));
    var progress = opts.onProgress || function () { };
    var stats = {}, errors = [];
    var tasks = [];
    Object.keys(SOURCES).forEach(function (sid) {
      if (!pf.sources[sid]) return;
      var src = SOURCES[sid];
      stats[sid] = { name: src.name, count: 0, status: 'loading' };
      if (src.searchable) {
        queries.forEach(function (q) {
          tasks.push(function () {
            return cached(sid + ':' + U.norm(q), 3 * 3600000, function () { return src.fetch(q); }).then(function (list) {
              try { reportBoards(list); } catch (e) { }
              // Remotive searches full descriptions well; Jobicy's tag search is loose, so its titles must match too
              return list.filter(function (j) { return queryMatch(j, q) || sid === 'remotive'; });
            }).then(function (l) { return { sid: sid, list: l }; }, function (e) { return { sid: sid, error: e }; });
          });
        });
      } else {
        tasks.push(function () {
          return cached(sid + ':feed', src.ttl || 30 * 60000, function () { return src.fetch(); }).then(function (list) {
            try { reportBoards(list); } catch (e) { }
            return list.filter(function (j) { return queries.some(function (q) { return queryMatch(j, q); }); });
          }).then(function (l) { return { sid: sid, list: l }; }, function (e) { return { sid: sid, error: e }; });
        });
      }
    });
    progress({ stage: 'fetch', stats: stats });
    return U.pool(tasks, 5, function (t) {
      return t().then(function (r) {
        var st = stats[r.sid];
        if (r.error) { st.status = 'error'; st.error = String(r.error.message || r.error).slice(0, 120); errors.push(st.name + ': ' + st.error); }
        else { st.count += r.list.length; if (st.status !== 'error') st.status = 'ok'; }
        progress({ stage: 'fetch', stats: stats });
        return r;
      });
    }).then(function (results) {
      var all = [];
      results.forEach(function (r) { if (r && r.list) all = all.concat(r.list); });
      return finalize(all, profile, pf, stats, errors, progress, opts);
    });
  }

  function finalize(all, profile, pf, stats, errors, progress, opts) {
    var cutoff = Date.now() - (pf.maxAgeDays || 14) * DAY;
    var seen = {}, jobs = [], middle = [];
    // when the same job appears in several places keep the employer's own posting
    all.sort(function (a, b) { return ((b.source === 'Employer') - (a.source === 'Employer')) || ((b.postedAt || 0) - (a.postedAt || 0)); });
    all.forEach(function (j) {
      // only web links: a feed entry must never be able to open javascript:, intent: or app deep links
      if (!/^https?:\/\//i.test(j.url || '')) j.url = '';
      if (j.applyUrl && !/^https?:\/\//i.test(j.applyUrl)) j.applyUrl = '';
      if (!j.url && !j.applyUrl) return;
      if (seen[j.key]) { var o = seen[j.key]; if (o.alsoOn.indexOf(j.source) < 0 && o.source !== j.source) o.alsoOn.push(j.source); return; }
      if (j.postedAt && j.postedAt < cutoff) return;
      if (pf.hideNotRemote && !isRemote(j)) return;
      j.alsoOn = [];
      if (pf.directOnly !== false) {
        // job-board-only listings are kept (marked viaBoard): the list hides them unless nothing direct matched
        // or you tap "Show them too"
        var dl = directLink(j);
        if (!dl) { (stats._middle = (stats._middle || 0) + 1); middle.push(j); j.viaBoard = true; }
        else j.applyUrl = dl;
      }
      j.direct = j.source === 'Employer' || linkKind(j.applyUrl) === 'direct';
      j.atsName = j.source === 'Employer' ? (ATS_NAME[j.ats] || '') : atsOf(j.applyUrl);
      trust(j);
      if (pf.hideFlagged && j.trust === 'flagged') { (stats._flagged = (stats._flagged || 0) + 1); return; }
      j.eligibility = eligibility(j, profile.country);
      if (pf.onlyEligible && j.eligibility === 'restricted') return;
      seen[j.key] = j; jobs.push(j);
    });
    var multi = opts.cvs && opts.cvs.length > 1 ? opts.cvs : null;
    var termSets = multi ? multi.map(function (c) { return { id: c.id, t: profileTerms(c.profile) }; }) : [{ id: null, t: profileTerms(profile) }];
    jobs.forEach(function (j) {
      var best = -1;
      termSets.forEach(function (ts) { var sc = localScore(j, ts.t); if (sc > best) { best = sc; if (multi) j.bestCv = ts.id; } });
      j.localScore = best; j.score = best;
    });
    jobs.sort(function (a, b) { return b.localScore - a.localScore || (b.postedAt || 0) - (a.postedAt || 0); });
    var flagged = stats._flagged || 0; delete stats._flagged;
    var middleCount = stats._middle || 0; delete stats._middle;
    try { reportGuesses(middle, seen); } catch (e) { }
    var out = { jobs: jobs, stats: stats, errors: errors, rankedBy: 'keywords', flagged: flagged, middlemen: middleCount };
    if (!RH.ai.available() || opts.skipAi || !jobs.length) return Promise.resolve(sortJobs(out, pf.sort));
    // AI ranks direct jobs first (those are shown by default); board listings get what's left of the budget
    var top = jobs.filter(function (j) { return !j.viaBoard; }).concat(jobs.filter(function (j) { return j.viaBoard; })).slice(0, pf.aiRankCount || 40);
    progress({ stage: 'rank', done: 0, total: top.length, stats: stats });
    return U.pool(top.filter(function (j) { return j.descLazy && !j.descLoaded && (!j.description || j.description.length < 300); }), 6, loadDescription).then(function () {
      top.forEach(function (j) { if (j.descLoaded) trust(j); });
    }).then(function () { return aiRank(top, profile, function (d, t) { progress({ stage: 'rank', done: d, total: t, stats: stats }); }, multi).then(function () {
      jobs.forEach(function (j) {
        if (j.aiScore != null) j.score = j.aiScore;
        if (j.aiRemote === 'not_remote' && pf.hideNotRemote) j.hidden = true;
        if (pf.onlyEligible && j.aiRemote === 'restricted' && j.eligibility !== 'eligible' && j.eligibility !== 'worldwide') j.hidden = true;
      });
      out.jobs = jobs.filter(function (j) { return !j.hidden; });
      out.rankedBy = 'ai';
      return sortJobs(out, pf.sort);
    }, function (e) {
      out.errors.push('AI ranking: ' + String(e.message || e).slice(0, 160));
      return sortJobs(out, pf.sort);
    }); });
  }

  function sortJobs(out, mode) {
    out.jobs.sort(mode === 'date'
      ? function (a, b) { return (b.postedAt || 0) - (a.postedAt || 0); }
      : function (a, b) {
        var ar = a.aiScore != null ? 1 : 0, br = b.aiScore != null ? 1 : 0;
        if (ar !== br) return br - ar;
        return (b.score || 0) - (a.score || 0) || (b.postedAt || 0) - (a.postedAt || 0);
      });
    return out;
  }

  RH.jobs = {
    SOURCES: SOURCES, normalize: N, search: search, finalize: finalize, prefs: prefs, defaultPrefs: defaultPrefs,
    savePrefs: function (p) { RH.store.set('jobs.prefs', p); }, sortJobs: sortJobs,
    queryMatch: queryMatch, isRemote: isRemote, trust: trust, findBoards: findBoards, loadDescription: loadDescription, ATS_NAME: ATS_NAME, eligibility: eligibility, localScore: localScore, profileTerms: profileTerms, toMs: toMs, linkKind: linkKind, crawlPing: crawlPing, directLink: directLink, atsOf: atsOf, isMiddleman: isMiddleman, guessBoards: guessBoards,
    clearCache: function () {
      memCache = {};
      RH.store.get('cache.index', []).forEach(function (k) { RH.store.remove('cache.' + k); });
      Object.keys(SOURCES).forEach(function (s) { RH.store.remove('cache.' + s + ':feed'); });
      RH.store.remove('cache.index');
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
