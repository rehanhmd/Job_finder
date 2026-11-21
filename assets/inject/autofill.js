/* RemoteHunt page agent — injected into job application pages.
 * collect(): lists the form fields on the page (incl. same-origin iframes) with human labels.
 * fill(fills, file): writes values in a way React/Vue/Angular forms accept.
 * capture(): reads back what the user typed so answers can be remembered.
 * The file evaluates to the agent object and puts nothing on window: a hostile page cannot swap in its own
 * agent. The native side wraps it as (function(){ var __rh = <this file>; return ...; })(). */
(function () {
  var RH = { v: 3 };
  var SKIP_TYPES = /^(hidden|submit|button|image|reset|password|search)$/i;

  function clean(s) { return String(s || '').replace(/\s+/g, ' ').replace(/[*✱]+/g, ' ').trim(); }

  function allDocs() {
    var out = [document];
    var queue = [document];
    while (queue.length) {
      var d = queue.shift();
      var frames = d.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) {
        try {
          var fd = frames[i].contentDocument;
          if (fd && fd.body && out.indexOf(fd) < 0) { out.push(fd); queue.push(fd); }
        } catch (e) { /* cross-origin */ }
      }
    }
    return out;
  }

  function foreignFrames() {
    var list = [];
    allDocs().forEach(function (d) {
      var frames = d.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i], ok = false;
        try { ok = !!(f.contentDocument && f.contentDocument.body); } catch (e) { ok = false; }
        if (!ok && f.src && /^https?:/.test(f.src)) {
          var r = f.getBoundingClientRect ? f.getBoundingClientRect() : { width: 0, height: 0 };
          list.push({ src: f.src, w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
    });
    return list;
  }

  function isVisible(el) {
    if (el.type === 'file') return true; // file inputs are often hidden behind a styled button
    var win = el.ownerDocument.defaultView || window;
    var st = win.getComputedStyle ? win.getComputedStyle(el) : null;
    if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
    if (el.offsetParent === null && st && st.position !== 'fixed') {
      // jsdom has no layout; trust computed style there
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0 && win.navigator && !/jsdom/i.test(win.navigator.userAgent)) return false;
    }
    if (el.closest && el.closest('[aria-hidden="true"]')) return false;
    return true;
  }

  function textOf(node, exclude) {
    if (!node) return '';
    var clone = node.cloneNode(true);
    var junk = clone.querySelectorAll('input,select,textarea,option,script,style,button,svg,[aria-hidden="true"]');
    for (var i = 0; i < junk.length; i++) junk[i].parentNode && junk[i].parentNode.removeChild(junk[i]);
    return clean(clone.textContent);
  }

  function labelFor(el) {
    var doc = el.ownerDocument, t = '';
    var lb = el.getAttribute('aria-labelledby');
    if (lb) {
      t = lb.split(/\s+/).map(function (id) { var n = doc.getElementById(id); return n ? textOf(n) : ''; }).join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.labels && el.labels.length) {
      t = textOf(el.labels[0]);
      if (t) return t;
    }
    if (el.id) {
      try {
        var l2 = doc.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
        if (l2 && textOf(l2)) return textOf(l2);
      } catch (e) { }
    }
    var aria = el.getAttribute('aria-label');
    if (aria && clean(aria).length > 1) return clean(aria);
    // fieldset legend (for radio / checkbox groups)
    var fs = el.closest && el.closest('fieldset');
    if (fs && (el.type === 'radio' || el.type === 'checkbox')) {
      var lg = fs.querySelector('legend');
      if (lg && textOf(lg)) return textOf(lg);
    }
    // walk up: nearest container that has some text other than this field
    var node = el.parentElement, depth = 0;
    while (node && depth < 5 && node !== doc.body) {
      var fields = node.querySelectorAll('input:not([type=hidden]),select,textarea');
      var own = (el.type === 'radio' || el.type === 'checkbox') ? 0 : 1;
      var tx = textOf(node);
      if (tx && tx.length > 1 && (fields.length <= own + 0 || fields.length === 1 || isGroupOf(el, fields))) {
        return tx.slice(0, 300);
      }
      // label-ish previous sibling
      var prev = node.previousElementSibling;
      if (prev && !prev.querySelector('input,select,textarea')) {
        var pt = textOf(prev);
        if (pt && pt.length < 300) return pt;
      }
      node = node.parentElement; depth++;
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '');
  }

  function isGroupOf(el, fields) {
    if (!el.name) return false;
    for (var i = 0; i < fields.length; i++) if (fields[i].name !== el.name) return false;
    return true;
  }

  function optionLabel(input) {
    if (input.labels && input.labels.length) return textOf(input.labels[0]) || input.value;
    var p = input.parentElement;
    if (p && p.tagName === 'LABEL') return textOf(p) || input.value;
    var sib = input.nextElementSibling;
    if (sib && !sib.querySelector('input')) { var t = textOf(sib); if (t) return t; }
    if (p) { var pt = textOf(p); if (pt && pt.length < 120) return pt; }
    return input.value;
  }

  function groupQuestion(inputs) {
    var first = inputs[0];
    var fs = first.closest && first.closest('fieldset');
    if (fs) { var lg = fs.querySelector('legend'); if (lg && textOf(lg)) return textOf(lg); }
    var lb = first.closest && first.closest('[role=radiogroup],[role=group]');
    if (lb) {
      var ll = lb.getAttribute('aria-labelledby');
      if (ll) { var n = first.ownerDocument.getElementById(ll); if (n) return textOf(n); }
      if (lb.getAttribute('aria-label')) return clean(lb.getAttribute('aria-label'));
    }
    // climb until the container holds the whole group, then take text that isn't an option label
    var node = first.parentElement, depth = 0;
    var optTexts = inputs.map(optionLabel);
    while (node && depth < 6) {
      var all = inputs.every(function (i) { return node.contains(i); });
      if (all) {
        var tx = textOf(node);
        optTexts.forEach(function (o) { if (o) tx = tx.split(o).join(' '); });
        tx = clean(tx);
        if (tx.length > 2) return tx.slice(0, 300);
        var prev = node.previousElementSibling;
        if (prev) { var pt = textOf(prev); if (pt) return pt.slice(0, 300); }
      }
      node = node.parentElement; depth++;
    }
    return clean(first.name || '');
  }

  var counter = 0;
  function rid(el) {
    var id = el.getAttribute('data-rh-id');
    if (!id) { id = 'f' + (++counter) + '_' + Math.random().toString(36).slice(2, 6); el.setAttribute('data-rh-id', id); }
    return id;
  }

  RH.collect = function () {
    var fields = [], groups = {};
    allDocs().forEach(function (doc) {
      var els = doc.querySelectorAll('input,textarea,select');
      for (var i = 0; i < els.length; i++) {
        var el = els[i], tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || (tag === 'input' ? 'text' : tag)).toLowerCase();
        if (tag === 'input' && SKIP_TYPES.test(type)) continue;
        if (el.disabled || el.readOnly && type !== 'file') continue;
        if (!isVisible(el)) continue;
        if (type === 'radio' || (type === 'checkbox' && el.name && doc.querySelectorAll('input[type=checkbox][name="' + el.name.replace(/"/g, '\\"') + '"]').length > 1)) {
          var key = type + ':' + (el.form ? 'F' : '') + el.name;
          if (!el.name) key = type + ':' + rid(el);
          if (!groups[key]) {
            groups[key] = { inputs: [], type: type };
            var gf = { id: null, kind: type === 'radio' ? 'radio' : 'checkboxgroup', inputs: groups[key].inputs };
            groups[key].field = gf;
            fields.push(gf);
          }
          groups[key].inputs.push(el);
          continue;
        }
        var f = {
          id: rid(el),
          kind: tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : (type === 'checkbox' ? 'checkbox' : type === 'file' ? 'file' : type),
          label: labelFor(el),
          name: el.name || '',
          placeholder: el.getAttribute('placeholder') || '',
          autocomplete: el.getAttribute('autocomplete') || '',
          required: !!(el.required || el.getAttribute('aria-required') === 'true'),
          maxLength: el.maxLength > 0 ? el.maxLength : 0
        };
        if (f.kind === 'select') {
          f.options = [];
          for (var o = 0; o < el.options.length; o++) {
            var op = el.options[o];
            f.options.push(clean(op.text || op.value));
          }
          f.value = el.selectedIndex > 0 ? clean(el.options[el.selectedIndex].text) : '';
        } else if (f.kind === 'checkbox') {
          f.value = el.checked ? 'true' : '';
          f.label = labelFor(el) || optionLabel(el);
        } else if (f.kind === 'file') {
          f.value = el.files && el.files.length ? el.files[0].name : '';
          f.accept = el.getAttribute('accept') || '';
        } else {
          f.value = el.value || '';
        }
        if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete')) f.combobox = true;
        fields.push(f);
      }
    });
    // finalize groups
    fields.forEach(function (f) {
      if (!f.inputs) return;
      var ins = f.inputs;
      var gid = rid(ins[0]);
      ins.forEach(function (i) { i.setAttribute('data-rh-group', gid); });
      f.id = gid;
      f.label = groupQuestion(ins);
      f.name = ins[0].name || '';
      f.options = ins.map(optionLabel);
      f.required = ins.some(function (i) { return i.required; });
      f.value = ins.filter(function (i) { return i.checked; }).map(optionLabel).join(', ');
      delete f.inputs;
    });
    return { url: location.href, title: document.title, fields: fields, frames: foreignFrames() };
  };

  function find(id) {
    var docs = allDocs();
    for (var i = 0; i < docs.length; i++) {
      var el = docs[i].querySelector('[data-rh-id="' + id + '"]');
      if (el) return el;
    }
    return null;
  }
  function findGroup(id) {
    var docs = allDocs(), out = [];
    for (var i = 0; i < docs.length; i++) {
      var els = docs[i].querySelectorAll('[data-rh-group="' + id + '"]');
      for (var j = 0; j < els.length; j++) out.push(els[j]);
    }
    return out;
  }

  function fire(el, type) {
    var win = el.ownerDocument.defaultView || window;
    var ev;
    try { ev = new win.Event(type, { bubbles: true, cancelable: true }); }
    catch (e) { ev = el.ownerDocument.createEvent('Event'); ev.initEvent(type, true, true); }
    el.dispatchEvent(ev);
  }

  function setNativeValue(el, value) {
    var win = el.ownerDocument.defaultView || window;
    var proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype :
      el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    // React tracks the last value on the node; reset it so the change is noticed
    var tracker = el._valueTracker;
    if (tracker && tracker.setValue) tracker.setValue(el.value === value ? value + ' ' : '');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }

  function norm(s) { return clean(s).toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim(); }

  function bestOption(options, want) {
    var w = norm(want);
    if (!w) return -1;
    var best = -1, bestScore = 0;
    for (var i = 0; i < options.length; i++) {
      var o = norm(options[i]);
      if (!o) continue;
      var s = 0;
      // whole words only: "No" must not pick "Not applicable" or "...sponsorship now"
      if (o === w) s = 100;
      else if ((o + ' ').indexOf(w + ' ') === 0 || (w + ' ').indexOf(o + ' ') === 0) s = 80;
      else if ((' ' + o + ' ').indexOf(' ' + w + ' ') >= 0 || (' ' + w + ' ').indexOf(' ' + o + ' ') >= 0) s = 60;
      else {
        var wt = w.split(' '), ot = o.split(' '), hit = 0;
        wt.forEach(function (t) { if (t.length > 1 && ot.indexOf(t) >= 0) hit++; });
        s = hit ? 20 + 30 * hit / Math.max(wt.length, ot.length) : 0;
      }
      if (s > bestScore) { bestScore = s; best = i; }
    }
    return bestScore >= 20 ? best : -1;
  }
  RH.bestOption = bestOption;

  function mark(el, ai) {
    try {
      el.style.outline = ai ? '2px solid #f59e0b' : '2px solid #22c55e';   // amber = written by AI, please skim
      el.style.backgroundColor = ai ? 'rgba(245,158,11,0.10)' : 'rgba(34,197,94,0.08)';
      if (ai) el.setAttribute('title', 'Written by AI from your CV — skim and personalise before submitting');
    } catch (e) { }
  }

  function b64ToFile(file, win) {
    var bin = win.atob(file.b64), len = bin.length, bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new win.File([bytes], file.name, { type: file.mime || 'application/octet-stream' });
  }

  // AI answers arrive 10-60 s after the scan: a field that has a value we didn't put there was typed by the
  // user in the meantime (fields that already had a value at scan time are never planned) and is left alone.
  var FILLED = 'data-rh-filled';
  function userTyped(el) {
    if (el.hasAttribute(FILLED)) return false;
    if (el.tagName === 'SELECT') { var o = el.options[el.selectedIndex]; return el.selectedIndex > 0 && !!o && !/^(select|choose|please|--|—|pick)/i.test(String(o.text || '').trim()) && !!String(o.text || '').trim(); }
    return !!String(el.value || '').trim();
  }

  RH.fill = function (fillsJson, file) {
    var fills = typeof fillsJson === 'string' ? JSON.parse(fillsJson) : fillsJson;
    var res = { filled: 0, failed: [], files: 0, kept: 0 };
    fills.forEach(function (f) {
      try {
        if (f.kind === 'radio' || f.kind === 'checkboxgroup') {
          var ins = findGroup(f.id);
          if (!ins.length) { res.failed.push(f.id); return; }
          var wants = Array.isArray(f.value) ? f.value : [f.value];
          if (ins.some(function (x) { return x.checked && !x.hasAttribute(FILLED); })) { res.kept++; return; }
          var labels = ins.map(optionLabel), any = false;
          wants.forEach(function (w) {
            var idx = bestOption(labels, w);
            if (idx < 0) return;
            var inp = ins[idx];
            if (!inp.checked) inp.click();
            if (!inp.checked) { inp.checked = true; fire(inp, 'change'); }
            ins.forEach(function (x) { x.setAttribute(FILLED, '1'); });
            mark(inp.parentElement || inp); any = true;
          });
          if (any) res.filled++; else res.failed.push(f.id);
          return;
        }
        var el = find(f.id);
        if (!el) { res.failed.push(f.id); return; }
        if (f.kind === 'file') {
          if (!file || !file.b64) { res.failed.push(f.id); return; }
          var win = el.ownerDocument.defaultView || window;
          var dt = new win.DataTransfer();
          dt.items.add(b64ToFile(file, win));
          el.files = dt.files;
          fire(el, 'input'); fire(el, 'change');
          mark(el.parentElement || el);
          res.files++; res.filled++;
          return;
        }
        if (el.type === 'checkbox') {
          var want = f.value === true || /^(true|yes|1|on|checked)$/i.test(String(f.value));
          if (el.checked !== want) el.click();
          if (el.checked !== want) { el.checked = want; fire(el, 'change'); }
          mark(el.parentElement || el); res.filled++;
          return;
        }
        if (el.type !== 'checkbox' && userTyped(el)) { res.kept++; return; }
        if (el.tagName === 'SELECT') {
          var opts = []; for (var i = 0; i < el.options.length; i++) opts.push(el.options[i].text || el.options[i].value);
          var k = bestOption(opts, f.value);
          if (k < 0) { res.failed.push(f.id); return; }
          setNativeValue(el, el.options[k].value);
          el.selectedIndex = k; el.setAttribute(FILLED, '1');
          fire(el, 'input'); fire(el, 'change'); fire(el, 'blur');
          mark(el); res.filled++;
          return;
        }
        var v = String(f.value == null ? '' : f.value);
        if (el.maxLength > 0 && v.length > el.maxLength) v = v.slice(0, el.maxLength);
        try { el.focus(); } catch (e) { }
        setNativeValue(el, v); el.setAttribute(FILLED, '1');
        fire(el, 'input'); fire(el, 'change');
        if (f.ai) res.ai = (res.ai || 0) + 1;
        if (el.getAttribute('role') === 'combobox') {
          try {
            var win2 = el.ownerDocument.defaultView || window;
            el.dispatchEvent(new win2.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
          } catch (e) { }
        } else {
          fire(el, 'blur');
        }
        mark(el, f.ai); res.filled++;
      } catch (e) {
        res.failed.push(f.id + ':' + e.message);
      }
    });
    return res;
  };

  RH.capture = function () {
    var data = RH.collect();
    var items = data.fields.filter(function (f) {
      return f.kind !== 'file' && f.value && String(f.value).trim() && f.label;
    }).map(function (f) { return { label: f.label, kind: f.kind, value: f.value, options: f.options || null }; });
    return { url: data.url, items: items };
  };

  var DONE = /(thank(s| you) for (applying|your application|submitting)|application (has been |was )?(received|submitted|sent|complete)|we('ve| have) received your application|successfully (applied|submitted)|your application (is|has been) (in|on its way|under review)|application confirmation)/i;
  RH.pageInfo = function () {
    var text = (document.body && document.body.innerText || '').slice(0, 20000);
    return {
      url: location.href, host: location.hostname, origin: location.origin, title: document.title,
      submitted: DONE.test(text) && !document.querySelector('form input[type=email]:not([type=hidden])'),
      hasPassword: !!document.querySelector('input[type=password]'),
      login: !!document.querySelector('input[type=password]') && /(sign in|log ?in|create (an )?account|register|sign up)/i.test(text.slice(0, 4000))
    };
  };

  return RH;
})();
