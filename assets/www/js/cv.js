/* CV: text extraction (PDF / DOCX / TXT / RTF), quick regex parse, AI analysis into a profile. */
(function (g) {
  var RH = g.RH, U = RH.util;

  function loadScript(src) {
    return new Promise(function (res, rej) {
      if (document.querySelector('script[data-src="' + src + '"]')) return res();
      var s = document.createElement('script');
      s.src = src; s.setAttribute('data-src', src);
      s.onload = function () { res(); }; s.onerror = function () { rej(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function pdfText(bytes) {
    return loadScript('lib/pdf.min.js')
      .then(function () { return loadScript('lib/pdf.worker.min.js'); }) // runs pdf.js in-thread (no worker file:// issues)
      .then(function () {
        var lib = g.pdfjsLib;
        lib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
        return lib.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true }).promise;
      })
      .then(function (pdf) {
        var pages = [];
        for (var i = 1; i <= Math.min(pdf.numPages, 15); i++) pages.push(i);
        return Promise.all(pages.map(function (n) {
          return pdf.getPage(n).then(function (pg) { return pg.getTextContent(); }).then(function (tc) {
            var out = '', lastY = null;
            tc.items.forEach(function (it) {
              var y = it.transform ? Math.round(it.transform[5]) : null;
              if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !/\n$/.test(out)) out += '\n';
              out += it.str;
              if (it.hasEOL) out += '\n'; else if (it.str && !/\s$/.test(it.str)) out += ' ';
              lastY = y;
            });
            return out;
          });
        }));
      })
      .then(function (pages) { return pages.join('\n\n'); });
  }

  function docxText(b64) {
    return loadScript('lib/jszip.min.js').then(function () {
      return g.JSZip.loadAsync(b64, { base64: true });
    }).then(function (zip) {
      var f = zip.file('word/document.xml');
      if (!f) throw new Error('Not a valid .docx file');
      return f.async('string');
    }).then(function (xml) {
      var doc = new DOMParser().parseFromString(xml, 'application/xml');
      var W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
      var paras = doc.getElementsByTagNameNS(W, 'p');
      var lines = [];
      for (var i = 0; i < paras.length; i++) {
        var line = '';
        var walker = paras[i].getElementsByTagNameNS(W, '*');
        for (var j = 0; j < walker.length; j++) {
          var n = walker[j];
          if (n.localName === 't') line += n.textContent;
          else if (n.localName === 'tab') line += '\t';
          else if (n.localName === 'br') line += '\n';
        }
        lines.push(line);
      }
      return lines.join('\n');
    });
  }

  function rtfText(s) {
    return s.replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^}]*\}/g, '').replace(/\\[a-z]+-?\d* ?/gi, '')
      .replace(/[{}]/g, '').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function utf8(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); } catch (e) {
      var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s;
    }
  }

  /** Extract plain text from the saved CV. meta: {name, mime}. b64: base64 file content. */
  function extractText(meta, b64) {
    var name = String(meta.name || '').toLowerCase(), mime = String(meta.mime || '').toLowerCase();
    var bytes = b64ToBytes(b64);
    var head = utf8(bytes.slice(0, 5));
    var p;
    if (/pdf/.test(mime) || /\.pdf$/.test(name) || head === '%PDF-') p = pdfText(bytes);
    else if (/wordprocessingml|\.docx$/.test(mime + ' ' + name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) p = docxText(b64);
    else if (/rtf/.test(mime) || /\.rtf$/.test(name) || head.indexOf('{\\rtf') === 0) p = Promise.resolve(rtfText(utf8(bytes)));
    else if (/msword|\.doc$/.test(mime + ' ' + name)) {
      // legacy .doc: pull readable text runs
      var raw = ''; for (var i = 0; i < bytes.length; i++) { var c = bytes[i]; raw += (c >= 32 && c < 127) || c === 10 || c === 13 ? String.fromCharCode(c) : ' '; }
      p = Promise.resolve(raw.replace(/ {3,}/g, '\n').split('\n').filter(function (l) { return /[a-z]{3,}/i.test(l); }).join('\n'));
    } else p = Promise.resolve(utf8(bytes));
    return p.then(function (t) {
      t = String(t || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (t.length < 40) throw new Error('Could not read text from this file. If it is a scanned image PDF, export it as a text PDF or DOCX.');
      return t;
    });
  }

  var SKILL_WORDS = ['javascript', 'typescript', 'react', 'react native', 'angular', 'vue', 'node.js', 'node', 'next.js', 'python', 'django', 'flask', 'fastapi',
    'java', 'spring', 'kotlin', 'swift', 'ios', 'android', 'flutter', 'dart', 'go', 'golang', 'rust', 'c++', 'c#', '.net', 'php', 'laravel', 'ruby', 'rails',
    'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'graphql', 'rest', 'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'linux', 'devops', 'ci/cd',
    'machine learning', 'deep learning', 'nlp', 'pytorch', 'tensorflow', 'data science', 'data analysis', 'pandas', 'excel', 'power bi', 'tableau', 'spark',
    'figma', 'ui/ux', 'ux design', 'product management', 'project management', 'agile', 'scrum', 'jira', 'seo', 'content writing', 'copywriting',
    'digital marketing', 'social media', 'sales', 'customer support', 'customer success', 'accounting', 'bookkeeping', 'quickbooks', 'recruiting',
    'html', 'css', 'tailwind', 'wordpress', 'shopify', 'salesforce', 'hubspot', 'qa', 'selenium', 'cypress', 'testing', 'security', 'blockchain', 'solidity'];

  /** Offline extraction used when no AI key is configured (and as a safety net). */
  function quickParse(text) {
    var t = String(text || '');
    var email = (t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [''])[0];
    var phone = (t.match(/(\+?\d[\d\s().-]{7,}\d)/) || [''])[0].replace(/\s{2,}/g, ' ').trim();
    var linkedin = (t.match(/(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+\/?/i) || [''])[0];
    var github = (t.match(/(https?:\/\/)?(www\.)?github\.com\/[A-Za-z0-9_-]+\/?/i) || [''])[0];
    var urls = t.match(/https?:\/\/[^\s)>,]+/gi) || [];
    var website = urls.filter(function (u) { return !/linkedin|github/i.test(u); })[0] || '';
    var lines = t.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var name = '';
    for (var i = 0; i < Math.min(lines.length, 6); i++) {
      var l = lines[i];
      if (/@|\d{3}|http|curriculum|resume|cv\b/i.test(l)) continue;
      if (/^[A-Za-z][A-Za-z'.-]+(\s+[A-Za-z][A-Za-z'.-]+){1,3}$/.test(l)) { name = l; break; }
    }
    var lower = ' ' + t.toLowerCase().replace(/[\n,;|•·]/g, ' ') + ' ';
    var skills = SKILL_WORDS.filter(function (s) {
      var re = new RegExp('(^|[^a-z0-9+#.])' + s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + '($|[^a-z0-9+#])', 'i');
      return re.test(lower);
    });
    // job title: a short line near the top that names a role (usually right under the name)
    var TITLE_RE = /\b(engineer|developer|programmer|manager|designer|analyst|scientist|architect|consultant|specialist|administrator|lead|director|officer|coordinator|associate|executive|accountant|writer|editor|marketer|marketing|sales|support|recruiter|teacher|tutor|nurse|intern|assistant|representative|technician|tester|qa|devops|sre|product owner|scrum master)\b/i;
    var title = '';
    for (var ti = 0; ti < Math.min(lines.length, 10) && !title; ti++) {
      var tl = lines[ti].split(/\s[|•·–—-]\s|\s{2,}/)[0].trim();
      if (tl !== name && tl.length >= 4 && tl.length <= 60 && TITLE_RE.test(tl) && !/@|https?:|\d{4}|\+?\d[\d\s-]{6,}/.test(tl)) title = tl.replace(/^(title|role|position)\s*:\s*/i, '');
    }
    var years = 0;
    var ym = t.match(/(\d{1,2})\+?\s*(years|yrs)/i);
    if (ym) years = parseInt(ym[1], 10);
    var parts = name.split(/\s+/);
    return {
      fullName: name, firstName: parts[0] || '', lastName: parts.slice(1).join(' '),
      email: email, phone: phone,
      linkedin: linkedin && !/^http/.test(linkedin) ? 'https://' + linkedin : linkedin,
      github: github && !/^http/.test(github) ? 'https://' + github : github,
      website: website, skills: U.uniq(skills), yearsExperience: years || '',
      currentTitle: title, headline: title, targetRoles: title ? [title] : [],
      searchKeywords: U.uniq([title].concat(skills.slice(0, 3))).slice(0, 4)
    };
  }

  var PROFILE_SCHEMA = '{\n' +
    '  "fullName": "", "firstName": "", "lastName": "", "email": "", "phone": "",\n' +
    '  "city": "", "state": "", "country": "", "location": "City, Country",\n' +
    '  "linkedin": "", "github": "", "website": "", "portfolio": "",\n' +
    '  "headline": "one-line professional headline", "summary": "3-4 sentence professional summary in first person",\n' +
    '  "currentTitle": "", "currentCompany": "", "yearsExperience": 0, "seniority": "junior|mid|senior|lead|principal|executive",\n' +
    '  "skills": ["most relevant hard skills, max 30"], "tools": ["software/tools"], "softSkills": ["max 8"],\n' +
    '  "languages": [{"language": "", "level": ""}],\n' +
    '  "experience": [{"title": "", "company": "", "location": "", "start": "MMM YYYY", "end": "MMM YYYY or Present", "highlights": ["max 4 short bullets"]}],\n' +
    '  "education": [{"degree": "", "field": "", "school": "", "start": "YYYY", "end": "YYYY", "grade": ""}],\n' +
    '  "certifications": [""], "achievements": ["max 5"],\n' +
    '  "targetRoles": ["4-8 job titles this person should apply to"],\n' +
    '  "searchKeywords": ["3-6 short search queries for remote job boards, 1-3 words each, e.g. \'react developer\'"],\n' +
    '  "industries": [""],\n' +
    '  "strengths": ["3-5 concrete selling points for recruiters"],\n' +
    '  "improvementTips": ["3-5 specific CV improvement suggestions"]\n' +
    '}';

  function analyze(text) {
    var cvText = String(text).slice(0, 24000);
    var prompt = 'Analyze this CV/resume and extract a structured candidate profile. Use only facts in the CV; leave unknown fields empty (do not invent contact details). ' +
      'Dates as written. Infer targetRoles and searchKeywords for REMOTE job searching based on the strongest, most recent experience.\n\n' +
      'Return JSON exactly in this shape:\n' + PROFILE_SCHEMA + '\n\nCV TEXT:\n"""\n' + cvText + '\n"""';
    return RH.ai.chatJson(prompt, { system: 'You are an expert technical recruiter and CV parser.', maxTokens: 6000 }).then(function (p) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('AI returned an unexpected format');
      return normalizeProfile(p, quickParse(text));
    });
  }

  function asArr(x) {
    if (Array.isArray(x)) return x;
    if (typeof x === 'string' && x.trim()) return x.split(/[,;\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
    return [];
  }

  function normalizeProfile(p, fallback) {
    fallback = fallback || {};
    var out = {};
    ['fullName', 'firstName', 'lastName', 'email', 'phone', 'city', 'state', 'country', 'location', 'linkedin', 'github', 'website', 'portfolio',
      'headline', 'summary', 'currentTitle', 'currentCompany', 'seniority'].forEach(function (k) {
        var v = p[k] != null && p[k] !== '' ? p[k] : fallback[k];
        out[k] = v == null ? '' : String(v).trim();
      });
    if (!out.fullName && (out.firstName || out.lastName)) out.fullName = (out.firstName + ' ' + out.lastName).trim();
    if (out.fullName && !out.firstName) { var parts = out.fullName.split(/\s+/); out.firstName = parts[0]; out.lastName = parts.slice(1).join(' '); }
    if (!out.location) out.location = [out.city, out.state, out.country].filter(Boolean).join(', ');
    out.yearsExperience = parseFloat(p.yearsExperience) || parseFloat(fallback.yearsExperience) || '';
    ['skills', 'tools', 'softSkills', 'certifications', 'achievements', 'targetRoles', 'searchKeywords', 'industries', 'strengths', 'improvementTips'].forEach(function (k) {
      out[k] = U.uniq(asArr(p[k]).map(function (x) { return typeof x === 'string' ? x : (x && (x.name || x.title)) || ''; }).concat(k === 'skills' && asArr(p.skills).length < 8 ? asArr(fallback.skills) : []));
    });
    out.skills = out.skills.slice(0, 40);
    out.searchKeywords = out.searchKeywords.slice(0, 6);
    if (!out.searchKeywords.length) out.searchKeywords = out.targetRoles.slice(0, 3).length ? out.targetRoles.slice(0, 3) : asArr(fallback.searchKeywords);
    out.languages = (Array.isArray(p.languages) ? p.languages : []).map(function (l) {
      return typeof l === 'string' ? { language: l, level: '' } : { language: String(l.language || l.name || ''), level: String(l.level || l.proficiency || '') };
    }).filter(function (l) { return l.language; });
    out.experience = (Array.isArray(p.experience) ? p.experience : []).map(function (e) {
      return { title: String(e.title || e.role || ''), company: String(e.company || e.employer || ''), location: String(e.location || ''),
        start: String(e.start || e.startDate || ''), end: String(e.end || e.endDate || ''), highlights: asArr(e.highlights || e.description).slice(0, 6) };
    }).filter(function (e) { return e.title || e.company; });
    out.education = (Array.isArray(p.education) ? p.education : []).map(function (e) {
      return { degree: String(e.degree || ''), field: String(e.field || e.major || ''), school: String(e.school || e.institution || ''),
        start: String(e.start || ''), end: String(e.end || e.year || ''), grade: String(e.grade || e.gpa || '') };
    }).filter(function (e) { return e.degree || e.school; });
    if (!out.currentTitle && out.experience[0]) out.currentTitle = out.experience[0].title;
    if (!out.currentCompany && out.experience[0] && /present|current|now/i.test(out.experience[0].end)) out.currentCompany = out.experience[0].company;
    return out;
  }

  /** Default answers for common application questions (user editable). */
  function defaultAnswers() {
    return {
      workAuthorization: '', needsSponsorship: '', willingToRelocate: 'No', // sponsorship/work permit: only what you set yourself expectedSalary: '', salaryCurrency: 'USD',
      noticePeriod: '2 weeks', availableFrom: 'Immediately', timezone: '', hearAbout: 'Job board',
      gender: 'Prefer not to say', ethnicity: 'Prefer not to say', veteran: 'I am not a protected veteran', disability: 'Prefer not to say',
      pronouns: '', over18: 'Yes', remoteSetup: 'Yes, I have a dedicated home office with reliable high-speed internet.',
      coverLetterTone: 'friendly, direct and concise', writingSample: ''
    };
  }

  RH.cv = {
    extractText: extractText, quickParse: quickParse, analyze: analyze, normalizeProfile: normalizeProfile,
    defaultAnswers: defaultAnswers, _rtf: rtfText
  };
})(typeof window !== 'undefined' ? window : globalThis);
