/* New-job alerts: when the websites you follow (My sites) get new jobs, tell you with a phone notification and,
 * if you turn it on, an email sent from your own mail account to yourself (same app password as Email tracking).
 * Settings are per account (key "alerts"). The 30-minute background check is SitesJob (Android) + www/bg.html. */
(function (g) {
  var RH = g.RH;

  function cfg() { return Object.assign({ notify: true, email: false, to: '' }, RH.store.get('alerts', {}) || {}); }
  function save(c) { RH.store.set('alerts', c); }

  function smtpHost(mc) {
    var P = RH.mail.PROVIDERS[mc.provider || ''];
    return (P && P.smtp) || String(mc.host || '').replace(/^imap\./i, 'smtp.');
  }

  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  /** Notification title and text for a list of new jobs. */
  function summary(items, accountName) {
    var title = '📌 ' + plural(items.length, 'new job') + ' on your sites' + (accountName ? ' (' + accountName + ')' : '');
    var lines = items.slice(0, 5).map(function (j) { return j.title + ' — ' + j.site; });
    if (items.length > 5) lines.push('+' + (items.length - 5) + ' more');
    return { title: title, text: lines.join('\n') };
  }

  /** Alert email: subject and plain-text body with every new job and its link. */
  function email(items, accountName) {
    var bySite = {};
    items.forEach(function (j) { (bySite[j.site] = bySite[j.site] || []).push(j); });
    var body = 'New jobs on the websites you follow in RemoteHunt' + (accountName ? ' (' + accountName + ')' : '') + ':\n';
    Object.keys(bySite).forEach(function (s) {
      body += '\n' + s + '\n';
      bySite[s].forEach(function (j) { body += '  • ' + j.title + (j.location ? ' (' + j.location + ')' : '') + '\n    ' + (j.applyUrl || j.url) + '\n'; });
    });
    body += '\nOpen RemoteHunt to apply with autofill.\n\nYou get this because "Email me new jobs" is on in RemoteHunt → Settings → New-job alerts.\n';
    var first = items[0];
    return { subject: plural(items.length, 'new job') + ': ' + first.title + ' at ' + first.site + (items.length > 1 ? ' and more' : ''), body: body };
  }

  function sendEmail(subject, body) {
    var mc = RH.mail.cfg(), c = cfg();
    if (!mc || !mc.user || !mc.pass) return Promise.resolve({ status: 0, error: 'Connect your email first (Settings → Email tracking)' });
    return RH.mailSend({ host: smtpHost(mc), port: 465, user: mc.user, pass: mc.pass, to: c.to || mc.user, subject: subject, body: body }).then(function (r) {
      var c2 = cfg();
      if (r.status === 200) { c2.lastEmail = Date.now(); c2.lastEmailError = ''; } else c2.lastEmailError = r.error || 'Could not send';
      save(c2);
      return r;
    });
  }

  /**
   * Tell the user about new jobs. opts.background: from the 30-minute check (phone notification);
   * otherwise the app is open (it shows its own message). The email goes out in both cases if turned on.
   */
  function deliver(items, opts) {
    opts = opts || {};
    if (!items || !items.length) return Promise.resolve({ notified: false, emailed: false });
    var c = cfg(), name = RH.account.list().length > 1 ? RH.account.current().name : '', out = { notified: false, emailed: false };
    if (opts.background && c.notify) {
      var s = summary(items, name);
      RH.nativeCall('notify', 7000 + Math.max(0, RH.account.list().map(function (a) { return a.id; }).indexOf(RH.account.currentId())), s.title, s.text); // one notification per account
      out.notified = true;
    }
    if (!c.email) return Promise.resolve(out);
    var e = email(items, name);
    return sendEmail(e.subject, e.body).then(function (r) { out.emailed = r.status === 200; out.error = r.error; return out; });
  }

  function sendTest() {
    var mc = RH.mail.cfg();
    return sendEmail('RemoteHunt test: new-job alerts work', 'This is a test from RemoteHunt.\n\nWhen the websites you follow get new jobs, you will get an email like this one with each job and its link' +
      (mc && mc.user ? ' at ' + (cfg().to || mc.user) : '') + '.\n');
  }

  /** Is any account asking for alerts? (sites followed + notifications or email on) */
  function wanted() {
    var prev = RH.account.use(RH.account.currentId()), any = false;
    RH.account.list().forEach(function (a) {
      RH.account.use(a.id);
      var c = cfg();
      if (RH.sites.list().length && (c.notify || c.email)) any = true;
    });
    RH.account.use(prev);
    return any;
  }
  /** Start or stop the 30-minute background check to match the settings. */
  function sync() { var on = wanted(); RH.nativeCall('scheduleSiteChecks', on); return on; }

  RH.alerts = { cfg: cfg, save: save, deliver: deliver, sendTest: sendTest, sync: sync, wanted: wanted, summary: summary, email: email, smtpHost: smtpHost };
})(typeof window !== 'undefined' ? window : globalThis);
