/* Voice: makes AI-written application text read like the candidate wrote it.
 * 1) strict style rules in every writing prompt, 2) the candidate's own past answers as style samples,
 * 3) a deterministic clean-up pass that removes stock "AI phrasing" that slips through. */
(function (g) {
  var RH = g.RH;

  var RULES = [
    'Write exactly like this candidate would type it themselves: first person, plain everyday English, the way a capable professional writes a quick but careful note.',
    'Be specific. Use real details from the CV (projects, tools, numbers, company names, results) and connect them to concrete things in the job post. Specific beats impressive.',
    'Mix short and medium sentences. Use contractions (I\'ve, I\'m, I\'d, it\'s). Start some sentences with "I" or "My", it is fine.',
    'No headings, no bullet points, no bold, no emojis, no em dashes or en dashes (use commas or full stops), no semicolons, no exclamation marks.',
    'Never use these words or phrases: thrilled, excited to, passionate, passion for, leverage, utilize, delve, dive into, embark, journey, tapestry, testament, synergy, spearhead, cutting-edge, state-of-the-art, fast-paced, dynamic environment, ever-evolving, landscape, realm, robust, seamless, holistic, pivotal, unwavering, meticulous, foster, elevate, empower, game-changer, I am writing to express, I am confident that, I believe I would be a great fit, look no further, in today\'s world, at the end of the day, I hope this message finds you well, aligns perfectly, resonate, deeply, truly, incredibly.',
    'Do not summarise the job back to them and do not flatter the company. One honest sentence about why this role or company is interesting is enough, and it must mention something specific about them.',
    'Do not end with a generic closing like "I look forward to the opportunity to contribute". If a close is needed, keep it short and normal (for example "Happy to share more about any of this.").',
    'Never invent facts, numbers, employers, degrees or links that are not in the profile.'
  ].join('\n- ');

  function samples(memory, answers) {
    var out = [];
    if (answers && answers.writingSample && answers.writingSample.trim().length > 40) out.push(answers.writingSample.trim().slice(0, 900));
    (memory || []).filter(function (m) {
      var v = String(m.value || '');
      return v.length >= 80 && v.length <= 1200 && /\s/.test(v) && !/^https?:/.test(v);
    }).sort(function (a, b) { return (b.at || 0) - (a.at || 0); }).slice(0, 3).forEach(function (m) { out.push(String(m.value).slice(0, 700)); });
    return out;
  }

  /** The instruction block added to every prompt that writes free text for the candidate. */
  function styleBlock(memory, answers) {
    var s = samples(memory, answers);
    var tone = answers && answers.coverLetterTone ? '\nPreferred tone: ' + answers.coverLetterTone + '.' : '';
    return '\nWRITING STYLE (very important):\n- ' + RULES + tone +
      (s.length ? '\nHere is how the candidate actually writes. Match their tone, sentence length and word choice (do not copy the content):\n' +
        s.map(function (x, i) { return '[Sample ' + (i + 1) + '] ' + x; }).join('\n') : '') + '\n';
  }

  // phrase → replacement ('' removes it). Applied case-insensitively, longest first.
  var SWAPS = [
    [/\bI am writing to (express|convey) my (strong |keen |sincere )?interest in\b/gi, "I'd like to apply for"],
    [/\bI am (thrilled|excited|delighted|eager) to (apply|submit my application) for\b/gi, "I'm applying for"],
    [/\bI(?: am|'m) (thrilled|excited|delighted|eager) to\b/gi, "I'd like to"],
    [/\bI(?: am|'m) (thrilled|excited|delighted|eager) about\b/gi, "I'm interested in"],
    [/\bI(?: am|'m) (deeply |truly |genuinely )?passionate about\b/gi, 'I care a lot about'],
    [/\bmy passion for\b/gi, 'my interest in'],
    [/\b(a |an )?(passion|passionate) for\b/gi, function (m, a) { return a ? 'an interest in' : 'interest in'; }],
    [/\bI am confident that\b/gi, 'I think'],
    [/\bI believe I would be a (great|perfect|strong|excellent) fit\b/gi, 'I think I could do this job well'],
    [/\baligns? perfectly with\b/gi, 'matches'],
    [/\b(fast-paced|dynamic|ever-evolving|ever-changing) (environment|landscape|world)\b/gi, 'busy team'],
    [/\bin today's (digital |modern )?(world|landscape|era)\b,?\s*/gi, ''],
    [/\bleverag(e|ed|ing)\b/gi, function (m) { return { leverage: 'use', leveraged: 'used', leveraging: 'using' }[m.toLowerCase()] || 'use'; }],
    [/\butiliz(e|ed|ing)\b/gi, function (m) { return { utilize: 'use', utilized: 'used', utilizing: 'using' }[m.toLowerCase()] || 'use'; }],
    [/\bdelv(e|ed|ing) (into|deeper)\b/gi, 'look at'],
    [/\bspearhead(ed|ing)?\b/gi, function (m) { return /ed$/i.test(m) ? 'led' : /ing$/i.test(m) ? 'leading' : 'lead'; }],
    [/\bcutting-edge\b|\bstate-of-the-art\b/gi, 'modern'],
    [/\b(seamless|seamlessly)\b/gi, function (m) { return /ly$/i.test(m) ? 'smoothly' : 'smooth'; }],
    [/\brobust\b/gi, 'solid'],
    [/\bholistic\b/gi, 'complete'],
    [/\bpivotal\b/gi, 'key'],
    [/\bmeticulous(ly)?\b/gi, function (m) { return /ly$/i.test(m) ? 'carefully' : 'careful'; }],
    [/\bfoster(ed|ing)?\b/gi, function (m) { return /ed$/i.test(m) ? 'built' : /ing$/i.test(m) ? 'building' : 'build'; }],
    [/\bempower(ed|ing|s)?\b/gi, function (m) { return /ed$/i.test(m) ? 'helped' : /ing$/i.test(m) ? 'helping' : /s$/i.test(m) ? 'helps' : 'help'; }],
    [/\belevat(e|ed|ing)\b/gi, function (m) { return /ed$/i.test(m) ? 'improved' : /ing$/i.test(m) ? 'improving' : 'improve'; }],
    [/\b(a )?testament to\b/gi, 'proof of'],
    [/\b(embark(ed)? on|journey)\b/gi, function (m) { return /embark/i.test(m) ? 'started' : 'path'; }],
    [/\bsynerg(y|ies)\b/gi, 'teamwork'],
    [/\b(truly|deeply|incredibly|genuinely) /gi, ''],
    [/\bI look forward to the opportunity to (contribute|discuss)[^.]*\./gi, 'Happy to share more about any of this.'],
    [/\bThank you for (your time and )?consideration\.?/gi, 'Thanks for reading.'],
    [/\bI hope this (message|email|letter) finds you well\.?\s*/gi, '']
  ];

  /** Clean-up pass for free text written by the AI. */
  function humanize(text) {
    var t = String(text || '');
    t = t.replace(/\r/g, '').replace(/^\s*[-*•]\s+/gm, '').replace(/\*\*|__|^#+\s*/gm, '');
    t = t.replace(/\s*[—–]\s*/g, ', ').replace(/\s+-\s+/g, ', ');
    t = t.replace(/;\s+/g, '. ').replace(/!+/g, '.');
    SWAPS.forEach(function (sw) {
      t = t.replace(sw[0], function (m) {
        var off = arguments[arguments.length - 2], str = arguments[arguments.length - 1];
        // a capitalised word in mid-sentence, or one followed by another capitalised word, is a name: keep it
        if (/^[A-Z]/.test(m) && (!/(^|[.!?:]\s+|\n\s*)$/.test(str.slice(0, off).slice(-3)) || /^\s+[A-Z&+]/.test(str.slice(off + m.length, off + m.length + 3)))) return m;
        return typeof sw[1] === 'function' ? sw[1].apply(null, arguments) : m.replace(sw[0], sw[1]);
      });
    });
    // tidy punctuation and capitalisation after edits
    t = t.replace(/,\s*,/g, ',').replace(/\s+([,.])/g, '$1').replace(/\.\s*\./g, '.').replace(/ {2,}/g, ' ');
    t = t.replace(/(^|[.?]\s+)([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
    t = t.replace(/,\s*\./g, '.').replace(/\n{3,}/g, '\n\n').trim();
    return t;
  }

  /** Words a reviewer would spot; used by tests. */
  function aiTells(text) {
    var bad = /(thrilled|excited to|passionate|leverag|utiliz|delve|tapestry|testament|synergy|spearhead|cutting-edge|fast-paced|ever-evolving|seamless|holistic|pivotal|unwavering|meticulous|foster|elevate|empower|I am writing to express|I am confident that|—|–)/ig;
    return (String(text).match(bad) || []);
  }

  RH.voice = { styleBlock: styleBlock, humanize: humanize, aiTells: aiTells, samples: samples };
})(typeof window !== 'undefined' ? window : globalThis);
