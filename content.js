(async () => {
  'use strict';

  const clean = s => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const norm = s => clean(s).toUpperCase();

  // ---------- storage (chrome.storage.local) ----------
  const hasStore = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const sget = key => new Promise(res => { try { hasStore ? chrome.storage.local.get(key, v => res(v && v[key])) : res(undefined); } catch (e) { res(undefined); } });
  const sset = (key, val) => new Promise(res => { try { hasStore ? chrome.storage.local.set({ [key]: val }, () => res()) : res(); } catch (e) { res(); } });
  // Messages to the background worker (which holds the home address + Google API key)
  const sendMsg = msg => new Promise(res => {
    try {
      chrome.runtime.sendMessage(msg, r => res(r || { error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'No response from the extension' }));
    } catch (e) { res({ error: e.message }); }
  });

  // ---------- Results page only ----------
  // Find each job's first row by structure (not by link id), so "In Callout" rows are found too.
  let firstRows = [];
  {
    const rows = [...document.querySelectorAll('tr[id^="sidious.job.top."]')];
    rows.forEach((r, k) => { if (k === 0 || r.id !== rows[k - 1].id) firstRows.push(r); });
    if (!firstRows.length) {
      firstRows = [...document.querySelectorAll('a[id^="sidious.job."]')].map(a => a.closest('tr')).filter(Boolean);
    }
  }
  // "Search finished": the results page only appears once the server is done, so landing on it is the signal.
  // That covers a new search, Next, and Return To List. (Not the blank search form, and not the error page.)
  const isResultsPage = /\/substituteAvailableJob(?:Detail)?Action\.do$/.test(window.location.pathname) && !!document.getElementById('startDate');
  const notifyEnabled = (await sget('notifyEnabled')) !== false;
  async function notifyIfAway(count, calloutCount, errText) {
    try {
      if (!isResultsPage || !notifyEnabled) return;
      if (document.visibilityState === 'visible' && document.hasFocus()) return; // you're already looking at it
      const message = count === 0
        ? (errText || 'No jobs found')
        : `${count} job${count === 1 ? '' : 's'} ready` + (calloutCount ? ` (${calloutCount} in callout hidden)` : '');
      await sendMsg({ type: 'notifyReady', title: 'SubCentral: search finished', message });
      const clearIt = () => { if (document.visibilityState === 'visible') sendMsg({ type: 'clearNotify' }); };
      document.addEventListener('visibilitychange', clearIt);
      window.addEventListener('focus', clearIt);
    } catch (e) { /* notifications are best-effort */ }
  }
  if (!firstRows.length) {
    const errEl = document.getElementById('sidious.error');
    await notifyIfAway(0, 0, clean(errEl && errEl.textContent));
    return;
  }

  const BOROUGH = { K: 'Brooklyn', M: 'Manhattan', Q: 'Queens', X: 'Bronx', R: 'Staten Island' };
  const BORO_ABBR = { Brooklyn: 'BK', Manhattan: 'MN', Queens: 'QN', Bronx: 'BX', 'Staten Island': 'SI', Other: '—' };
  const BOROUGH_ORDER = ['Brooklyn', 'Manhattan', 'Queens', 'Bronx', 'Staten Island', 'Other'];
  const LEVEL_ORDER = ['Elementary', 'Middle', 'High', 'Unclear'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // ---------- parsing / derived fields ----------
  const parseDT = s => {
    const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(s || '');
    if (!m) return null;
    let h = parseInt(m[4], 10) % 12;
    if (m[6].toUpperCase() === 'PM') h += 12;
    return new Date(+m[3], +m[1] - 1, +m[2], h, +m[5]);
  };
  const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  function fmtDT(dt, fallback) {
    if (!dt) return fallback || '';
    let h = dt.getHours();
    const ap = h >= 12 ? 'p' : 'a';
    h = h % 12 || 12;
    const yr = dt.getFullYear() !== new Date().getFullYear() ? '/' + String(dt.getFullYear()).slice(2) : '';
    return `${dt.getMonth() + 1}/${dt.getDate()}${yr} ${h}:${String(dt.getMinutes()).padStart(2, '0')}${ap}`;
  }

  function fmtDays(days) {
    const idx = days.map(d => WEEK.indexOf(d)).filter(i => i >= 0).sort((a, b) => a - b);
    if (!idx.length) return days.join(' ');
    const runs = [];
    let start = idx[0], prev = idx[0];
    for (let k = 1; k < idx.length; k++) {
      if (idx[k] === prev + 1) prev = idx[k];
      else { runs.push([start, prev]); start = prev = idx[k]; }
    }
    runs.push([start, prev]);
    return runs.map(([a, b]) => a === b ? WEEK[a] : b === a + 1 ? `${WEEK[a]} ${WEEK[b]}` : `${WEEK[a]}–${WEEK[b]}`).join(', ');
  }

  // Number of dates between start and end that fall on one of the job's work days (holidays not excluded).
  function countDays(startDt, endDt, days) {
    if (!startDt || !endDt || !days.length) return null;
    let n = 0;
    const d = dayStart(startDt), end = dayStart(endDt);
    for (let k = 0; d <= end && k < 800; k++) {
      if (days.includes(DOW[d.getDay()])) n++;
      d.setDate(d.getDate() + 1);
    }
    return n;
  }

  const title = s => s.toLowerCase().replace(/(^|[\s\-(,/])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/ And /g, ' and ');
  const CLASS_SHORT = { 'SPECIAL EDUCATION': 'Special Ed', 'MUSIC and DANCE': 'Music/Dance', 'COMMON BRANCHES': 'Common Br.' };
  const shortClass = c => CLASS_SHORT[c] || title(c);

  // School level (elementary / middle / high) inferred from a school or site name; null if no clue.
  function detectLevel(s) {
    if (!s) return null;
    if (/\bP\.?\s?S\.?\s*\d|\bELEMENTARY\b|\bPRIMARY\b/i.test(s)) return 'Elementary';
    if (/\b(?:I\.?\s?S\.?|J\.?\s?H\.?\s?S\.?|M\.?\s?S\.?)\s*\d|\bINTERMEDIATE\b|\bMIDDLE SCHOOL\b|\bJUNIOR HIGH\b/i.test(s)) return 'Middle';
    if (/\bHIGH SCHOOL\b|\bH\.?\s?S\.?\b/i.test(s)) return 'High';
    return null;
  }

  // District 75 (flag) and school level (separate): D75 programs sit inside ordinary school buildings,
  // so a D75 job's level comes from the host site named after "@" (e.g. "@ PS 035 ..." -> Elementary).
  function classify(loc) {
    const d75 = /P\d{3}[KMQXR]\b/i.test(loc) || /\bP\.?S\.?\s*\d+[KMQXR]\b/i.test(loc) || /^[A-Z]\d{3}G\d{4}/.test(loc) ||
                /\bOTC\b|OCCUPATIONAL TRAINING|DISTRICT 75|\bD75\b/i.test(loc);
    const parts = loc.split(/\s+(?:@|at)\s+/i);
    const school = parts[0], host = parts.slice(1).join(' ');
    let level;
    if (d75) level = detectLevel(host) || (/\bOTC\b|OCCUPATIONAL TRAINING/i.test(loc) ? 'High' : null) || 'Unclear';
    else level = detectLevel(school) || detectLevel(loc) || 'Unclear';
    return { d75, level };
  }

  // What to search for on Google Maps: the building where the job is (the host site after "@").
  const CODE_ONLY = /^[A-Z]{1,2}\d{3,4}[A-Z]?$/i;
  function commuteQuery(loc, borough) {
    const parts = loc.split(/\s+(?:@|at)\s+/i);
    let site = clean(parts.length > 1 ? parts[parts.length - 1] : parts[0]);
    site = site.replace(/^[A-Z]\d{3}(?:G\d{4})?\s+/, ''); // drop a leading code like "Q087 "
    if (!site || CODE_ONLY.test(site)) return { skip: 'Only a school code is listed, so there is no name to search for' };
    const name = site
      .replace(/\b(P\.?S\.?|I\.?S\.?|J\.?H\.?S\.?|M\.?S\.?)\s*0+(\d)/gi, '$1 $2')
      .replace(/\bSch\b\.?/gi, 'School')
      .replace(/\bELEM\b\.?/gi, 'Elementary');
    return { query: `${name} ${borough && borough !== 'Other' ? borough + ' ' : ''}NY` };
  }

  // Each job = 2 data rows (link row, second-line row sharing the same id)
  const origTable = firstRows[0].closest('table');
  const jobs = firstRows.map((r1, i) => {
    const a = r1.querySelector('a');
    let r2 = r1.nextElementSibling;
    if (!(r2 && r2.id === r1.id)) r2 = null;
    const c1 = [...r1.children].map(td => clean(td.textContent));
    const c2 = r2 ? [...r2.children].map(td => clean(td.textContent)) : [];
    const loc = c1[2] || '';
    const letter = (/^([A-Z])\d{3}/.exec(loc) || [])[1];
    const borough = BOROUGH[letter] || 'Other';
    const startDt = parseDT(c1[1]);
    const endDt = parseDT(c2[1]);
    const days = (c2[3] || '').split(' ').filter(Boolean);
    const action = c1[0] || '';
    const { d75, level } = classify(loc);
    return {
      i, link: a, action, callout: /callout/i.test(action),
      href: a ? new URL(a.getAttribute('href') || '', window.location.href).href : '',
      startDt, endDt, start: fmtDT(startDt, c1[1]), end: fmtDT(endDt, c2[1]),
      loc, borough, d75, level,
      cq: commuteQuery(loc, borough),
      hhmm: startDt ? String(startDt.getHours()).padStart(2, '0') + ':' + String(startDt.getMinutes()).padStart(2, '0') : '08:00',
      commute: null,
      employee: c1[3] || '', vacancy: /^vacancy$/i.test(c1[3] || ''),
      instructions: /^none$/i.test(c1[4] || '') ? '' : (c1[4] || ''),
      classification: c2[2] || '', days,
      requested: /^yes$/i.test(c2[4] || '') ? 'Yes' : '',
      single: !!(startDt && endDt && dayStart(startDt).getTime() === dayStart(endDt).getTime()),
      dayCount: countDays(startDt, endDt, days),
    };
  });

  notifyIfAway(jobs.filter(j => !j.callout).length, jobs.filter(j => j.callout).length);

  // ---------- Filter state ----------
  const DEFAULT = { q: '', classes: [], boroughs: [], levels: [], d75: 'all', type: 'all', duration: 'all', days: [], on: '', showCallout: false };
  const saved = (await sget('filters')) || {};
  const f = { ...DEFAULT, ...saved };
  const classSet = new Set(jobs.map(j => j.classification));
  const boroSet = new Set(jobs.map(j => j.borough));
  const levelSet = new Set(jobs.map(j => j.level));
  f.classes = (f.classes || []).filter(v => classSet.has(v));
  f.boroughs = (f.boroughs || []).filter(v => boroSet.has(v));
  f.levels = (f.levels || []).filter(v => levelSet.has(v));
  f.days = (f.days || []).filter(v => DOW.includes(v));
  f.showCallout = !!f.showCallout;
  if (!['all', 'only', 'exclude'].includes(f.d75)) f.d75 = 'all';
  const sort = { key: null, dir: 1 };
  const persist = () => sset('filters', f);

  // Jobs "In Callout" can't be accepted, so they're hidden unless you tick the box.
  const pool = () => f.showCallout ? jobs : jobs.filter(j => !j.callout);

  function matches(j) {
    if (j.callout && !f.showCallout) return false;
    if (f.q) {
      const hay = norm([j.loc, j.classification, j.employee, j.borough, j.level, j.d75 ? 'D75' : ''].join(' '));
      if (!norm(f.q).split(' ').every(t => hay.includes(t))) return false;
    }
    if (f.classes.length && !f.classes.includes(j.classification)) return false;
    if (f.boroughs.length && !f.boroughs.includes(j.borough)) return false;
    if (f.levels.length && !f.levels.includes(j.level)) return false;
    if (f.d75 === 'only' && !j.d75) return false;
    if (f.d75 === 'exclude' && j.d75) return false;
    if (f.type === 'vacancy' && !j.vacancy) return false;
    if (f.type === 'named' && j.vacancy) return false;
    if (f.duration === 'single' && !j.single) return false;
    if (f.duration === 'multi' && (j.single || !j.endDt)) return false;
    if (f.days.length && !(j.days.length && j.days.every(d => f.days.includes(d)))) return false;
    if (f.on) {
      const [y, mo, d] = f.on.split('-').map(Number);
      const day = new Date(y, mo - 1, d);
      if (!j.startDt || !j.endDt) return false;
      if (day < dayStart(j.startDt) || day > dayStart(j.endDt)) return false;
      if (j.days.length && !j.days.includes(DOW[day.getDay()])) return false;
    }
    return true;
  }

  // ---------- UI (closed shadow root: the site's CSS and scripts can't reach in) ----------
  const host = document.createElement('div');
  host.style.cssText = 'display:block;max-width:100%;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
<style>
  .wrap{font:13px/1.4 "Open Sans",Arial,sans-serif;color:#222;margin:8px 0}
  .bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
  input[type=search],input[type=text],input[type=password]{padding:5px 8px;border:1px solid #888;border-radius:4px;font:inherit}
  input[type=search]{min-width:280px}
  select,input[type=date],button{padding:4px 6px;border:1px solid #888;border-radius:4px;background:#fff;font:inherit}
  button{cursor:pointer}
  .row{display:flex;gap:8px;align-items:flex-start;margin:4px 0}
  .lbl{min-width:150px;font-weight:600;padding-top:3px}
  .chips{display:flex;flex-wrap:wrap;gap:4px}
  .chip{border:1px solid #1a4073;border-radius:12px;padding:2px 9px;cursor:pointer;user-select:none;background:#fff;color:#1a4073}
  .chip input{display:none}
  .chip.on{background:#1a4073;color:#fff}
  .meta{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:8px 0;color:#444}
  .warn{color:#8a4b00}
  .err{color:#a00;font-weight:600}
  details{margin:6px 0;padding:6px 8px;border:1px solid #c9d3e0;border-radius:4px;background:#f7f9fc}
  summary{cursor:pointer;font-weight:600}
  .cs{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px}
  .cs input[type=text]{min-width:300px}
  .hint{color:#555;margin-top:4px}
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%}
  th{position:sticky;top:0;background:#1a4073;color:#fff;text-align:left;padding:5px 7px;cursor:pointer;white-space:nowrap;user-select:none}
  td{padding:4px 7px;border-bottom:1px solid #ddd;white-space:nowrap;vertical-align:top}
  td.wrap{white-space:normal;min-width:150px;max-width:260px}
  tbody tr:nth-child(even) td{background:#f4f7fb}
  a{color:#0b4a9e}
  a.callout{color:#a33}
  .badge{background:#e6f2e6;border:1px solid #9bc59b;border-radius:3px;padding:0 5px}
  .d75{background:#fff1dc;border:1px solid #e3b574;border-radius:3px;padding:0 5px;margin-left:3px}
  .q{color:#888}
  .empty{padding:14px;color:#666}
</style>
<div class="wrap">
  <div class="bar">
    <input id="q" type="search" placeholder="Search school, classification, employee">
    <select id="type"><option value="all">Vacancy + absence</option><option value="vacancy">Vacancy only</option><option value="named">Named employee only</option></select>
    <select id="duration"><option value="all">Any length</option><option value="single">Single day</option><option value="multi">Multi-day</option></select>
    <select id="d75"><option value="all">D75 + general ed</option><option value="only">D75 only</option><option value="exclude">No D75</option></select>
    <label>Works on <input id="on" type="date"></label>
    <button id="reset">Reset filters</button>
  </div>
  <details id="cset">
    <summary>Commute settings</summary>
    <div class="cs">
      <label>Home address <input id="home" type="text" placeholder="123 Main St, Brooklyn, NY"></label>
      <label>Google Maps API key <input id="key" type="password" autocomplete="off" placeholder="paste once"></label>
      <label>Monthly limits: searches <input id="limPlaces" type="number" min="0" step="100" style="width:80px"> routes <input id="limRoutes" type="number" min="0" step="100" style="width:80px"></label>
      <button id="csave">Save</button>
      <button id="cclear">Clear cached commutes</button>
      <span id="cmsg"></span>
    </div>
    <div class="hint">Saved only in this browser. Without a key, the Bike and Transit columns link to Google Maps instead of showing times.</div>
    <div class="hint" id="cuse"></div>
    <div class="hint">Lookups stop once a limit is reached; saved results keep showing. The defaults sit just under Google's monthly free allowances (5,000 searches, 10,000 route lookups at the time of writing — check Google's pricing page). This counts only this extension's requests.</div>
  </details>
  <div class="row"><span class="lbl">School level</span><span class="chips" id="levels"></span></div>
  <div class="row"><span class="lbl">Classification</span><span class="chips" id="classes"></span></div>
  <div class="row"><span class="lbl">Borough</span><span class="chips" id="boroughs"></span></div>
  <div class="row"><span class="lbl">Only jobs I can work on</span><span class="chips" id="days"></span></div>
  <div class="meta">
    <b id="count"></b>
    <span id="cprog"></span>
    <label><input type="checkbox" id="callout"> Show jobs in callout (<span id="ncallout">0</span>)</label>
    <label><input type="checkbox" id="notify"> Notify me when a search finishes</label>
    <label><input type="checkbox" id="orig"> Show original list</label>
    <span class="warn">Heads up: clicking Details makes the site drop this list until you search again.</span>
  </div>
  <div class="err" id="cerr" hidden></div>
  <div class="scroll" id="tablewrap"><table><thead><tr id="head"></tr></thead><tbody id="body"></tbody></table><div class="empty" id="empty" hidden>No jobs match these filters.</div></div>
</div>`;
  origTable.parentNode.insertBefore(host, origTable);
  const $ = sel => root.querySelector(sel);

  // ---------- commute (bike + transit) ----------
  let cfg = { home: '', hasKey: false, limits: { places: 4500, routes: 9000 } };
  async function refreshUsage() {
    const u = await sendMsg({ type: 'getUsage' });
    if (u.error) return;
    $('#cuse').textContent = `This month (this browser): ${u.places.toLocaleString()} / ${u.limits.places.toLocaleString()} searches · ${u.routes.toLocaleString()} / ${u.limits.routes.toLocaleString()} route lookups`;
  }
  let commuteRun = 0;
  let commuteError = '';
  let renderTimer = null;
  const scheduleRender = () => { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 60); };

  const mapsUrl = (j, mode) =>
    'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(cfg.home) +
    '&destination=' + encodeURIComponent(j.cq.query) + '&travelmode=' + mode;

  // Fill in commute times for the jobs you can see. Results are cached by the background worker,
  // so schools seen before cost nothing on later searches.
  async function ensureCommutes() {
    const run = ++commuteRun;
    commuteError = '';
    $('#cerr').hidden = true;
    if (!cfg.home || !cfg.hasKey) { $('#cprog').textContent = ''; render(); return; }

    const groups = new Map();
    pool().forEach(j => {
      if (!j.cq.query) { j.commute = { status: 'skipped', reason: j.cq.skip }; return; }
      if (j.commute && j.commute.status) return; // already have an answer
      const k = j.cq.query + '|' + j.hhmm;
      j.commute = { pending: true };
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(j);
    });
    const queue = [...groups.values()];
    const total = queue.length;
    let done = 0;
    const progress = () => { $('#cprog').textContent = done < total ? `Commute: ${done}/${total}…` : ''; };
    progress(); render();

    async function worker() {
      while (queue.length && run === commuteRun && !commuteError) {
        const grp = queue.shift();
        const r = await sendMsg({ type: 'commute', query: grp[0].cq.query, borough: grp[0].borough, hhmm: grp[0].hhmm });
        if (run !== commuteRun) return;
        if (r.error) {
          grp.forEach(j => { j.commute = { status: 'error', reason: r.error }; });
          const e = $('#cerr'); e.textContent = r.error; e.hidden = false;
          if (!r.limit) { // a bad key etc. stops everything; a usage limit only blocks schools that aren't saved yet
            commuteError = r.error;
            queue.forEach(g => g.forEach(j => { j.commute = { status: 'error', reason: r.error }; }));
            queue.length = 0;
          }
        } else {
          grp.forEach(j => { j.commute = r; });
        }
        done++; progress(); scheduleRender();
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    if (run === commuteRun) { $('#cprog').textContent = ''; render(); }
    refreshUsage();
  }

  function commuteCell(j, mode) {
    const el = document.createElement('td');
    const q = (text, tip) => { const s = document.createElement('span'); s.className = 'q'; s.textContent = text; if (tip) s.title = tip; el.appendChild(s); return el; };
    const link = (text, tip, travel) => {
      const a = document.createElement('a');
      a.href = mapsUrl(j, travel); a.target = '_blank'; a.rel = 'noopener'; a.textContent = text;
      if (tip) a.title = tip;
      el.appendChild(a); return el;
    };
    const travel = mode === 'bike' ? 'bicycling' : 'transit';
    if (!cfg.home) return q('—', 'Add your home address under Commute settings');
    if (!j.cq.query) return q('?', j.cq.skip);
    if (!cfg.hasKey) return link('Maps', 'Open Google Maps directions (add an API key to see times here)', travel);
    const c = j.commute;
    if (!c || c.pending) return q('…');
    if (c.status === 'error' || c.status === 'skipped') return q('?', c.reason);
    if (c.status !== 'ok') return link('?', c.reason + ' — click to search Google Maps yourself', travel);
    const m = c[mode];
    if (!m) return link('?', `No ${mode === 'bike' ? 'bike' : 'transit'} route found — click to check Google Maps`, travel);
    return link(`${m.min}m · ${m.mi}mi`, `Matched: ${c.place.name} — ${c.place.address}`, travel);
  }
  const commuteVal = (j, mode) => (j.commute && j.commute.status === 'ok' && j.commute[mode]) ? j.commute[mode].min : null;

  const COLS = [
    { key: 'details', label: '' },
    { key: 'start', label: 'Start', val: j => j.startDt ? j.startDt.getTime() : null },
    { key: 'end', label: 'End', val: j => j.endDt ? j.endDt.getTime() : null },
    { key: 'loc', label: 'School', val: j => j.loc },
    { key: 'borough', label: 'Boro', val: j => BOROUGH_ORDER.indexOf(j.borough) },
    { key: 'level', label: 'Level', val: j => LEVEL_ORDER.indexOf(j.level) },
    { key: 'bike', label: 'Bike', title: 'Bike time and distance from your home address', val: j => commuteVal(j, 'bike') },
    { key: 'transit', label: 'Transit', title: 'Transit time and distance, arriving at the job start time on the next weekday', val: j => commuteVal(j, 'transit') },
    { key: 'classification', label: 'Class', val: j => j.classification },
    { key: 'employee', label: 'Covering', val: j => j.vacancy ? '' : j.employee },
    { key: 'days', label: 'Days', val: j => j.days.length },
    { key: 'dayCount', label: '#', title: 'Number of work days between start and end (holidays not excluded)', val: j => j.dayCount },
    { key: 'instructions', label: 'Instr.', val: j => j.instructions },
    { key: 'requested', label: 'Req.', title: 'You were requested', val: j => j.requested },
  ];

  function td(content, cls, tip) {
    const el = document.createElement('td');
    if (cls) el.className = cls;
    if (tip) el.title = tip;
    if (content instanceof Node) el.appendChild(content); else el.textContent = content;
    return el;
  }
  function rowEl(j) {
    const tr = document.createElement('tr');
    // Clicking goes through the site's own link, so it behaves exactly like the original.
    // Ctrl/Cmd/Shift/middle-click still use the real href.
    const a = document.createElement('a');
    a.href = j.href || '#'; a.textContent = j.action || 'Details';
    if (j.callout) a.className = 'callout';
    a.addEventListener('click', e => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (!j.link || !j.link.isConnected) return;
      e.preventDefault();
      j.link.click();
    });
    tr.appendChild(td(a));
    tr.appendChild(td(j.start));
    tr.appendChild(td(j.end));
    tr.appendChild(td(j.loc, 'wrap'));
    tr.appendChild(td(BORO_ABBR[j.borough], '', j.borough));
    // Level always shown; D75 is an extra badge, not a replacement for the level
    const lv = document.createElement('span');
    lv.textContent = j.level === 'Elementary' ? 'Elem' : j.level === 'Unclear' ? '?' : j.level;
    if (j.d75) { const b = document.createElement('span'); b.className = 'd75'; b.textContent = 'D75'; lv.appendChild(b); }
    tr.appendChild(td(lv, '', (j.level === 'Unclear' ? 'Level not clear from the name' : j.level) + (j.d75 ? ' · District 75' : '')));
    tr.appendChild(commuteCell(j, 'bike'));
    tr.appendChild(commuteCell(j, 'transit'));
    tr.appendChild(td(shortClass(j.classification), '', j.classification));
    if (j.vacancy) {
      const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'Vacancy';
      tr.appendChild(td(b));
    } else tr.appendChild(td(title(j.employee), 'wrap'));
    tr.appendChild(td(fmtDays(j.days)));
    tr.appendChild(td(j.dayCount == null ? '' : String(j.dayCount)));
    tr.appendChild(td(j.instructions));
    tr.appendChild(td(j.requested ? '✓' : ''));
    return tr;
  }

  function renderHead() {
    const head = $('#head');
    head.textContent = '';
    COLS.forEach(c => {
      const th = document.createElement('th');
      th.textContent = c.label + (sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : '');
      if (c.title) th.title = c.title;
      if (c.val) th.addEventListener('click', () => {
        if (sort.key === c.key) { if (sort.dir > 0) sort.dir = -1; else { sort.key = null; sort.dir = 1; } }
        else { sort.key = c.key; sort.dir = 1; }
        renderHead(); render();
      });
      head.appendChild(th);
    });
  }

  function render() {
    let list = jobs.filter(matches);
    if (sort.key) {
      const get = COLS.find(c => c.key === sort.key).val;
      list = list.slice().sort((a, b) => {
        const x = get(a), y = get(b);
        if (x == null && y == null) return a.i - b.i;
        if (x == null) return 1;
        if (y == null) return -1;
        const r = typeof x === 'string' ? x.localeCompare(y) : x - y;
        return r ? r * sort.dir : a.i - b.i;
      });
    }
    const body = $('#body');
    body.textContent = '';
    list.forEach(j => body.appendChild(rowEl(j)));
    $('#count').textContent = `Showing ${list.length} of ${pool().length}`;
    $('#ncallout').textContent = jobs.filter(j => j.callout).length;
    $('#empty').hidden = list.length > 0;
  }

  function changed() { persist(); render(); }

  function chips(container, entries, key) {
    container.textContent = '';
    entries.forEach(e => {
      const lab = document.createElement('label');
      lab.className = 'chip' + (f[key].includes(e.value) ? ' on' : '');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = f[key].includes(e.value);
      cb.addEventListener('change', () => {
        f[key] = cb.checked ? [...f[key], e.value] : f[key].filter(v => v !== e.value);
        lab.classList.toggle('on', cb.checked);
        changed();
      });
      lab.append(cb, document.createTextNode(e.label));
      container.appendChild(lab);
    });
  }

  function buildFacets() {
    const count = (arr, fn) => arr.reduce((m, x) => (m[fn(x)] = (m[fn(x)] || 0) + 1, m), {});
    const P = pool();
    const lc = count(P, j => j.level);
    chips($('#levels'), LEVEL_ORDER.filter(v => lc[v]).map(v => ({ value: v, label: `${v} (${lc[v]})` })), 'levels');
    const cc = count(P, j => j.classification);
    chips($('#classes'),
      Object.keys(cc).sort((a, b) => cc[b] - cc[a] || a.localeCompare(b)).map(v => ({ value: v, label: `${shortClass(v) || '(none)'} (${cc[v]})` })),
      'classes');
    const bc = count(P, j => j.borough);
    chips($('#boroughs'), BOROUGH_ORDER.filter(v => bc[v]).map(v => ({ value: v, label: `${v} (${bc[v]})` })), 'boroughs');
    chips($('#days'), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map(v => ({ value: v, label: v })), 'days');
  }

  function syncControls() {
    $('#q').value = f.q; $('#type').value = f.type; $('#duration').value = f.duration; $('#d75').value = f.d75; $('#on').value = f.on;
    $('#callout').checked = f.showCallout;
    buildFacets();
  }

  $('#q').addEventListener('input', e => { f.q = e.target.value; changed(); });
  $('#type').addEventListener('change', e => { f.type = e.target.value; changed(); });
  $('#duration').addEventListener('change', e => { f.duration = e.target.value; changed(); });
  $('#d75').addEventListener('change', e => { f.d75 = e.target.value; changed(); });
  $('#on').addEventListener('change', e => { f.on = e.target.value; changed(); });
  $('#callout').addEventListener('change', e => { f.showCallout = e.target.checked; buildFacets(); changed(); ensureCommutes(); });
  $('#reset').addEventListener('click', () => { Object.assign(f, DEFAULT, { classes: [], boroughs: [], levels: [], days: [] }); syncControls(); changed(); });
  $('#notify').checked = notifyEnabled;
  $('#notify').addEventListener('change', e => { sset('notifyEnabled', e.target.checked); });
  $('#orig').addEventListener('change', e => {
    origTable.style.display = e.target.checked ? '' : 'none';
    $('#tablewrap').style.display = e.target.checked ? 'none' : '';
  });

  // Commute settings: home address + API key are stored by the background worker, in this browser only.
  const showCfg = () => {
    $('#home').value = cfg.home;
    $('#key').placeholder = cfg.hasKey ? 'key saved — paste a new one to replace' : 'paste once';
    $('#limPlaces').value = cfg.limits.places; $('#limRoutes').value = cfg.limits.routes;
  };
  $('#csave').addEventListener('click', async () => {
    const msg = $('#cmsg');
    const num = id => { const v = $(id).value.trim(); return v === '' ? undefined : Number(v); };
    const r = await sendMsg({ type: 'setConfig', home: $('#home').value, key: $('#key').value, limits: { places: num('#limPlaces'), routes: num('#limRoutes') } });
    $('#key').value = '';
    if (r.error) { msg.textContent = r.error; return; }
    cfg = { home: r.home, hasKey: r.hasKey, limits: r.limits || cfg.limits };
    showCfg();
    jobs.forEach(j => { j.commute = null; });
    msg.textContent = cfg.home ? (cfg.hasKey ? 'Saved ✓' : 'Saved ✓ (add an API key for times)') : 'Saved';
    ensureCommutes();
  });
  $('#cclear').addEventListener('click', async () => {
    await sendMsg({ type: 'clearCache' });
    jobs.forEach(j => { j.commute = null; });
    $('#cmsg').textContent = 'Cache cleared';
    ensureCommutes();
  });

  origTable.style.display = 'none';
  const c0 = await sendMsg({ type: 'getConfig' });
  if (!c0.error) cfg = { home: c0.home || '', hasKey: !!c0.hasKey, limits: c0.limits || cfg.limits };
  showCfg();
  if (!cfg.home || !cfg.hasKey) $('#cset').open = true;
  renderHead();
  syncControls();
  render();
  refreshUsage();
  ensureCommutes();
})();
