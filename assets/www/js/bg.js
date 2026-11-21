/* Background check (www/bg.html, run by SitesJob about every 30 minutes, also when the app is closed):
 * for every account, check the followed sites that are due and alert about new jobs. */
(function (g) {
  var RH = g.RH, start = Date.now(), report = { at: start, accounts: 0, checked: 0, fresh: 0, notified: 0, emailed: 0, errors: [] };
  var ids = RH.account.list().map(function (a) { return a.id; }), i = 0, home = RH.account.currentId();

  function finish() {
    RH.account.use(home);
    report.ms = Date.now() - start;
    if (g.Android && g.Android.done) g.Android.done(JSON.stringify(report));
  }
  function next() {
    if (i >= ids.length) return finish();
    RH.account.use(ids[i++]);
    var c = RH.alerts.cfg();
    if (!RH.sites.list().length || (!c.notify && !c.email)) return next();
    report.accounts++;
    // a little under 30 minutes, so a site checked at the previous run is due again now
    return RH.sites.checkAll(false, 20 * 60000).then(function (r) {
      report.checked += r.checked; report.fresh += r.items.length;
      return RH.alerts.deliver(r.items, { background: true }).then(function (d) {
        if (d.notified) report.notified++;
        if (d.emailed) report.emailed++;
        if (d.error) report.errors.push(String(d.error).slice(0, 120));
      });
    }).catch(function (e) { report.errors.push(String(e && e.message || e).slice(0, 120)); }).then(next);
  }
  try { next(); } catch (e) { report.errors.push(String(e && e.message || e)); finish(); }
})(window);
