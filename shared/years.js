/* =========================================================================
   Project Clarity — Years: the direction layer

   The top of the three planning layers:

     Years    direction    where the business and my life are heading (1–3+ yrs)
     Horizon  preparation  what is coming in 3–6 months
     Week     execution    what I am doing now

   The further out you look, the less detail belongs on screen. So this
   view is deliberately sparse: a handful of genuinely important outcomes
   per year under three headings, and a short list of the dated things
   that matter. It is about direction, not documentation — if a year here
   ever needs scrolling, something has gone wrong.

   ── Data model ──────────────────────────────────────────────────────
   One key, an object keyed by item id so sync.js's per-entry three-way
   merge applies:

     pc-ops::<client>::years::v1 = { <id>: item }

     goal = {
       id, kind: 'goal', title, description,
       year,            2027
       category,        'business' | 'personal'
       status,          'planned' | 'active' | 'done' | 'paused'
       targetDate,      'YYYY-MM-DD' | ''
       metricType,      '' | 'currency' | 'number' | 'percent'
       currentValue, targetValue,
       linkedClients:  [],      linkedProjects: [],
       linkedHorizon:  [],      ids of shared/horizon.js items
       priority, notes, order, source, createdAt, updatedAt
     }

     milestone = {
       id, kind: 'milestone', title, date, year, month,
       goalId,      the yearly goal it serves
       horizonId,   the Horizon item that prepares for it
       category, notes, order, source, createdAt, updatedAt
     }

   The year's own theme line lives beside it, keyed by year:

     pc-ops::<client>::years::meta::v1 = { '2027': { theme } }

   The links are the point. A goal knows its Horizon milestones; a
   milestone knows both its goal and its Horizon item; Horizon items
   already carry their own preparation dates. That is enough for the
   intelligence layer to answer, later and without a migration:

     • which yearly goals have nothing supporting them
     • which Horizon items serve no long-term goal
     • what this month is doing for a goal two years out

   window.Years exposes those queries today (unsupportedGoals,
   orphanHorizonItems, supportFor) so the agent layer can be added on top
   rather than retrofitted underneath.
   ========================================================================= */
