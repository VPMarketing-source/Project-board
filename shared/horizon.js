/* =========================================================================
   Project Clarity — Horizon: the long-term planning layer

   The calendar answers "what am I doing today and this week". Horizon
   answers a different question, one month-to-month task lists are bad at:

     "What important things are coming up over the next 3–6 months, and
      when do I need to START PREPARING for them?"

   So this is deliberately NOT another task list. It shows a small number
   of significant things per month — key dates, preparation milestones,
   client and business milestones, personal events that affect capacity —
   laid out as one column per month, with a lot of whitespace. If you can't
   read the next six months in a few seconds, it isn't doing its job.

   It adds a Week | Horizon switcher to the calendar's header and mounts
   its board beside the month grid. shared/calendar.js is untouched: this
   file injects itself into the shell that file builds, so the day-to-day
   calendar keeps working exactly as before.

   ── Data model ──────────────────────────────────────────────────────
   One localStorage key, an object keyed by item id so sync.js's per-entry
   three-way merge applies (two devices editing different items never
   clobber each other):

     pc-ops::<client>::horizon::v1 = { <id>: item }

     item = {
       id, title,
       type,        'event' | 'prep' | 'client' | 'business' | 'personal'
       month,       'YYYY-MM' — the column it lives in
       date,        'YYYY-MM-DD' | ''  the event date, when it has one
       prepWeeks,   number | null      preparation lead time
       prepStart,   'YYYY-MM-DD' | ''  when preparation should start
       client,      free text — client or category
       notes,       free text
       checklist,   [{ text, done }]
       parentId,    id of the event this prepares for, when it is a prep item
       linkedGoal,     id of the Years goal this serves (shared/years.js)
       linkedProjects: [] the projects/work this milestone is executed through
       source,      'manual' | 'agent'
       createdAt, updatedAt
     }

   linkedGoal and linkedProjects are the rung below: Years links down to
   Horizon, and Horizon links down to the work that executes it. Weekly
   tasks are freeform lines in the day cells with no stable id, so a
   project name is the durable thing to point at until they have one.

   The shape carries event date, preparation lead time, preparation
   milestones (as linked prep items), related client and category, so
   Agent Board can later generate a run of prep items from one dated
   event — "Christmas is 25 Dec and needs 8 weeks" → an October "start
   planning" card, a November "creative due" card, and so on. The editor
   already creates one such card from a lead time; the rest is the same
   data written by a tool instead of by hand.
   ========================================================================= */
(function bootHorizon() {
  'use strict';

  const C = window.CLIENT_DATA;
  if (!C || !C.id) return;                 // no space id → nothing to scope to
  const CID = C.id;

  const KEY      = 'pc-ops::' + CID + '::horizon::v1';
  const ANCHOR_KEY = 'pc-ops::' + CID + '::horizon::anchor';
  const SPAN = 6;                          // months visible at once
  const STEP = 3;                          // months the arrows move

  /* ── Types ─────────────────────────────────────────────────────────
     Colour is restrained on purpose: green for the milestones that mean
     progress, a warm red for fixed dates you cannot move, and plain
     beige for preparation, which is the quiet majority. */
  const TYPES = [
    { id: 'event',    label: 'Key date',           tone: 'red' },
    { id: 'prep',     label: 'Preparation',        tone: 'prep' },
    { id: 'client',   label: 'Client milestone',   tone: 'green' },
    { id: 'business', label: 'Business milestone', tone: 'green' },
    { id: 'personal', label: 'Personal / capacity', tone: 'muted' },
  ];
  const typeOf = (id) => TYPES.find((t) => t.id === id) || TYPES[0];

  const ICONS = {
    event: '<rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/>',
    prep: '<path d="M5 3h9l5 5v13H5z"/><polyline points="14 3 14 8 19 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/>',
    client: '<line x1="4" y1="20" x2="4" y2="10"/><line x1="10" y1="20" x2="10" y2="4"/><line x1="16" y1="20" x2="16" y2="13"/><line x1="22" y1="20" x2="22" y2="7"/>',
    business: '<path d="M3 11v3a1 1 0 0 0 1 1h3l4 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 8a5 5 0 0 1 0 8"/>',
    personal: '<circle cx="9" cy="8" r="3"/><path d="M2 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1"/><path d="M17 8a3 3 0 0 1 0 6"/>',
  };
  const icon = (type) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[type] || ICONS.event) + '</svg>';

  /* ── Dates ─────────────────────────────────────────────────────────── */
  const MON_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const MON_NICE  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DOW_NICE  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  const monthKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  function parseMonth(s) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : null;
  }
  function addMonths(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth() + n, 1);
    return x;
  }
  // "Fri 29 Nov" — the same shorthand the planner uses elsewhere.
  function niceDate(s) {
    const d = parseYmd(s);
    return d ? DOW_NICE[d.getDay()] + ' ' + d.getDate() + ' ' + MON_NICE[d.getMonth()] : '';
  }
  function monthLabel(d) { return MON_NICE[d.getMonth()] + ' ' + d.getFullYear(); }
  function weeksBefore(dateStr, weeks) {
    const d = parseYmd(dateStr);
    if (!d || !weeks) return '';
    d.setDate(d.getDate() - Math.round(weeks) * 7);
    return ymd(d);
  }

  /* ── Storage ───────────────────────────────────────────────────────── */
  function loadAll() {
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || '{}');
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch (_) { return {}; }
  }
  function saveAll(all) { localStorage.setItem(KEY, JSON.stringify(all)); }
  function newId() {
    return 'hz_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }
  // Fill in whatever an item is missing, so hand-written or agent-written
  // entries render without special-casing. An item with a date but no
  // month column is filed under its date's month.
  function normalise(raw, id) {
    const it = Object.assign({}, raw || {});
    it.id = it.id || id || newId();
    it.title = String(it.title || '').trim();
    it.type = typeOf(it.type).id;
    it.date = /^\d{4}-\d{2}-\d{2}$/.test(it.date || '') ? it.date : '';
    it.month = /^\d{4}-\d{2}$/.test(it.month || '') ? it.month : (it.date ? it.date.slice(0, 7) : monthKey(new Date()));
    it.prepWeeks = Number(it.prepWeeks) > 0 ? Number(it.prepWeeks) : null;
    it.prepStart = /^\d{4}-\d{2}-\d{2}$/.test(it.prepStart || '') ? it.prepStart
      : (it.date && it.prepWeeks ? weeksBefore(it.date, it.prepWeeks) : '');
    it.client = String(it.client || '');
    it.notes = String(it.notes || '');
    it.checklist = Array.isArray(it.checklist)
      ? it.checklist.filter((c) => c && typeof c.text === 'string').map((c) => ({ text: c.text, done: !!c.done }))
      : [];
    it.parentId = it.parentId || '';
    it.linkedGoal = it.linkedGoal || '';
    it.linkedProjects = Array.isArray(it.linkedProjects)
      ? it.linkedProjects.filter(Boolean).map(String)
      : (typeof it.linkedProjects === 'string' && it.linkedProjects.trim()
          ? it.linkedProjects.split(',').map((x) => x.trim()).filter(Boolean) : []);
    it.source = it.source === 'agent' ? 'agent' : 'manual';
    it.createdAt = it.createdAt || new Date().toISOString();
    return it;
  }
  function itemsByMonth() {
    const all = loadAll();
    const out = {};
    Object.keys(all).forEach((id) => {
      const it = normalise(all[id], id);
      (out[it.month] || (out[it.month] = [])).push(it);
    });
    // Years' key dates sit alongside this board's own items, read live.
    yearsMilestones().forEach((m) => { (out[m.month] || (out[m.month] = [])).push(m); });
    // Dated things first, in date order; undated milestones after, by title.
    Object.keys(out).forEach((m) => out[m].sort((a, b) => {
      if (a.date && b.date) return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
      if (a.date) return -1;
      if (b.date) return 1;
      return a.title.localeCompare(b.title);
    }));
    return out;
  }
  function putItem(item) {
    const all = loadAll();
    const it = normalise(item);
    it.updatedAt = new Date().toISOString();
    all[it.id] = it;
    saveAll(all);
    return it;
  }
  function deleteItem(id) {
    const all = loadAll();
    delete all[id];
    // A prep card outlives its event, but stops claiming a parent that is gone.
    Object.keys(all).forEach((k) => { if (all[k] && all[k].parentId === id) all[k].parentId = ''; });
    saveAll(all);
  }

  /* ── Key dates from the Years board ──────────────────────────────────
     A dated thing entered once should be visible from both altitudes: on
     the Years card as one of that year's key dates, and here in the month
     it actually falls in. So Horizon READS them at render time — they are
     never copied into this board, which is what stops the two drifting
     apart when a date moves. They stay owned by Years: not draggable here,
     and clicking one opens it there.

     Only dated milestones qualify. A yearly goal is a direction, not an
     event, and does not belong in a month column. */
  const YEARS_KEY = 'pc-ops::' + CID + '::years::v1';

  function yearsMilestones() {
    let items = [];
    try {
      if (window.Years && typeof window.Years.items === 'function') {
        items = window.Years.items();
      } else {
        const raw = JSON.parse(localStorage.getItem(YEARS_KEY) || '{}');
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          items = Object.keys(raw).map((id) => Object.assign({ id }, raw[id]));
        }
      }
    } catch (_) { return []; }
    return items.filter((i) => i && i.kind === 'milestone' && /^\d{4}-\d{2}-\d{2}$/.test(i.date || ''))
      .map((i) => ({
        id: i.id,
        title: String(i.title || ''),
        date: i.date,
        month: i.date.slice(0, 7),
        // A milestone's category is the Years vocabulary; map it onto the
        // tone this board already uses so nothing new appears on screen.
        type: i.category === 'business' ? 'business' : i.category === 'personal' ? 'personal' : 'event',
        notes: String(i.notes || ''),
        // The rest of the shape a card is drawn from. A key date carries no
        // checklist or lead time of its own — those belong to work planned
        // here, not to a date noted a year out.
        client: '', checklist: [], prepWeeks: null, prepStart: '',
        fromYears: true,
      }))
      .filter((i) => i.title);
  }

  /* ── View state ────────────────────────────────────────────────────── */
  const state = {
    anchor: parseMonth(localStorage.getItem(ANCHOR_KEY)) || new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    open: null,        // id of the item being edited
  };
  // Kept as a thin alias: the switcher itself lives in shared/calviews.js.
  function setView(v) { window.CalViews.set(v); }

  function setAnchor(d) {
    state.anchor = new Date(d.getFullYear(), d.getMonth(), 1);
    localStorage.setItem(ANCHOR_KEY, monthKey(state.anchor));
    render();
  }

  /* ── Shell ─────────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function mount() {
    const cal = document.getElementById('planner-cal');
    const head = cal && cal.querySelector('.cal-head');
    if (!cal || !head) return false;
    if (document.getElementById('hz-root')) return true;

    const root = document.createElement('div');
    root.id = 'hz-root';
    root.className = 'hz-root';
    root.innerHTML =
      '<div class="hz-head">' +
        '<div class="hz-intro">' +
          '<h3 class="hz-title">Long-term view</h3>' +
          '<p class="hz-sub">What is coming, and when to start preparing for it.</p>' +
        '</div>' +
        '<div class="hz-range">' +
          '<button type="button" class="hz-nav" data-step="-1" aria-label="Earlier months">‹</button>' +
          '<span class="hz-range-label" id="hz-range-label"></span>' +
          '<button type="button" class="hz-nav" data-step="1" aria-label="Later months">›</button>' +
          '<button type="button" class="hz-today" data-step="0">Today</button>' +
        '</div>' +
      '</div>' +
      '<div class="hz-board" id="hz-board"></div>';
    const months = document.getElementById('cal-months');
    if (months && months.parentNode === cal) cal.insertBefore(root, months.nextSibling);
    else cal.appendChild(root);

    // Register with the shared switcher: it owns which view is on, and
    // repaints this board whenever Horizon is the one showing.
    window.CalViews.register({ id: 'horizon', label: 'Horizon', order: 1, els: [root], onShow: render });

    root.querySelector('.hz-range').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-step]');
      if (!b) return;
      const step = Number(b.dataset.step);
      if (step === 0) setAnchor(new Date());
      else setAnchor(addMonths(state.anchor, step * STEP));
    });

    buildEditor();
    return true;
  }

  /* ── Board ─────────────────────────────────────────────────────────── */
  function render() {
    const board = document.getElementById('hz-board');
    if (!board) return;
    const byMonth = itemsByMonth();
    const first = state.anchor;
    const last = addMonths(first, SPAN - 1);
    const label = document.getElementById('hz-range-label');
    if (label) label.textContent = monthLabel(first) + ' – ' + monthLabel(last);

    const thisMonth = monthKey(new Date());
    const staleNote = board.parentNode.querySelector('.hz-empty');
    if (staleNote) staleNote.remove();
    board.innerHTML = '';
    for (let i = 0; i < SPAN; i++) {
      const d = addMonths(first, i);
      const mk = monthKey(d);
      const items = byMonth[mk] || [];
      const col = document.createElement('section');
      col.className = 'hz-col' + (mk === thisMonth ? ' is-current' : '');
      col.dataset.month = mk;
      col.innerHTML =
        '<header class="hz-col-head">' +
          '<div class="hz-col-when">' +
            '<span class="hz-col-mon">' + MON_SHORT[d.getMonth()] + '</span>' +
            '<span class="hz-col-year">' + d.getFullYear() + '</span>' +
          '</div>' +
          '<span class="hz-col-count">' + (items.length ? items.length + ' item' + (items.length === 1 ? '' : 's') : '') + '</span>' +
        '</header>' +
        '<div class="hz-cards"></div>' +
        '<button type="button" class="hz-add" data-month="' + mk + '">+ Add item</button>';
      const cards = col.querySelector('.hz-cards');
      items.forEach((it) => cards.appendChild(cardEl(it)));
      board.appendChild(col);
    }
    renderEmptyState(board, byMonth);
    wireBoard(board);
  }

  function cardEl(it) {
    const t = typeOf(it.type);
    const el = document.createElement('article');
    el.className = 'hz-card tone-' + t.tone + (it.fromYears ? ' is-from-years' : '');
    el.dataset.id = it.id;
    // A key date belongs to the Years board: it cannot be dragged into
    // another month from here, because the date is what decides its month.
    el.setAttribute('draggable', it.fromYears ? 'false' : 'true');
    if (it.fromYears) el.dataset.fromYears = '1';
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');

    // Subtitle: a key date shows its date, everything else says what it is.
    const sub = it.date ? niceDate(it.date) : t.label;
    const subClass = it.date ? 'hz-card-date' : 'hz-card-kind';
    // Said once, quietly: where this one actually lives.
    const origin = it.fromYears ? '<span class="hz-from-years">Years</span>' : '';

    // Preparation lead time is the whole point of the view, so an event
    // that has one says so in a quiet line rather than hiding it in the editor.
    let prepNote = '';
    if (it.type !== 'prep' && it.prepStart) {
      const ps = parseYmd(it.prepStart);
      if (ps) prepNote = '<p class="hz-card-prep">Start prep ' + esc(niceDate(it.prepStart)) + '</p>';
    }

    const shown = it.checklist.slice(0, 5);
    const rest = it.checklist.length - shown.length;
    const list = shown.length
      ? '<ul class="hz-check">' + shown.map((c, i) =>
          '<li class="hz-check-row' + (c.done ? ' is-done' : '') + '">' +
            '<button type="button" class="hz-check-box" data-check="' + i + '" ' +
              'aria-pressed="' + (c.done ? 'true' : 'false') + '" aria-label="' + esc(c.text) + '"></button>' +
            '<span class="hz-check-text">' + esc(c.text) + '</span>' +
          '</li>').join('') +
          (rest > 0 ? '<li class="hz-check-more">+' + rest + ' more</li>' : '') +
        '</ul>'
      : '';

    el.innerHTML =
      '<div class="hz-card-top">' +
        '<span class="hz-card-icon">' + icon(it.type) + '</span>' +
        '<div class="hz-card-headings">' +
          '<h4 class="hz-card-title">' + (esc(it.title) || '<span class="hz-untitled">Untitled</span>') + '</h4>' +
          '<p class="' + subClass + '">' + esc(sub) + (it.client ? ' · ' + esc(it.client) : '') + origin + '</p>' +
        '</div>' +
        '<span class="hz-dot" aria-hidden="true"></span>' +
      '</div>' +
      prepNote +
      list;
    return el;
  }

  // Shown only when the whole board is empty — an empty planning view is
  // hard to judge, and the seasonal anchors are the same every year.
  function renderEmptyState(board, byMonth) {
    if (Object.keys(byMonth).length) return;
    if (yearsMilestones().length) return;       // the months are not bare
    const note = document.createElement('div');
    note.className = 'hz-empty';
    note.innerHTML =
      '<p>Nothing on the horizon yet. Add the things big enough to change how a month goes — ' +
      'key dates, client launches, shutdowns, planning and revenue milestones — and the preparation they need.</p>' +
      '<button type="button" class="cal-btn" id="hz-seed">Add the usual seasonal anchors</button>';
    board.parentNode.appendChild(note);
    note.querySelector('#hz-seed').addEventListener('click', seedAnchors);
  }

  function wireBoard(board) {
    board.querySelectorAll('.hz-add').forEach((b) => {
      b.addEventListener('click', () => openEditor(null, b.dataset.month));
    });
    board.querySelectorAll('.hz-card').forEach((card) => {
      const openWhereItLives = () => {
        // A key date is edited on the Years board, not here — one date, one
        // place to change it.
        if (card.dataset.fromYears && window.Years && typeof window.Years.openItem === 'function') {
          if (window.CalViews) window.CalViews.set('years');
          window.Years.openItem(card.dataset.id);
          return;
        }
        openEditor(card.dataset.id);
      };
      card.addEventListener('click', (e) => {
        if (e.target.closest('.hz-check-box')) return;      // ticking isn't opening
        openWhereItLives();
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWhereItLives(); }
      });
      card.querySelectorAll('.hz-check-box').forEach((box) => {
        box.addEventListener('click', (e) => {
          e.stopPropagation();
          const all = loadAll();
          const it = normalise(all[card.dataset.id], card.dataset.id);
          const i = Number(box.dataset.check);
          if (!it.checklist[i]) return;
          it.checklist[i].done = !it.checklist[i].done;
          putItem(it);
          render();
        });
      });
      card.addEventListener('dragstart', (e) => {
        card.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', card.dataset.id); } catch (_) {}
      });
      card.addEventListener('dragend', () => card.classList.remove('is-dragging'));
    });

    board.querySelectorAll('.hz-col').forEach((col) => {
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        col.classList.add('is-drop');
      });
      col.addEventListener('dragleave', () => col.classList.remove('is-drop'));
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('is-drop');
        const id = (() => { try { return e.dataTransfer.getData('text/plain'); } catch (_) { return ''; } })();
        const all = loadAll();
        if (!id || !all[id]) return;
        moveToMonth(normalise(all[id], id), col.dataset.month);
        render();
      });
    });
  }

  // Dropping a card in another column moves its month. A dated item keeps
  // its day of the month and shifts with it, so "Christmas 25 Dec" dragged
  // into January becomes 25 Jan rather than quietly keeping a date that no
  // longer matches the column it sits in.
  function moveToMonth(it, mk) {
    const target = parseMonth(mk);
    if (!target || it.month === mk) return;
    const from = parseMonth(it.month);
    it.month = mk;
    if (it.date && from) {
      const delta = (target.getFullYear() - from.getFullYear()) * 12 + (target.getMonth() - from.getMonth());
      const d = parseYmd(it.date);
      if (d) {
        const lastDay = new Date(d.getFullYear(), d.getMonth() + delta + 1, 0).getDate();
        it.date = ymd(new Date(d.getFullYear(), d.getMonth() + delta, Math.min(d.getDate(), lastDay)));
        if (it.prepWeeks) it.prepStart = weeksBefore(it.date, it.prepWeeks);
      }
    }
    putItem(it);
  }

  /* ── Editor ────────────────────────────────────────────────────────── */
  function buildEditor() {
    if (document.getElementById('hz-modal')) return;
    const m = document.createElement('div');
    m.id = 'hz-modal';
    m.className = 'cal-modal hz-modal';
    m.innerHTML =
      '<div class="cal-modal-card hz-modal-card">' +
        '<div class="cal-modal-head">' +
          '<h3 class="cal-modal-date" id="hz-modal-title">Horizon item</h3>' +
          '<button type="button" class="cal-modal-close" id="hz-close" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="hz-form">' +
          '<label class="hz-field"><span>Title</span>' +
            '<input type="text" id="hz-f-title" placeholder="Christmas, Black Friday, client launch…"></label>' +
          '<div class="hz-row">' +
            '<label class="hz-field"><span>Type</span>' +
              '<select id="hz-f-type">' + TYPES.map((t) => '<option value="' + t.id + '">' + t.label + '</option>').join('') + '</select></label>' +
            '<label class="hz-field"><span>Client / category</span>' +
              '<input type="text" id="hz-f-client" placeholder="Optional"></label>' +
          '</div>' +
          '<div class="hz-row">' +
            '<label class="hz-field"><span>Event date</span><input type="date" id="hz-f-date"></label>' +
            '<label class="hz-field"><span>Prep lead time</span>' +
              '<span class="hz-weeks"><input type="number" id="hz-f-weeks" min="0" max="52" step="1" placeholder="0"><em>weeks</em></span></label>' +
          '</div>' +
          '<div class="hz-row">' +
            '<label class="hz-field"><span>Month</span><input type="month" id="hz-f-month"></label>' +
            '<label class="hz-field"><span>Start preparing</span><input type="date" id="hz-f-prep"></label>' +
          '</div>' +
          '<p class="hz-prep-hint" id="hz-prep-hint"></p>' +
          '<div class="hz-row">' +
            '<label class="hz-field"><span>Supports which yearly goal</span>' +
              '<select id="hz-f-goal"></select></label>' +
            '<label class="hz-field"><span>Related projects</span>' +
              '<input type="text" id="hz-f-projects" placeholder="Comma separated"></label>' +
          '</div>' +
          '<div class="hz-field"><span>Checklist</span><div class="hz-checklist" id="hz-f-checklist"></div>' +
            '<button type="button" class="hz-link" id="hz-add-check">+ Add step</button></div>' +
          '<label class="hz-field"><span>Notes</span><textarea id="hz-f-notes" rows="3" placeholder="Optional"></textarea></label>' +
        '</div>' +
        '<div class="cal-modal-actions hz-actions">' +
          '<button type="button" class="cal-btn hz-danger" id="hz-delete">Delete</button>' +
          '<span class="hz-spacer"></span>' +
          '<button type="button" class="cal-btn" id="hz-cancel">Cancel</button>' +
          '<button type="button" class="cal-btn primary" id="hz-save">Save</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);

    m.addEventListener('click', (e) => { if (e.target === m) closeEditor(); });
    document.getElementById('hz-close').addEventListener('click', closeEditor);
    document.getElementById('hz-cancel').addEventListener('click', closeEditor);
    document.getElementById('hz-save').addEventListener('click', saveEditor);
    document.getElementById('hz-delete').addEventListener('click', () => {
      if (state.open) deleteItem(state.open);
      closeEditor();
      render();
    });
    document.getElementById('hz-add-check').addEventListener('click', () => addCheckRow(''));
    document.getElementById('hz-f-date').addEventListener('change', syncPrep);
    document.getElementById('hz-f-weeks').addEventListener('input', syncPrep);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && m.classList.contains('is-open')) closeEditor();
    });
  }

  // Date + lead time is the pair that matters: change either and the prep
  // start (and the month the card would file under) follows.
  function syncPrep() {
    const date = document.getElementById('hz-f-date').value;
    const weeks = Number(document.getElementById('hz-f-weeks').value);
    const hint = document.getElementById('hz-prep-hint');
    const prep = document.getElementById('hz-f-prep');
    if (date && weeks > 0) {
      prep.value = weeksBefore(date, weeks);
      hint.textContent = weeks + ' week' + (weeks === 1 ? '' : 's') + ' out means starting ' + niceDate(prep.value) + '.';
      hint.classList.add('is-on');
    } else {
      hint.textContent = '';
      hint.classList.remove('is-on');
    }
    const monthEl = document.getElementById('hz-f-month');
    if (date && !monthEl.dataset.touched) monthEl.value = date.slice(0, 7);
  }

  function addCheckRow(text, done) {
    const list = document.getElementById('hz-f-checklist');
    const row = document.createElement('div');
    row.className = 'hz-check-edit';
    row.innerHTML =
      '<input type="checkbox" class="hz-ce-done"' + (done ? ' checked' : '') + '>' +
      '<input type="text" class="hz-ce-text" placeholder="Step">' +
      '<button type="button" class="hz-ce-del" aria-label="Remove step">×</button>';
    row.querySelector('.hz-ce-text').value = text || '';
    row.querySelector('.hz-ce-del').addEventListener('click', () => row.remove());
    list.appendChild(row);
    return row;
  }

  // The Years goals this item could be serving. Years may not be loaded
  // (or may hold nothing yet), in which case the picker simply says so.
  function paintGoalPicker(selected) {
    const sel = document.getElementById('hz-f-goal');
    let goals = [];
    try {
      if (window.Years && typeof window.Years.items === 'function') {
        goals = window.Years.items().filter((i) => i.kind === 'goal');
      }
    } catch (_) { goals = []; }
    sel.innerHTML = '<option value="">' + (goals.length ? 'Not linked to a goal' : 'No yearly goals yet') + '</option>' +
      goals.sort((a, b) => a.year - b.year)
        .map((g) => '<option value="' + escAttr(g.id) + '">' + escAttr(g.title) + ' (' + g.year + ')</option>').join('');
    sel.value = selected || '';
  }
  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function openEditor(id, month) {
    const all = loadAll();
    const it = id && all[id] ? normalise(all[id], id)
      : normalise({ month: month || monthKey(state.anchor), type: 'event' });
    state.open = id && all[id] ? it.id : null;

    document.getElementById('hz-modal-title').textContent = state.open ? 'Edit item' : 'New Horizon item';
    document.getElementById('hz-f-title').value = it.title;
    document.getElementById('hz-f-type').value = it.type;
    document.getElementById('hz-f-client').value = it.client;
    document.getElementById('hz-f-date').value = it.date;
    document.getElementById('hz-f-weeks').value = it.prepWeeks || '';
    const monthEl = document.getElementById('hz-f-month');
    monthEl.value = it.month;
    monthEl.dataset.touched = state.open ? '1' : '';
    monthEl.onchange = () => { monthEl.dataset.touched = '1'; };
    document.getElementById('hz-f-prep').value = it.prepStart;
    document.getElementById('hz-f-notes').value = it.notes;
    document.getElementById('hz-f-projects').value = (it.linkedProjects || []).join(', ');
    paintGoalPicker(it.linkedGoal);
    const list = document.getElementById('hz-f-checklist');
    list.innerHTML = '';
    it.checklist.forEach((c) => addCheckRow(c.text, c.done));
    document.getElementById('hz-delete').style.visibility = state.open ? 'visible' : 'hidden';
    syncPrep();

    // Keep the draft's other fields (parent, source, created) across a save.
    document.getElementById('hz-modal').__draft = it;
    document.getElementById('hz-modal').classList.add('is-open');
    setTimeout(() => document.getElementById('hz-f-title').focus(), 30);
  }

  function closeEditor() {
    const m = document.getElementById('hz-modal');
    if (m) m.classList.remove('is-open');
    state.open = null;
  }

  function saveEditor() {
    const m = document.getElementById('hz-modal');
    const base = (m && m.__draft) || {};
    const title = document.getElementById('hz-f-title').value.trim();
    if (!title) { document.getElementById('hz-f-title').focus(); return; }

    const date = document.getElementById('hz-f-date').value;
    const weeks = Number(document.getElementById('hz-f-weeks').value);
    const monthEl = document.getElementById('hz-f-month');
    const item = Object.assign({}, base, {
      id: state.open || base.id,
      title,
      type: document.getElementById('hz-f-type').value,
      client: document.getElementById('hz-f-client').value.trim(),
      date,
      prepWeeks: weeks > 0 ? weeks : null,
      prepStart: document.getElementById('hz-f-prep').value,
      month: monthEl.value || (date ? date.slice(0, 7) : monthKey(state.anchor)),
      notes: document.getElementById('hz-f-notes').value,
      linkedGoal: document.getElementById('hz-f-goal').value,
      linkedProjects: document.getElementById('hz-f-projects').value
        .split(',').map((x) => x.trim()).filter(Boolean),
      checklist: [...document.querySelectorAll('#hz-f-checklist .hz-check-edit')]
        .map((r) => ({ text: r.querySelector('.hz-ce-text').value.trim(), done: r.querySelector('.hz-ce-done').checked }))
        .filter((c) => c.text),
    });
    const saved = putItem(item);

    // A dated event with a lead time earns its preparation card, once: this
    // is the same shape Agent Board will write when it generates a whole
    // run of prep milestones from one date.
    if (saved.type !== 'prep' && saved.date && saved.prepWeeks && saved.prepStart && !hasPrepFor(saved.id)) {
      putItem({
        id: newId(),
        title: 'Start ' + saved.title + ' planning',
        type: 'prep',
        month: saved.prepStart.slice(0, 7),
        prepStart: saved.prepStart,
        client: saved.client,
        parentId: saved.id,
        checklist: [],
      });
    }
    closeEditor();
    render();
  }
  function hasPrepFor(id) {
    const all = loadAll();
    return Object.keys(all).some((k) => all[k] && all[k].parentId === id && all[k].type === 'prep');
  }

  /* ── Seasonal anchors ──────────────────────────────────────────────
     The retail calendar that shapes every year here. Seeded only into the
     months on screen, and only when the board is empty. */
  function seedAnchors() {
    const first = state.anchor;
    const last = addMonths(first, SPAN);
    const years = [first.getFullYear(), last.getFullYear()];
    const made = [];
    years.forEach((y) => {
      // Black Friday: the Friday after the fourth Thursday of November.
      const nov = new Date(y, 10, 1);
      const firstThu = 1 + ((4 - nov.getDay() + 7) % 7);
      const bf = new Date(y, 10, firstThu + 21 + 1);
      const cm = new Date(y, 10, firstThu + 21 + 4);
      [
        // Only the anchors that need their own run-up get a prep card:
        // Cyber Monday rides on Black Friday's, Boxing Day on Christmas's.
        { title: 'Black Friday', date: ymd(bf), type: 'event', prepWeeks: 6, prep: true,
          checklist: ['Confirm offers', 'Creative ready', 'Landing pages ready'] },
        { title: 'Cyber Monday', date: ymd(cm), type: 'event',
          checklist: ['Tailor offers', 'Schedule emails', 'Check tracking'] },
        { title: 'Christmas', date: y + '-12-25', type: 'event', prepWeeks: 8, prep: true,
          checklist: ['Offers confirmed', 'Emails scheduled', 'Landing pages live'] },
        { title: 'Boxing Day', date: y + '-12-26', type: 'event',
          checklist: ['Update offers', 'Monitor performance'] },
        { title: 'Client shutdowns', date: y + '-12-20', type: 'business',
          checklist: ['Confirm client dates', 'Set up out of office', 'Share timelines with team'] },
        { title: 'EOFY', date: y + '-06-30', type: 'event', prepWeeks: 6, prep: true,
          checklist: ['Confirm offers', 'Creative ready', 'Reporting ready'] },
      ].forEach((seed) => {
        const d = parseYmd(seed.date);
        if (!d || d < first || d >= last) return;
        made.push({ wantsPrep: !!seed.prep, item: putItem({
          id: newId(),
          title: seed.title,
          type: seed.type,
          date: seed.date,
          month: seed.date.slice(0, 7),
          prepWeeks: seed.prepWeeks || null,
          checklist: seed.checklist.map((t) => ({ text: t, done: false })),
        }) });
      });
    });
    // Give each seeded event its "start preparing" card, in the month it falls.
    made.forEach(({ wantsPrep, item: ev }) => {
      if (!wantsPrep || !ev.prepStart || hasPrepFor(ev.id)) return;
      putItem({
        id: newId(),
        title: 'Start ' + ev.title + ' planning',
        type: 'prep',
        month: ev.prepStart.slice(0, 7),
        prepStart: ev.prepStart,
        parentId: ev.id,
        checklist: [{ text: 'Set offers', done: false }, { text: 'Plan campaigns', done: false },
                    { text: 'Decide creative requirements', done: false }],
      });
    });
    render();
  }

  /* ── Boot ──────────────────────────────────────────────────────────
     calendar.js builds its shell asynchronously (and waits for the
     dashboard when there is one), so poll briefly for it. */
  function boot(attempt) {
    if (window.CalViews && window.CalViews.ready() && mount()) return;
    if (attempt > 60) return;
    setTimeout(() => boot((attempt || 0) + 1), 50);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot(0));
  else boot(0);

  // Exposed for tests, and as the seam Agent Board's writer will use.
  window.Horizon = {
    load: loadAll, save: putItem, remove: deleteItem, normalise,
    render, setView, setAnchor, itemsByMonth, TYPES, KEY,
  };
})();