(function bootYears() {
  'use strict';

  const C = window.CLIENT_DATA;
  if (!C || !C.id) return;
  const CID = C.id;

  const KEY      = 'pc-ops::' + CID + '::years::v1';
  const META_KEY = 'pc-ops::' + CID + '::years::meta::v1';
  const ANCHOR_KEY = 'pc-ops::' + CID + '::years::anchor';
  const SPAN = 3;                          // years visible at once

  /* ── Categories ────────────────────────────────────────────────────
     Green for the business, a warm peach for personal, neutral for a plain
     milestone. Nothing louder than that. Client direction lives inside the
     business goals rather than in a column of its own, so an older item
     filed under a category that no longer exists reads as Business. */
  const CATS = [
    { id: 'business', label: 'Business', tone: 'green' },
    { id: 'personal', label: 'Personal', tone: 'peach' },
  ];
  const catOf = (id) => CATS.find((c) => c.id === id) || CATS[0];
  const STATUSES = [
    { id: 'planned', label: 'Planned' },
    { id: 'active',  label: 'In progress' },
    { id: 'done',    label: 'Achieved' },
    { id: 'paused',  label: 'On hold' },
  ];
  const METRICS = [
    { id: '',         label: 'No measurable target' },
    { id: 'currency', label: 'Amount ($)' },
    { id: 'number',   label: 'Count' },
    { id: 'percent',  label: 'Percentage' },
  ];

  const ICONS = {
    business: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    personal: '<path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1l8.8 8.8 8.8-8.8a5 5 0 0 0 0-7.1z"/>',
    milestone: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  };
  const icon = (k) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[k] || ICONS.milestone) + '</svg>';

  const MON_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const MON_NICE  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /* ── Helpers ───────────────────────────────────────────────────────── */
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function niceDate(s) {
    const d = parseYmd(s);
    return d ? d.getDate() + ' ' + MON_NICE[d.getMonth()] : '';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // 14000 → $14k, 200000 → $200k. Long-term targets are round numbers; the
  // exact cents are never the point at this altitude.
  function fmtValue(v, metric) {
    if (v === '' || v == null || isNaN(Number(v))) return '';
    const n = Number(v);
    if (metric === 'percent') return n + '%';
    const short = Math.abs(n) >= 1000000 ? (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'm'
      : Math.abs(n) >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'k'
      : String(n);
    return (metric === 'currency' ? '$' : '') + short;
  }

  /* ── Storage ───────────────────────────────────────────────────────── */
  function readDict(key) {
    try {
      const o = JSON.parse(localStorage.getItem(key) || '{}');
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch (_) { return {}; }
  }
  const loadAll = () => readDict(KEY);
  const loadMeta = () => readDict(META_KEY);
  function saveMeta(meta) { localStorage.setItem(META_KEY, JSON.stringify(meta)); }
  function newId() { return 'yr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
  const asList = (v) => Array.isArray(v) ? v.filter(Boolean).map(String)
    : (typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

  function normalise(raw, id) {
    const it = Object.assign({}, raw || {});
    it.id = it.id || id || newId();
    it.kind = it.kind === 'milestone' ? 'milestone' : 'goal';
    it.title = String(it.title || '').trim();
    it.notes = String(it.notes || '');
    it.source = it.source === 'agent' ? 'agent' : 'manual';
    it.createdAt = it.createdAt || new Date().toISOString();
    it.order = Number(it.order) || 0;

    if (it.kind === 'milestone') {
      it.date = /^\d{4}-\d{2}-\d{2}$/.test(it.date || '') ? it.date : '';
      it.year = Number(it.year) || (it.date ? Number(it.date.slice(0, 4)) : new Date().getFullYear());
      it.month = it.date ? Number(it.date.slice(5, 7)) - 1 : (Number.isInteger(it.month) ? it.month : null);
      it.goalId = it.goalId || '';
      it.horizonId = it.horizonId || '';
      it.category = it.category && catOf(it.category).id === it.category ? it.category : '';
      return it;
    }
    it.description = String(it.description || '');
    it.year = Number(it.year) || new Date().getFullYear();
    it.category = catOf(it.category).id;
    it.status = STATUSES.some((s) => s.id === it.status) ? it.status : 'planned';
    it.targetDate = /^\d{4}-\d{2}-\d{2}$/.test(it.targetDate || '') ? it.targetDate : '';
    it.metricType = METRICS.some((m) => m.id === it.metricType) ? it.metricType : '';
    it.currentValue = it.currentValue === 0 || it.currentValue ? String(it.currentValue) : '';
    it.targetValue = it.targetValue === 0 || it.targetValue ? String(it.targetValue) : '';
    it.linkedClients = asList(it.linkedClients);
    it.linkedProjects = asList(it.linkedProjects);
    it.linkedHorizon = asList(it.linkedHorizon);
    it.priority = ['high', 'normal', 'low'].indexOf(it.priority) >= 0 ? it.priority : 'normal';
    return it;
  }
  function putItem(item) {
    const all = loadAll();
    const it = normalise(item);
    it.updatedAt = new Date().toISOString();
    all[it.id] = it;
    localStorage.setItem(KEY, JSON.stringify(all));
    return it;
  }
  function deleteItem(id) {
    const all = loadAll();
    delete all[id];
    // A milestone outlives the goal it served; it just stops pointing at it.
    Object.keys(all).forEach((k) => { if (all[k] && all[k].goalId === id) all[k].goalId = ''; });
    Object.keys(all).forEach((k) => {
      if (all[k] && Array.isArray(all[k].linkedHorizon)) {
        all[k].linkedHorizon = all[k].linkedHorizon.filter((x) => x !== id);
      }
    });
    localStorage.setItem(KEY, JSON.stringify(all));
  }
  function items() {
    const all = loadAll();
    return Object.keys(all).map((id) => normalise(all[id], id));
  }
  const goalsFor = (year, cat) => items()
    .filter((i) => i.kind === 'goal' && i.year === year && (!cat || i.category === cat))
    .sort((a, b) => (a.order - b.order) || a.createdAt.localeCompare(b.createdAt));
  const milestonesFor = (year) => items()
    .filter((i) => i.kind === 'milestone' && i.year === year)
    .sort((a, b) => {
      const am = a.month == null ? 99 : a.month, bm = b.month == null ? 99 : b.month;
      return am - bm || (a.date || '').localeCompare(b.date || '') || a.title.localeCompare(b.title);
    });

  /* ── Queries the intelligence layer will ask ───────────────────────
     Written now so the relationships are real rather than decorative. */
  function horizonItems() {
    if (!window.Horizon || typeof window.Horizon.load !== 'function') return {};
    try { return window.Horizon.load(); } catch (_) { return {}; }
  }
  // Goals with nothing beneath them: no Horizon milestone linked, and no
  // dated milestone of their own. "A $50k target with no Q1 milestones."
  function unsupportedGoals(year) {
    const ms = items().filter((i) => i.kind === 'milestone');
    const hz = horizonItems();
    const namedBy = (gid) => Object.keys(hz).some((id) => hz[id] && hz[id].linkedGoal === gid);
    return items().filter((g) => g.kind === 'goal' && g.status !== 'done' && (!year || g.year === year))
      .filter((g) => !g.linkedHorizon.some((id) => hz[id]) && !ms.some((m) => m.goalId === g.id) && !namedBy(g.id));
  }
  // Horizon items no long-term goal is counting on — time that may not be
  // serving any direction.
  function orphanHorizonItems() {
    const hz = horizonItems();
    const claimed = new Set();
    items().forEach((i) => {
      (i.linkedHorizon || []).forEach((id) => claimed.add(id));
      if (i.horizonId) claimed.add(i.horizonId);
    });
    // A Horizon item can also name its goal from its own side.
    Object.keys(hz).forEach((id) => { if (hz[id] && hz[id].linkedGoal) claimed.add(id); });
    return Object.keys(hz).filter((id) => !claimed.has(id)).map((id) => Object.assign({ id }, hz[id]));
  }
  // Everything standing under one goal, across both layers below it.
  function supportFor(goalId) {
    const hz = horizonItems();
    return {
      milestones: items().filter((i) => i.kind === 'milestone' && i.goalId === goalId),
      // Linked from the goal, and from any Horizon item that names it.
      horizon: Array.from(new Set(
        (normalise(loadAll()[goalId] || {}, goalId).linkedHorizon || [])
          .concat(Object.keys(hz).filter((id) => hz[id] && hz[id].linkedGoal === goalId))
      )).filter((id) => hz[id]).map((id) => Object.assign({ id }, hz[id])),
    };
  }

  /* ── View state ────────────────────────────────────────────────────── */
  const state = {
    anchor: Number(localStorage.getItem(ANCHOR_KEY)) || new Date().getFullYear(),
    open: null,
  };
  function setAnchor(y) {
    state.anchor = Number(y) || new Date().getFullYear();
    localStorage.setItem(ANCHOR_KEY, String(state.anchor));
    render();
  }

  /* ── Shell ─────────────────────────────────────────────────────────── */
  function mount() {
    const cal = document.getElementById('planner-cal');
    if (!cal || !cal.querySelector('.cal-head')) return false;
    if (document.getElementById('yr-root')) return true;

    const root = document.createElement('div');
    root.id = 'yr-root';
    root.className = 'yr-root';
    root.innerHTML =
      '<div class="yr-head">' +
        '<div class="yr-intro">' +
          '<h3 class="yr-title">Direction</h3>' +
          '<p class="yr-sub">Where the business and the next few years are heading.</p>' +
        '</div>' +
        '<div class="yr-range">' +
          '<button type="button" class="yr-nav" data-step="-1" aria-label="Earlier years">‹</button>' +
          '<span class="yr-range-label" id="yr-range-label"></span>' +
          '<button type="button" class="yr-nav" data-step="1" aria-label="Later years">›</button>' +
          '<button type="button" class="yr-addyear" id="yr-addyear">+ Add year</button>' +
        '</div>' +
      '</div>' +
      '<div class="yr-board" id="yr-board"></div>';
    cal.appendChild(root);

    window.CalViews.register({ id: 'years', label: 'Years', order: 2, els: [root], onShow: render });

    root.querySelector('.yr-range').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-step]');
      if (b) setAnchor(state.anchor + Number(b.dataset.step));
    });
    root.querySelector('#yr-addyear').addEventListener('click', addYear);

    buildEditor();
    return true;
  }

  // "+ Add year" opens the year after the last one on screen and brings it
  // into view, so adding one is the same gesture as planning it.
  function addYear() {
    const next = state.anchor + SPAN;
    const meta = loadMeta();
    if (!meta[next]) { meta[next] = { theme: '' }; saveMeta(meta); }
    setAnchor(next - SPAN + 1);
    const col = document.querySelector('.yr-col[data-year="' + next + '"] .yr-theme');
    if (col) col.click();
  }

  /* ── Board ─────────────────────────────────────────────────────────── */
  function render() {
    const board = document.getElementById('yr-board');
    if (!board) return;
    const meta = loadMeta();
    const thisYear = new Date().getFullYear();
    const label = document.getElementById('yr-range-label');
    if (label) label.textContent = state.anchor + ' – ' + (state.anchor + SPAN - 1);

    board.innerHTML = '';
    for (let i = 0; i < SPAN; i++) {
      const year = state.anchor + i;
      const col = document.createElement('section');
      col.className = 'yr-col' + (year === thisYear ? ' is-current' : '');
      col.dataset.year = String(year);
      col.innerHTML =
        '<header class="yr-col-head">' +
          '<div class="yr-col-top">' +
            '<h4 class="yr-year">' + year + '</h4>' +
            (year === thisYear ? '<span class="yr-chip">Current year</span>' : '') +
          '</div>' +
          '<p class="yr-theme" role="button" tabindex="0" data-year="' + year + '">' +
            (esc((meta[year] || {}).theme || '') || '<span class="yr-theme-empty">Add a direction for this year</span>') +
          '</p>' +
        '</header>' +
        CATS.map((c) => sectionHtml(year, c)).join('') +
        milestonesHtml(year);
      board.appendChild(col);
    }
    wireBoard(board);
  }

  function sectionHtml(year, cat) {
    const goals = goalsFor(year, cat.id);
    // An empty section keeps its "+ Add goal" visible: hover-to-reveal is
    // fine once a year has content, but not when there is nothing to see.
    return '<section class="yr-sec tone-' + cat.tone + (goals.length ? '' : ' is-empty') + '">' +
      '<header class="yr-sec-head">' +
        '<span class="yr-sec-icon">' + icon(cat.id) + '</span>' +
        '<h5 class="yr-sec-title">' + cat.label.toUpperCase() + '</h5>' +
      '</header>' +
      '<ul class="yr-goals">' + goals.map(goalHtml).join('') + '</ul>' +
      '<button type="button" class="yr-addgoal" data-year="' + year + '" data-cat="' + cat.id + '">+ Add goal</button>' +
      '</section>';
  }

  function goalHtml(g) {
    // A progress bar only where there is something real to measure — this
    // is a direction board, not a KPI dashboard.
    const target = fmtValue(g.targetValue, g.metricType);
    const current = fmtValue(g.currentValue, g.metricType);
    let meta = '';
    if (g.metricType && target) {
      const pct = (Number(g.targetValue) > 0 && g.currentValue !== '')
        ? Math.max(0, Math.min(100, Math.round((Number(g.currentValue) / Number(g.targetValue)) * 100))) : null;
      meta =
        '<div class="yr-metric">' +
          (pct == null ? '' : '<span class="yr-bar"><span style="width:' + pct + '%"></span></span>') +
          '<span class="yr-metric-text">' + (current ? esc(current) + ' → ' + esc(target) : 'Target: ' + esc(target)) + '</span>' +
        '</div>';
    } else if (g.targetDate) {
      meta = '<span class="yr-when">' + esc(niceDate(g.targetDate) + ' ' + g.targetDate.slice(0, 4)) + '</span>';
    } else if (g.description) {
      meta = '<span class="yr-when">' + esc(g.description.length > 22 ? g.description.slice(0, 20) + '…' : g.description) + '</span>';
    }
    return '<li class="yr-goal status-' + g.status + '" data-id="' + g.id + '" draggable="true" tabindex="0" role="button">' +
      '<span class="yr-goal-mark" aria-hidden="true"></span>' +
      '<span class="yr-goal-title">' + (esc(g.title) || 'Untitled') + '</span>' +
      meta +
      '</li>';
  }

  function milestonesHtml(year) {
    const ms = milestonesFor(year);
    return '<section class="yr-miles">' +
      '<h5 class="yr-miles-title">Key dates / milestones</h5>' +
      '<ul class="yr-miles-list">' + ms.map((m) => {
        const mon = m.month == null ? '—' : MON_SHORT[m.month];
        const sub = m.notes ? m.notes : (m.date ? niceDate(m.date) : 'Dates TBC');
        return '<li class="yr-mile' + (m.category ? ' tone-' + catOf(m.category).tone : '') + '" ' +
          'data-id="' + m.id + '" draggable="true" tabindex="0" role="button">' +
          '<span class="yr-mile-mon">' + mon + '</span>' +
          '<span class="yr-mile-body">' +
            '<span class="yr-mile-title">' + (esc(m.title) || 'Untitled') + '</span>' +
            '<span class="yr-mile-sub">' + esc(sub) + '</span>' +
          '</span>' +
          '<span class="yr-mile-chev" aria-hidden="true">›</span>' +
          '</li>';
      }).join('') + '</ul>' +
      '<button type="button" class="yr-addmile" data-year="' + year + '">+ Add milestone</button>' +
      '</section>';
  }

  function wireBoard(board) {
    board.querySelectorAll('.yr-theme').forEach((el) => {
      const edit = () => editTheme(el);
      el.addEventListener('click', edit);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); edit(); } });
    });
    board.querySelectorAll('.yr-addgoal').forEach((b) => b.addEventListener('click', () =>
      openEditor(null, { kind: 'goal', year: Number(b.dataset.year), category: b.dataset.cat })));
    board.querySelectorAll('.yr-addmile').forEach((b) => b.addEventListener('click', () =>
      openEditor(null, { kind: 'milestone', year: Number(b.dataset.year) })));

    board.querySelectorAll('.yr-goal, .yr-mile').forEach((row) => {
      row.addEventListener('click', () => openEditor(row.dataset.id));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(row.dataset.id); }
      });
      row.addEventListener('dragstart', (e) => {
        row.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', row.dataset.id); } catch (_) {}
      });
      row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
    });

    board.querySelectorAll('.yr-col').forEach((col) => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('is-drop'); });
      col.addEventListener('dragleave', () => col.classList.remove('is-drop'));
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('is-drop');
        const id = (() => { try { return e.dataTransfer.getData('text/plain'); } catch (_) { return ''; } })();
        const all = loadAll();
        if (!id || !all[id]) return;
        moveToYear(normalise(all[id], id), Number(col.dataset.year));
        render();
      });
    });
  }

  // Moving an item between years takes its dates with it: a goal two years
  // out should not keep a target date in the year you just moved it out of.
  function moveToYear(it, year) {
    if (!year || it.year === year) return;
    const shift = (d) => (d ? year + d.slice(4) : '');
    it.year = year;
    if (it.kind === 'milestone') it.date = shift(it.date);
    else it.targetDate = shift(it.targetDate);
    putItem(it);
  }

  function editTheme(el) {
    const year = Number(el.dataset.year);
    const meta = loadMeta();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'yr-theme-input';
    input.value = (meta[year] || {}).theme || '';
    input.placeholder = 'One line: where this year is going';
    input.maxLength = 90;
    el.replaceWith(input);
    input.focus();
    const commit = () => {
      const m = loadMeta();
      const v = input.value.trim();
      if (v) m[year] = Object.assign({}, m[year], { theme: v });
      else if (m[year]) delete m[year].theme;
      saveMeta(m);
      render();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = (loadMeta()[year] || {}).theme || ''; input.blur(); }
    });
  }

  /* ── Editor ────────────────────────────────────────────────────────── */
  function buildEditor() {
    if (document.getElementById('yr-modal')) return;
    const m = document.createElement('div');
    m.id = 'yr-modal';
    m.className = 'cal-modal yr-modal';
    m.innerHTML =
      '<div class="cal-modal-card yr-modal-card">' +
        '<div class="cal-modal-head">' +
          '<h3 class="cal-modal-date" id="yr-modal-title">Goal</h3>' +
          '<button type="button" class="cal-modal-close" id="yr-close" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="hz-form">' +
          '<label class="hz-field"><span>Title</span>' +
            '<input type="text" id="yr-f-title" placeholder="$50k/month revenue, add 4–6 new clients…"></label>' +
          '<label class="hz-field"><span>Description</span>' +
            '<input type="text" id="yr-f-desc" placeholder="Optional — one line of context"></label>' +
          '<div class="hz-row">' +
            '<label class="hz-field"><span>Category</span><select id="yr-f-cat">' +
              CATS.map((c) => '<option value="' + c.id + '">' + c.label + '</option>').join('') +
              '<option value="">General milestone</option>' +
            '</select></label>' +
            '<label class="hz-field"><span>Year</span><input type="number" id="yr-f-year" min="2000" max="2100" step="1"></label>' +
          '</div>' +
          '<div class="hz-row yr-goal-only">' +
            '<label class="hz-field"><span>Status</span><select id="yr-f-status">' +
              STATUSES.map((s) => '<option value="' + s.id + '">' + s.label + '</option>').join('') + '</select></label>' +
            '<label class="hz-field"><span>Priority</span><select id="yr-f-priority">' +
              '<option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option>' +
            '</select></label>' +
          '</div>' +
          '<label class="hz-field yr-goal-only"><span>Target date</span><input type="date" id="yr-f-target"></label>' +
          '<label class="hz-field yr-mile-only"><span>Date</span><input type="date" id="yr-f-date"></label>' +
          '<div class="hz-row yr-goal-only">' +
            '<label class="hz-field"><span>Measure</span><select id="yr-f-metric">' +
              METRICS.map((m2) => '<option value="' + m2.id + '">' + m2.label + '</option>').join('') + '</select></label>' +
            '<div class="hz-field yr-metric-values"><span>Current / target</span>' +
              '<span class="hz-weeks">' +
                '<input type="number" id="yr-f-current" placeholder="Now">' +
                '<input type="number" id="yr-f-target-val" placeholder="Target">' +
              '</span></div>' +
          '</div>' +
          '<div class="hz-field"><span>Supported by (Horizon)</span>' +
            '<div class="yr-links" id="yr-f-horizon"></div>' +
            '<p class="yr-link-hint" id="yr-link-hint"></p></div>' +
          '<label class="hz-field yr-mile-only"><span>Serves which goal</span><select id="yr-f-goal"></select></label>' +
          '<div class="hz-row yr-goal-only">' +
            '<label class="hz-field"><span>Related clients</span><input type="text" id="yr-f-clients" placeholder="Comma separated"></label>' +
            '<label class="hz-field"><span>Related projects</span><input type="text" id="yr-f-projects" placeholder="Comma separated"></label>' +
          '</div>' +
          '<label class="hz-field"><span>Notes</span><textarea id="yr-f-notes" rows="3" placeholder="Optional"></textarea></label>' +
        '</div>' +
        '<div class="cal-modal-actions hz-actions">' +
          '<button type="button" class="cal-btn hz-danger" id="yr-delete">Delete</button>' +
          '<span class="hz-spacer"></span>' +
          '<button type="button" class="cal-btn" id="yr-cancel">Cancel</button>' +
          '<button type="button" class="cal-btn primary" id="yr-save">Save</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);

    m.addEventListener('click', (e) => { if (e.target === m) closeEditor(); });
    document.getElementById('yr-close').addEventListener('click', closeEditor);
    document.getElementById('yr-cancel').addEventListener('click', closeEditor);
    document.getElementById('yr-save').addEventListener('click', saveEditor);
    document.getElementById('yr-delete').addEventListener('click', () => {
      if (state.open) deleteItem(state.open);
      closeEditor();
      render();
    });
    document.getElementById('yr-f-metric').addEventListener('change', syncMetric);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && m.classList.contains('is-open')) closeEditor();
    });
  }

  function syncMetric() {
    const on = !!document.getElementById('yr-f-metric').value;
    document.querySelector('.yr-metric-values').style.visibility = on ? 'visible' : 'hidden';
  }

  // The Horizon items this goal is counting on, chosen from what Horizon
  // actually holds — the link between the direction layer and preparation.
  function paintHorizonLinks(selected) {
    const box = document.getElementById('yr-f-horizon');
    const hint = document.getElementById('yr-link-hint');
    const hz = horizonItems();
    const ids = Object.keys(hz);
    box.innerHTML = '';
    if (!ids.length) {
      hint.textContent = 'Nothing in Horizon yet — add items there and they can be linked here.';
      return;
    }
    hint.textContent = selected.length ? '' : 'Nothing supporting this yet.';
    ids.map((id) => Object.assign({ id }, hz[id]))
      .sort((a, b) => String(a.month || '').localeCompare(String(b.month || '')))
      .forEach((h) => {
        const row = document.createElement('label');
        row.className = 'yr-link';
        row.innerHTML = '<input type="checkbox" value="' + esc(h.id) + '"' +
          (selected.indexOf(h.id) >= 0 ? ' checked' : '') + '>' +
          '<span class="yr-link-when">' + esc(String(h.month || '').slice(5) ? MON_NICE[Number(String(h.month).slice(5)) - 1] + ' ' + String(h.month).slice(0, 4) : '—') + '</span>' +
          '<span class="yr-link-title">' + esc(h.title || 'Untitled') + '</span>';
        box.appendChild(row);
      });
  }

  function paintGoalPicker(selected, year) {
    const sel = document.getElementById('yr-f-goal');
    const goals = items().filter((i) => i.kind === 'goal');
    sel.innerHTML = '<option value="">Not linked to a goal</option>' +
      goals.map((g) => '<option value="' + esc(g.id) + '">' + esc(g.title) + ' (' + g.year + ')</option>').join('');
    sel.value = selected || '';
  }

  function openEditor(id, defaults) {
    const all = loadAll();
    const it = id && all[id] ? normalise(all[id], id) : normalise(Object.assign({ year: state.anchor }, defaults || {}));
    state.open = id && all[id] ? it.id : null;
    const isGoal = it.kind === 'goal';

    document.getElementById('yr-modal-title').textContent =
      (state.open ? 'Edit ' : 'New ') + (isGoal ? 'goal' : 'milestone');
    document.getElementById('yr-f-title').value = it.title;
    document.getElementById('yr-f-desc').value = it.description || '';
    document.getElementById('yr-f-cat').value = isGoal ? it.category : (it.category || '');
    document.getElementById('yr-f-year').value = it.year;
    document.getElementById('yr-f-status').value = it.status || 'planned';
    document.getElementById('yr-f-priority').value = it.priority || 'normal';
    document.getElementById('yr-f-target').value = it.targetDate || '';
    document.getElementById('yr-f-date').value = it.date || '';
    document.getElementById('yr-f-metric').value = it.metricType || '';
    document.getElementById('yr-f-current').value = it.currentValue || '';
    document.getElementById('yr-f-target-val').value = it.targetValue || '';
    document.getElementById('yr-f-clients').value = (it.linkedClients || []).join(', ');
    document.getElementById('yr-f-projects').value = (it.linkedProjects || []).join(', ');
    document.getElementById('yr-f-notes').value = it.notes;
    paintHorizonLinks(isGoal ? it.linkedHorizon : (it.horizonId ? [it.horizonId] : []));
    paintGoalPicker(it.goalId, it.year);
    syncMetric();

    const modal = document.getElementById('yr-modal');
    modal.classList.toggle('is-goal', isGoal);
    modal.classList.toggle('is-milestone', !isGoal);
    modal.__draft = it;
    document.getElementById('yr-delete').style.visibility = state.open ? 'visible' : 'hidden';
    modal.classList.add('is-open');
    setTimeout(() => document.getElementById('yr-f-title').focus(), 30);
  }

  function closeEditor() {
    const m = document.getElementById('yr-modal');
    if (m) m.classList.remove('is-open');
    state.open = null;
  }

  function saveEditor() {
    const m = document.getElementById('yr-modal');
    const base = (m && m.__draft) || {};
    const title = document.getElementById('yr-f-title').value.trim();
    if (!title) { document.getElementById('yr-f-title').focus(); return; }
    const linked = [...document.querySelectorAll('#yr-f-horizon input:checked')].map((i) => i.value);
    const isGoal = base.kind !== 'milestone';

    const item = Object.assign({}, base, {
      id: state.open || base.id,
      kind: isGoal ? 'goal' : 'milestone',
      title,
      year: Number(document.getElementById('yr-f-year').value) || state.anchor,
      category: document.getElementById('yr-f-cat').value,
      notes: document.getElementById('yr-f-notes').value,
    });
    if (isGoal) {
      Object.assign(item, {
        description: document.getElementById('yr-f-desc').value.trim(),
        status: document.getElementById('yr-f-status').value,
        priority: document.getElementById('yr-f-priority').value,
        targetDate: document.getElementById('yr-f-target').value,
        metricType: document.getElementById('yr-f-metric').value,
        currentValue: document.getElementById('yr-f-current').value,
        targetValue: document.getElementById('yr-f-target-val').value,
        linkedClients: asList(document.getElementById('yr-f-clients').value),
        linkedProjects: asList(document.getElementById('yr-f-projects').value),
        linkedHorizon: linked,
      });
    } else {
      Object.assign(item, {
        date: document.getElementById('yr-f-date').value,
        goalId: document.getElementById('yr-f-goal').value,
        horizonId: linked[0] || '',
      });
    }
    putItem(item);
    closeEditor();
    render();
  }

  /* ── Boot ──────────────────────────────────────────────────────────── */
  function boot(attempt) {
    if (window.CalViews && window.CalViews.ready() && mount()) return;
    if (attempt > 60) return;
    setTimeout(() => boot((attempt || 0) + 1), 50);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot(0));
  else boot(0);

  // The seam for the agent layer: read and write the same items, and ask
  // the questions the links were designed to answer.
  window.Years = {
    load: loadAll, save: putItem, remove: deleteItem, normalise,
    loadMeta, saveMeta, items, goalsFor, milestonesFor,
    unsupportedGoals, orphanHorizonItems, supportFor,
    render, setAnchor, CATS, STATUSES, KEY,
  };
})();
