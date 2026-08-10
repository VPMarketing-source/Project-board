/* =========================================================================
   Project Clarity — planner calendar

   Extracted from clients/vpm.html so more than one space can have one.
   Everything it stores is scoped by window.CLIENT_DATA.id, so two spaces
   never share or overwrite each other's days.

   Load AFTER CLIENT_DATA and sync.js:
     <script>window.CLIENT_DATA = { id: '...' };</script>
     <script src="../shared/sync.js"></script>
     <script src="../shared/calendar.js"></script>

   Mounts into #panel-home when the shared dashboard is present, otherwise
   into any element carrying [data-calendar-root].
   ========================================================================= */
(function bootPlannerCalendar() {
  /* Where the calendar lives. With the shared dashboard it goes in the Home
     tab; standalone it goes in whatever element opts in with
     [data-calendar-root]. The dashboard-only extras — the pinned "This week"
     strip and the Key dates box — are skipped when standalone, since they
     are part of that layout rather than of the calendar. */
  function calendarHost() {
    return document.getElementById('panel-home') ||
           document.querySelector('[data-calendar-root]');
  }
  function hasDashboard() {
    return !!document.getElementById('panel-home');
  }

  const C = window.CLIENT_DATA;
  if (!C || !C.id) {
    console.warn('[calendar] window.CLIENT_DATA.id missing — calendar disabled.');
    return;
  }
  const CID = C.id;

  /* =====================================================================
     Calendar bootstrap — runs after dashboard.js has rendered the Home
     panel, then appends the month calendar below the Notes box. All
     events persist under pc-ops::<client-id>::calendar::v1.
     ===================================================================== */
  (function bootCalendar() {
    const STORE_KEY = 'pc-ops::' + CID + '::calendar::v1';
    const KD_TITLE_KEY = 'pc-ops::' + CID + '::keydates::title::v1';
    const KD_BODY_KEY  = 'pc-ops::' + CID + '::keydates::body::v1';

    /* Safety net: walk every editable area on the page and flush its
       current content to localStorage before the page goes away.

       Every editable here already saves on its own `input` event, so this
       is pure redundancy — which means it must never be able to *destroy*
       anything. Three rules keep it honest:

         1. Bail whenever the DOM is known to be stale (a reload is in
            flight, or sync has landed a remote change we haven't
            repainted yet). Serialising a stale DOM here is exactly how
            an edit made on another device used to get wiped.
         2. Never delete a key because an element reads empty. An element
            can be empty simply because it rendered before its data
            arrived. Clearing a field for real is handled by the `input`
            handlers, which know the emptiness was deliberate.
         3. Skip the pinned clone. It shares `data-key` values with the
            source week, so whichever came last in document order used to
            win — and the clone goes stale the moment you type in the
            calendar accordion. Its own input handler already mirrors
            back to the source. */
    function flushAllEditables() {
      if (window.__plannerReloadingForSync) return;
      if (window.__planner && window.__planner.unpaintedRemote) return;
      try {
        // Day-column freeform text (source week only — not the clone)
        const freeCur = JSON.parse(localStorage.getItem(STORE_KEY + '::freeform') || '{}');
        document.querySelectorAll('.cwg-col-free[data-key]').forEach((el) => {
          if (el.closest('.is-pinned-clone')) return;
          const html = el.innerHTML;
          const stripped = html.replace(/<br\s*\/?>/gi, '').trim();
          if (!stripped) return;
          freeCur[el.dataset.key] = html;
        });
        localStorage.setItem(STORE_KEY + '::freeform', JSON.stringify(freeCur));

        // Inline week notes
        const inlineCur = JSON.parse(localStorage.getItem(STORE_KEY + '::weekInline') || '{}');
        document.querySelectorAll('.cal-week-inline-note[data-week-key]').forEach((el) => {
          if (el.closest('.is-pinned-clone')) return;
          const text = el.textContent.trim();
          if (!text) return;
          inlineCur[el.dataset.weekKey] = text;
        });
        localStorage.setItem(STORE_KEY + '::weekInline', JSON.stringify(inlineCur));

        // Key dates body / title
        const kdBody = document.querySelector('.key-dates-body');
        if (kdBody && kdBody.innerHTML.trim()) localStorage.setItem(KD_BODY_KEY, kdBody.innerHTML);
        const kdTitle = document.querySelector('.key-dates-title');
        if (kdTitle && kdTitle.textContent.trim()) localStorage.setItem(KD_TITLE_KEY, kdTitle.textContent.trim());
      } catch (e) { /* ignore — best-effort flush */ }
    }
    window.addEventListener('beforeunload', flushAllEditables);
    window.addEventListener('pagehide', flushAllEditables);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushAllEditables();
    });

    /* ── Write safety for every editable in the calendar ────────────────
       Each of these handlers used to do `if (!stripped) delete cur[key]`,
       so a cell that merely *rendered* empty — because the page painted
       before sync landed, or a re-render raced an edit — deleted that day
       on the next stray input event and pushed the deletion everywhere.
       That is how a planned week vanishes.

       Two rules, matching the Notes box:
         - nothing persists until sync has the server copy (canPersist)
         - erasure requires focus in the field; a real edit always has it,
           a stale render or a synthetic event never does.
       Adding or changing content is untouched. Fails open without sync.js. */
    function isVisuallyEmpty(html) {
      const s = String(html == null ? '' : html);
      if (/<(input|img)\b/i.test(s)) return false;   // checkboxes are content
      return !s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').replace(/[\s​ ]/g, '').length;
    }
    function safeToPersist(el, nextHtml) {
      const P = window.__planner;
      if (P && typeof P.canPersist === 'function' && !P.canPersist()) return false;
      if (isVisuallyEmpty(nextHtml) && document.activeElement !== el) return false;
      return true;
    }

    /* ── Undo history for day cells ─────────────────────────────────────
       Keeps the last few versions of each day so an edit can be stepped
       back. Stored under a key that does NOT begin with pc-ops:: so it is
       never synced — undo is per-device scratch, and syncing a version
       stack for 58 days would bloat every payload.

       Granularity is the editing *burst*, not the keystroke: typing a
       sentence is one undo step, because a per-keystroke stack would take
       forty clicks to undo a line. A burst ends after BURST_MS idle. */
    const UNDO_KEY  = 'plannerUndo::' + CID + '::freeform::v1';
    const BURST_MS  = 1500;
    const MAX_STEPS = 12;
    const lastEditAt = Object.create(null);

    function loadUndo() {
      try { return JSON.parse(localStorage.getItem(UNDO_KEY) || '{}') || {}; }
      catch (_) { return {}; }
    }
    function saveUndo(all) {
      try { localStorage.setItem(UNDO_KEY, JSON.stringify(all)); } catch (_) {}
    }

    /* Call with the value as it was BEFORE this edit. Only records when a
       new burst starts, so one stack entry per continuous piece of typing. */
    function noteEditBurst(key, prevValue) {
      const now = Date.now();
      const fresh = !lastEditAt[key] || (now - lastEditAt[key]) > BURST_MS;
      lastEditAt[key] = now;
      if (!fresh) return;
      const all = loadUndo();
      const stack = all[key] || [];
      if (stack.length && stack[stack.length - 1] === (prevValue || '')) return;
      stack.push(prevValue || '');
      all[key] = stack.slice(-MAX_STEPS);
      saveUndo(all);
      refreshRevert(key);
    }

    function undoDepth(key) {
      const stack = loadUndo()[key];
      return stack ? stack.length : 0;
    }

    /* Steps one version back: restores it into the cell, into storage, and
       into any other copy of that day on screen. */
    function revertDay(key) {
      const all = loadUndo();
      const stack = all[key] || [];
      if (!stack.length) return;
      const restored = stack.pop();
      all[key] = stack;
      saveUndo(all);

      const cur = JSON.parse(localStorage.getItem(STORE_KEY + '::freeform') || '{}');
      if (restored) cur[key] = restored; else delete cur[key];
      localStorage.setItem(STORE_KEY + '::freeform', JSON.stringify(cur));

      document.querySelectorAll('.cwg-col-free[data-key="' + key + '"]').forEach((el) => {
        el.innerHTML = restored || '';
        flashSaved(el);
      });
      // Reverting is an edit in its own right; don't let it merge into the
      // burst that follows, or the next keystroke would swallow this step.
      delete lastEditAt[key];
      refreshRevert(key);
    }

    function refreshRevert(key) {
      const depth = undoDepth(key);
      document.querySelectorAll('.cell-revert[data-key="' + key + '"]').forEach((b) => {
        b.hidden = depth === 0;
        b.title = 'Undo last change to this day (' + depth + ' available)';
      });
    }

    /* The button lives on the column, never inside the contenteditable —
       anything inside it would become part of the day's saved content. */
    function attachRevert(freeEl, key) {
      const col = freeEl.parentNode;
      if (!col) return;
      col.querySelectorAll(':scope > .cell-revert').forEach((n) => n.remove());
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell-revert';
      b.dataset.key = key;
      b.setAttribute('aria-label', 'Undo last change to this day');
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.3-9.3L3 7"/></svg>';
      b.hidden = undoDepth(key) === 0;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        revertDay(key);
      });
      if (getComputedStyle(col).position === 'static') col.style.position = 'relative';
      col.appendChild(b);
      refreshRevert(key);
    }

    /* ── Focus blur for day cells ───────────────────────────────────────
       Softens a day so its colour blocks still read at a glance but the
       text is deliberately hard to make out — a way to quiet the days you
       are not working on so the week is less overwhelming. Stored under
       pc-ops:: so the choice syncs across devices. The blur lifts on
       hover / focus, so a blurred day stays fully readable and editable
       the moment you deliberately look at it. */
    const BLUR_KEY = STORE_KEY + '::blurred::v1';
    function loadBlur() {
      try { return JSON.parse(localStorage.getItem(BLUR_KEY) || '{}') || {}; }
      catch (_) { return {}; }
    }
    function isBlurred(key) { return !!loadBlur()[key]; }
    function setBlurred(key, on) {
      const all = loadBlur();
      if (on) all[key] = 1; else delete all[key];
      try { localStorage.setItem(BLUR_KEY, JSON.stringify(all)); } catch (_) {}
      // Reflect the choice on every copy of this day currently on screen:
      // its own month, the adjacent month's leading/trailing copy, and the
      // pinned "This week" clone.
      document.querySelectorAll('.cwg-col[data-key="' + key + '"]').forEach((col) => {
        col.classList.toggle('is-blurred', !!on);
      });
      document.querySelectorAll('.cell-blur[data-key="' + key + '"]').forEach((b) => {
        b.classList.toggle('is-on', !!on);
        b.setAttribute('aria-pressed', String(!!on));
      });
    }

    const BLUR_EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';

    /* The toggle lives on the column, never inside the contenteditable —
       anything inside it would become part of the day's saved content.
       Mirrors attachRevert; parked top-left so it never collides with the
       revert button top-right. */
    function attachBlurToggle(col, key) {
      if (!col) return;
      col.querySelectorAll(':scope > .cell-blur').forEach((n) => n.remove());
      const on = isBlurred(key);
      col.classList.toggle('is-blurred', on);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell-blur' + (on ? ' is-on' : '');
      b.dataset.key = key;
      b.setAttribute('aria-label', 'Blur this day to reduce focus');
      b.setAttribute('aria-pressed', String(on));
      b.title = 'Blur this day — soften it so the week is less overwhelming';
      b.innerHTML = BLUR_EYE_SVG;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setBlurred(key, !isBlurred(key));
      });
      if (getComputedStyle(col).position === 'static') col.style.position = 'relative';
      col.appendChild(b);
    }

    /* ── Hide a day column ──────────────────────────────────────────────
       Collapse a day you don't need to a thin strip so the week narrows
       around the days you do use. Per-day and stored under pc-ops:: so the
       choice syncs, mirrors to every copy of the day on screen, and is
       undone by clicking the strip (or the toggle again). */
    const HIDECOL_KEY = STORE_KEY + '::hiddencols::v1';
    function loadHiddenCols() {
      try { return JSON.parse(localStorage.getItem(HIDECOL_KEY) || '{}') || {}; }
      catch (_) { return {}; }
    }
    function isColHidden(key) { return !!loadHiddenCols()[key]; }

    /* Set a week grid's column widths from which of its day columns are
       hidden: a hidden column gets a thin fixed track, the rest share the
       space. Pure CSS can't express this — the grid template lives on the
       row, not the cell — so we compute it per row after every render. */
    function applyColLayout(grid) {
      const cols = grid.querySelectorAll(':scope > .cwg-col');
      if (!cols.length) return;
      grid.style.gridTemplateColumns = Array.from(cols).map((c) =>
        c.classList.contains('is-col-hidden') ? '34px' : 'minmax(0, 1fr)'
      ).join(' ');
    }
    function applyAllColLayouts() {
      document.querySelectorAll('.cal-grid, #cal-week-grid').forEach(applyColLayout);
    }

    function setColHidden(key, on) {
      const all = loadHiddenCols();
      if (on) all[key] = 1; else delete all[key];
      try { localStorage.setItem(HIDECOL_KEY, JSON.stringify(all)); } catch (_) {}
      document.querySelectorAll('.cwg-col[data-key="' + key + '"]').forEach((col) => {
        col.classList.toggle('is-col-hidden', !!on);
      });
      document.querySelectorAll('.cell-hide[data-key="' + key + '"]').forEach((b) => {
        b.classList.toggle('is-on', !!on);
        b.setAttribute('aria-pressed', String(!!on));
        b.title = on ? 'Show this day again' : 'Hide this day column';
      });
      applyAllColLayouts();
    }

    const HIDE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>';

    /* Hide toggle — parked next to the blur eye. Hidden until you hover a
       day, but always shown once the column is collapsed so the strip
       carries its own reopen control. */
    function attachHideToggle(col, key) {
      if (!col) return;
      col.querySelectorAll(':scope > .cell-hide').forEach((n) => n.remove());
      const on = isColHidden(key);
      col.classList.toggle('is-col-hidden', on);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell-hide' + (on ? ' is-on' : '');
      b.dataset.key = key;
      b.setAttribute('aria-label', 'Hide this day column');
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Show this day again' : 'Hide this day column';
      b.innerHTML = HIDE_SVG;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setColHidden(key, !isColHidden(key));
      });
      if (getComputedStyle(col).position === 'static') col.style.position = 'relative';
      col.appendChild(b);
      // Clicking anywhere on a collapsed strip (but not the toggle) reopens it.
      col.addEventListener('click', (e) => {
        if (!col.classList.contains('is-col-hidden')) return;
        if (e.target.closest('.cell-hide')) return;
        setColHidden(key, false);
      });
    }

    /* Brief "Saved" tick on the cell being edited, so persistence is
       visible rather than something you have to take on trust. */
    function flashSaved(el) {
      if (!el) return;
      clearTimeout(el.__savedTimer);
      el.classList.add('is-saved');
      el.__savedTimer = setTimeout(() => el.classList.remove('is-saved'), 900);
    }

    /* The pinned current-week clone shares data-key values with the source
       week in the calendar accordion. Clone→source was already mirrored;
       without the reverse the clone goes stale the moment you type in the
       accordion, and a later re-clone resurrects the old text over the new. */
    function mirrorToPinned(sel, value, prop) {
      const el = document.querySelector('#current-week-pinned ' + sel);
      if (el && el !== document.activeElement && el[prop] !== value) el[prop] = value;
    }

    /* A single date can be on screen several times over: in its own month,
       again as a leading/trailing day of the adjacent month (27 Jul is both
       July week 5 and August week 1), and again in the pinned current week.
       Every one of those is a live editable bound to the same data-key.

       Only the pinned copy used to be kept in step, so the others sat blank
       or stale until a reload — visibly wrong, and worse than that: a blank
       twin of a day that actually has content is one stray input away from
       erasing it. Push each edit to every copy of that day. */
    function mirrorDay(key, html, sourceEl) {
      document.querySelectorAll('.cwg-col-free[data-key="' + key + '"]').forEach((el) => {
        if (el === sourceEl || el === document.activeElement) return;
        if (el.innerHTML !== html) el.innerHTML = html;
      });
    }

    function mountKeyDates() {
      const homePanel = document.getElementById('panel-home');
      // Key dates belongs to the dashboard layout; skip it when the
      // calendar is mounted standalone.
      if (!homePanel) return;
      if (document.getElementById('key-dates')) return;
      const aside = document.createElement('aside');
      aside.id = 'key-dates';
      aside.className = 'key-dates';
      aside.setAttribute('data-screen-label', 'Key dates');
      const titleText = localStorage.getItem(KD_TITLE_KEY) || '';
      aside.innerHTML = '<h2 class="key-dates-title" contenteditable="true">' + titleText + '</h2><div class="key-dates-body" contenteditable="true"></div>';
      const body  = aside.querySelector('.key-dates-body');
      const title = aside.querySelector('.key-dates-title');
      body.innerHTML = localStorage.getItem(KD_BODY_KEY) || '';
      title.addEventListener('input', () => {
        if (!safeToPersist(title, title.textContent)) return;
        localStorage.setItem(KD_TITLE_KEY, title.textContent.trim());
        flashSaved(title);
      });
      body.addEventListener('input', () => {
        if (!safeToPersist(body, body.innerHTML)) return;
        localStorage.setItem(KD_BODY_KEY, body.innerHTML);
        flashSaved(body);
      });
      homePanel.appendChild(aside);
    }
    mountKeyDates();
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    // Week starts Monday — 0=Mon … 6=Sun
    const DOW = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    // Convert JS getDay() (0=Sun..6=Sat) into our Monday-first index (0=Mon..6=Sun)
    const dowMon = (d) => (d.getDay() + 6) % 7;

    function loadEvents() {
      try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
      catch (e) { return {}; }
    }
    function saveEvents(data) {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    }
    function ymd(d) {
      return d.getFullYear() + '-' +
             String(d.getMonth() + 1).padStart(2, '0') + '-' +
             String(d.getDate()).padStart(2, '0');
    }
    function fmtLong(key) {
      const [y, m, d] = key.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      return DOW[dowMon(dt)] + ', ' + MONTH_NAMES[m - 1] + ' ' + d + ', ' + y;
    }

    const state = {
      view: new Date(),
      events: loadEvents(),
      openDay: null,
      mode: localStorage.getItem(STORE_KEY + '::mode') || 'month',
      collapsed: localStorage.getItem(STORE_KEY + '::collapsed') === '1',
    };
    // For month mode we snap view to the 1st; for week mode we keep the
    // exact date and resolve the Monday of that week at render time.
    if (state.mode === 'month') state.view.setDate(1);

    function setMode(m) {
      state.mode = m;
      localStorage.setItem(STORE_KEY + '::mode', m);
      // Re-anchor view sensibly when switching
      if (m === 'month') state.view.setDate(1);
      buildShell(true);
      attachHandlers();
      render();
    }
    function mondayOf(d) {
      const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      x.setDate(x.getDate() - dowMon(x));
      return x;
    }

    // Ensures the "Calendar" tab + #panel-calendar exist. Returns the panel.
    function ensureCalendarTab() {
      let panel = document.getElementById('panel-calendar');
      if (panel) return panel;
      const tabs = document.getElementById('tabs');
      const page = document.querySelector('main.page');
      if (!tabs || !page) return calendarHost();
      panel = document.createElement('section');
      panel.className = 'panel';
      panel.id = 'panel-calendar';
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('data-screen-label', 'Calendar');
      page.appendChild(panel);
      if (!tabs.querySelector('[data-tab="calendar"]')) {
        const btn = document.createElement('button');
        btn.className = 'tab';
        btn.type = 'button';
        btn.dataset.tab = 'calendar';
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', 'false');
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="16" y1="2" x2="16" y2="6"></line></svg> Calendar';
        const homeBtn = tabs.querySelector('[data-tab="home"]');
        const addBtn  = tabs.querySelector('.tab-add');
        if (homeBtn && homeBtn.nextSibling) tabs.insertBefore(btn, homeBtn.nextSibling);
        else if (addBtn) tabs.insertBefore(btn, addBtn);
        else tabs.appendChild(btn);
      }
      return panel;
    }

    function buildShell(force) {
      const homePanel = calendarHost();
      if (!homePanel) return null;
      let cal = document.getElementById('planner-cal');
      if (cal && force) cal.remove();
      cal = document.getElementById('planner-cal');

      // "Current week" pinned section above the Calendar accordion.
      let pinned = hasDashboard() ? document.getElementById('current-week-pinned') : null;
      if (!pinned && hasDashboard()) {
        pinned = document.createElement('section');
        pinned.id = 'current-week-pinned';
        pinned.className = 'current-week-pinned';
        pinned.setAttribute('data-screen-label', 'This week');
        pinned.innerHTML = `
          <header class="cwp-head">
            <span class="cwp-kicker">This week</span>
          </header>
          <div class="cwp-body"></div>
        `;
      }
      // Force-position above the Calendar accordion, regardless of when it
      // was originally appended. If planner-cal already exists, slot the
      // pinned section in immediately before it; else put it after the
      // Notes box (or at the very top if Notes hasn't rendered yet).
      // Always pin to the very top of the home panel — above the Notes
      // box and above the Calendar accordion.
      if (pinned && homePanel.firstChild !== pinned) {
        homePanel.insertBefore(pinned, homePanel.firstChild);
      }

      if (cal) return cal;

      cal = document.createElement('section');
      cal.id = 'planner-cal';
      cal.className = 'planner-cal mode-' + state.mode;
      cal.setAttribute('data-screen-label', state.mode === 'week' ? 'Week planner' : 'Month calendar');
      cal.innerHTML = `
        <div class="cal-head">
          <button type="button" class="cal-wrap-head" id="cal-wrap-head" aria-expanded="true">
            <span class="cal-wrap-chev" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
            </span>
            <h2 class="cal-wrap-title">Calendar</h2>
          </button>
          <div class="cal-nav">
            <button type="button" id="cal-prev" title="Previous month">‹</button>
            <button type="button" class="cal-today" id="cal-today">Today</button>
            <button type="button" id="cal-next" title="Next month">›</button>
          </div>
        </div>
        <div class="cal-months" id="cal-months"></div>
      `;
      // Mount the calendar into its own tab panel (#panel-calendar), which
      // we lazy-create with a sibling Calendar tab if it doesn't exist yet.
      const calPanel = ensureCalendarTab();
      calPanel.appendChild(cal);
      if (state.collapsed) cal.classList.add('is-collapsed');

      // Modal (appended to body so it overlays everything)
      let modal = document.getElementById('cal-modal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'cal-modal';
        modal.className = 'cal-modal';
        modal.innerHTML = `
          <div class="cal-modal-card">
            <div class="cal-modal-head">
              <h3 class="cal-modal-date" id="cal-modal-date">—</h3>
              <button type="button" class="cal-modal-close" id="cal-modal-close" aria-label="Close">×</button>
            </div>
            <div class="cal-event-list" id="cal-event-list"></div>
            <div class="cal-modal-actions">
              <button type="button" class="cal-btn" id="cal-add">+ Add event</button>
              <button type="button" class="cal-btn primary" id="cal-save">Done</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
      }
      return cal;
    }

    function render() {
      renderMonth();
      renderCurrentWeekPinned();
      applyAllColLayouts();
      // The pinned "This week" clone is built one frame later; re-apply then.
      requestAnimationFrame(applyAllColLayouts);
    }

    // Render a copy of the current week's row (Mon–Sun grid + inline note +
    // 7 day columns) inside #current-week-pinned, kept in sync with whatever
    // the source week shows in the Calendar accordion.
    function renderCurrentWeekPinned() {
      const pinned = document.getElementById('current-week-pinned');
      if (!pinned) return;
      const body = pinned.querySelector('.cwp-body');
      body.innerHTML = '';
      // The Calendar accordion may not have rendered yet; defer one frame.
      requestAnimationFrame(() => {
        const src = document.querySelector('.cal-week.has-today');
        if (!src) return;
        const clone = src.cloneNode(true);
        clone.classList.add('is-open', 'is-pinned-clone');
        // Strip ids inside the clone so they don't collide.
        clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
        body.appendChild(clone);

        // cloneNode() doesn't copy event listeners, so the editable day
        // columns + inline week note in the clone would accept typing but
        // never persist — which is how content "randomly goes missing"
        // on the next re-render. Re-wire input handlers + reseed content
        // from localStorage so the pinned section is fully live.
        const FREE = JSON.parse(localStorage.getItem(STORE_KEY + '::freeform') || '{}');
        clone.querySelectorAll('.cwg-col-free[data-key]').forEach((free) => {
          const key = free.dataset.key;
          // Reseed in case the source DOM was stale.
          free.innerHTML = FREE[key] || '';
          attachRevert(free, key);
          attachBlurToggle(free.parentNode, key);
          attachHideToggle(free.parentNode, key);
          free.addEventListener('input', () => {
            const html = free.innerHTML;
            if (!safeToPersist(free, html)) return;
            const cur = JSON.parse(localStorage.getItem(STORE_KEY + '::freeform') || '{}');
            noteEditBurst(key, cur[key]);
            const stripped = html.replace(/<br\s*\/?>/gi, '').trim();
            if (!stripped) delete cur[key]; else cur[key] = html;
            localStorage.setItem(STORE_KEY + '::freeform', JSON.stringify(cur));
            mirrorDay(key, html, free);
            flashSaved(free);
          });
        });
        const inlineAll = JSON.parse(localStorage.getItem(STORE_KEY + '::weekInline') || '{}');
        clone.querySelectorAll('.cal-week-inline-note[data-week-key]').forEach((note) => {
          const wkKey = note.dataset.weekKey;
          note.textContent = inlineAll[wkKey] || '';
          note.addEventListener('click', (e) => e.stopPropagation());
          note.addEventListener('input', () => {
            const text = note.textContent.trim();
            if (!safeToPersist(note, note.textContent)) return;
            const cur = JSON.parse(localStorage.getItem(STORE_KEY + '::weekInline') || '{}');
            if (!text) delete cur[wkKey]; else cur[wkKey] = text;
            localStorage.setItem(STORE_KEY + '::weekInline', JSON.stringify(cur));
            flashSaved(note);
            const srcNote = src.querySelector('.cal-week-inline-note[data-week-key="' + wkKey + '"]');
            if (srcNote && srcNote !== note) srcNote.textContent = note.textContent;
          });
        });
        applyAllColLayouts();
      });
    }

    function renderWeek() {
      const monthEl = document.getElementById('cal-month');
      const yearEl  = document.getElementById('cal-year');
      const grid    = document.getElementById('cal-week-grid');
      if (!grid) return;
      const anchor = mondayOf(state.view);
      const days = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + i);
        days.push(d);
      }
      const first = days[0], last = days[6];
      if (first.getMonth() === last.getMonth()) {
        monthEl.textContent = MONTH_NAMES[first.getMonth()];
      } else {
        monthEl.textContent = MONTH_NAMES[first.getMonth()].slice(0,3) + ' – ' + MONTH_NAMES[last.getMonth()].slice(0,3);
      }
      yearEl.textContent = first.getFullYear();

      const todayKey = ymd(new Date());
      grid.innerHTML = '';
      grid.style.gridTemplateColumns = 'repeat(7, 1fr)';

      // 7 day columns: header + open event-stack body. No hour rows.
      const FREE = JSON.parse(localStorage.getItem(STORE_KEY + '::freeform') || '{}');
      days.forEach((d) => {
        const key = ymd(d);
        const isToday = key === todayKey;
        const col = document.createElement('div');
        col.className = 'cwg-col' + (isToday ? ' is-today' : '');
        col.dataset.key = key;
        col.innerHTML = `
          <div class="cwg-col-head">
            <span class="cwg-dow">${DOW[dowMon(d)]}</span>
            <span class="cwg-num">${d.getDate()}</span>
          </div>
          <div class="cwg-col-chips"></div>
          <div class="cwg-col-free" contenteditable="true" data-key="${key}" data-placeholder="Type notes for the day…"></div>
        `;
        const chips = col.querySelector('.cwg-col-chips');
        const free  = col.querySelector('.cwg-col-free');
        free.innerHTML = FREE[key] || '';
        attachRevert(free, key);
        attachBlurToggle(col, key);
        attachHideToggle(col, key);
        free.addEventListener('input', () => {
          const html = free.innerHTML;
          if (!safeToPersist(free, html)) return;
          const cur = JSON.parse(localStorage.getItem(STORE_KEY + '::freeform') || '{}');
          noteEditBurst(key, cur[key]);
          // Strip empty <br>-only content so placeholder shows again.
          const stripped = html.replace(/<br\s*\/?>/gi, '').trim();
          if (!stripped) delete cur[key]; else cur[key] = html;
          localStorage.setItem(STORE_KEY + '::freeform', JSON.stringify(cur));
          mirrorDay(key, html, free);
          flashSaved(free);
        });
        const events = (state.events[key] || []).slice().sort((a, b) => {
          const at = a.start || 'zz';
          const bt = b.start || 'zz';
          return at.localeCompare(bt);
        });
        events.forEach((ev) => {
          const chip = document.createElement('div');
          chip.className = 'cwg-chip is-' + (ev.kind || 'task');
          const time = ev.start ? `<span class="cwg-chip-time">${formatTime(ev.start)}</span> ` : '';
          chip.innerHTML = time + escapeHtml(ev.text || 'Untitled');
          chip.addEventListener('click', (e) => { e.stopPropagation(); openDay(key); });
          chips.appendChild(chip);
        });
        // Double-click anywhere in the column header to add a structured event
        col.querySelector('.cwg-col-head').addEventListener('dblclick', () => {
          if (!state.events[key]) state.events[key] = [];
          state.events[key].push({ kind: 'task', text: '' });
          saveEvents(state.events);
          openDay(key);
        });
        grid.appendChild(col);
      });
      applyAllColLayouts();
    }
    function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function formatHour(h) {
      const ap = h < 12 ? 'am' : 'pm';
      const hh = ((h + 11) % 12) + 1;
      return hh + ' ' + ap;
    }
    function formatTime(t) {
      if (!t) return '';
      const [h, m] = t.split(':').map(Number);
      const ap = h < 12 ? 'am' : 'pm';
      const hh = ((h + 11) % 12) + 1;
      return hh + (m ? ':' + String(m).padStart(2, '0') : '') + ap;
    }

    function renderMonth() {
      const monthsEl = document.getElementById('cal-months');
      if (!monthsEl) return;
      const view = state.view;

      monthsEl.innerHTML = '';
      const year = view.getFullYear();
      const today = new Date();
      const isCurrentYear = year === today.getFullYear();
      const todayMonth = today.getMonth();
      const monthsOpen = JSON.parse(localStorage.getItem(STORE_KEY + '::monthsOpen') || '{}');
      for (let i = 0; i < 12; i++) {
        const m = new Date(year, i, 1);
        const monthKey = year + '-' + (i + 1);
        // Default: only the current month is open; everything else collapsed.
        const defaultOpen = isCurrentYear && i === todayMonth;
        const isOpen = (monthKey in monthsOpen) ? !!monthsOpen[monthKey] : defaultOpen;

        const isCurrent = isCurrentYear && i === todayMonth;
        const section = document.createElement('section');
        section.className = 'cal-month' + (isOpen ? ' is-open' : '') + (isCurrent ? ' is-current' : '');
        section.dataset.monthKey = monthKey;
        section.innerHTML = `
          <button type="button" class="cal-month-head" aria-expanded="${isOpen}">
            <span class="cal-month-chev" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
            </span>
            <span class="cal-month-name">${MONTH_NAMES[m.getMonth()]}</span>
            <span class="cal-month-year">${m.getFullYear()}</span>
          </button>
          <div class="cal-month-body">
            <div class="cal-weeks"></div>
          </div>
        `;
        const weeksEl = section.querySelector('.cal-weeks');
        renderMonthWeeks(m, weeksEl);

        section.querySelector('.cal-month-head').addEventListener('click', () => {
          const nowOpen = !section.classList.contains('is-open');
          section.classList.toggle('is-open', nowOpen);
          section.querySelector('.cal-month-head').setAttribute('aria-expanded', String(nowOpen));
          const cur = JSON.parse(localStorage.getItem(STORE_KEY + '::monthsOpen') || '{}');
          cur[monthKey] = nowOpen;
          localStorage.setItem(STORE_KEY + '::monthsOpen', JSON.stringify(cur));
        });

        monthsEl.appendChild(section);
      }
    }

    /* =====================================================================
       Shared day sections
       Each week is divided into horizontal bands (Early Morning, Work Block
       1, …) that line up across all 7 days. A week's section list —
       {id, name, height} — is stored per week; the free text inside each
       day×section cell is stored per (dayKey, sectionId). Both live under
       pc-ops:: so they sync. A section's height is shared across the week,
       so dragging one boundary resizes that band for every day at once.
       Cells have a fixed height and scroll internally, so typing never
       shoves the rest of the page down. ==================================== */
    const SECTIONS_KEY = STORE_KEY + '::sections::v1';
    const SECFREE_KEY  = STORE_KEY + '::sectionfree::v1';
    let __sidSeq = 0;
    function genSectionId() {
      return 's' + Date.now().toString(36) + (__sidSeq++).toString(36) +
             Math.floor(Math.random() * 1e4).toString(36);
    }
    function loadAllSections() { try { return JSON.parse(localStorage.getItem(SECTIONS_KEY) || '{}') || {}; } catch (_) { return {}; } }
    function saveAllSections(all) { try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(all)); } catch (_) {} }
    function loadSecFree() { try { return JSON.parse(localStorage.getItem(SECFREE_KEY) || '{}') || {}; } catch (_) { return {}; } }
    function saveSecFree(all) { try { localStorage.setItem(SECFREE_KEY, JSON.stringify(all)); } catch (_) {} }
    function cellKey(dayKey, sid) { return dayKey + '::' + sid; }

    // A week's sections, keyed by its Monday date. The first time a week is
    // opened we create one default section and COPY each day's existing
    // freeform text into it — non-destructive: the old ::freeform store is
    // left untouched, so nothing is ever lost.
    function getWeekSections(days) {
      const weekKey = days[0].key;
      const all = loadAllSections();
      if (!all[weekKey] || !all[weekKey].length) {
        const sid = genSectionId();
        all[weekKey] = [{ id: sid, name: 'Section 1', height: 220 }];
        saveAllSections(all);
        const FREE = JSON.parse(localStorage.getItem(STORE_KEY + '::freeform') || '{}');
        const sf = loadSecFree();
        let changed = false;
        days.forEach((d) => {
          const ck = cellKey(d.key, sid);
          if (FREE[d.key] && !sf[ck]) { sf[ck] = FREE[d.key]; changed = true; }
        });
        if (changed) saveSecFree(sf);
      }
      return loadAllSections()[weekKey];
    }
    function addSection(weekKey) {
      const all = loadAllSections();
      (all[weekKey] = all[weekKey] || []).push({ id: genSectionId(), name: 'New section', height: 150 });
      saveAllSections(all);
      render();
    }
    function deleteSection(weekKey, sid, days) {
      const all = loadAllSections();
      const arr = all[weekKey] || [];
      if (arr.length <= 1) return;                 // always keep one band
      const sec = arr.find((s) => s.id === sid);
      const name = (sec && sec.name && sec.name.trim()) || 'this section';
      const sf = loadSecFree();
      const hasContent = days.some((d) => sf[cellKey(d.key, sid)]);
      const msg = 'Delete the "' + name + '" section?' +
        (hasContent ? '\n\nIts text in every day of this week will be removed too. This can’t be undone.'
                    : '\n\nThis can’t be undone.');
      if (!window.confirm(msg)) return;
      all[weekKey] = arr.filter((s) => s.id !== sid);
      saveAllSections(all);
      days.forEach((d) => { delete sf[cellKey(d.key, sid)]; });
      saveSecFree(sf);
      render();
    }
    function moveSection(weekKey, sid, dir) {
      const all = loadAllSections();
      const arr = all[weekKey] || [];
      const i = arr.findIndex((s) => s.id === sid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return;
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      saveAllSections(all);
      render();
    }
    function startSectionResize(e, weekKey, sid, row) {
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startH = row.getBoundingClientRect().height;
      const onMove = (ev) => { row.style.minHeight = Math.max(48, startH + (ev.clientY - startY)) + 'px'; };
      const onUp = (ev) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const h = Math.round(Math.max(48, startH + (ev.clientY - startY)));
        const all = loadAllSections();
        const s = (all[weekKey] || []).find((x) => x.id === sid);
        if (s) { s.height = h; saveAllSections(all); }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    /* ── Per-cell background colour ─────────────────────────────────────
       Right-click any day×section cell to fill it with a colour (or clear
       it), for visually categorising blocks — work, exercise, meals, etc.
       Stored per (day, section) under pc-ops:: so it syncs; applied as an
       inline background so cell/section borders stay visible and the text
       and checkboxes remain fully editable. */
    const SECCOLOR_KEY = STORE_KEY + '::sectioncolor::v1';
    function loadSecColors() { try { return JSON.parse(localStorage.getItem(SECCOLOR_KEY) || '{}') || {}; } catch (_) { return {}; } }
    function saveSecColors(all) { try { localStorage.setItem(SECCOLOR_KEY, JSON.stringify(all)); } catch (_) {} }
    const CELL_COLORS = ['#dbeafe', '#dcfce7', '#fef9c3', '#ffedd5', '#ede9fe', '#fce7f3', '#fee2e2', '#e2e8f0'];

    let cellColorMenu = null;
    function buildCellColorMenu() {
      cellColorMenu = document.createElement('div');
      cellColorMenu.className = 'cal-cell-colormenu';
      cellColorMenu.innerHTML =
        '<div class="ccm-swatches">' +
          CELL_COLORS.map((c) => '<button type="button" class="ccm-swatch" data-color="' + c + '" style="background:' + c + '" title="' + c + '"></button>').join('') +
        '</div>' +
        '<button type="button" class="ccm-clear" data-color="">No colour</button>';
      document.body.appendChild(cellColorMenu);
      cellColorMenu.addEventListener('mousedown', (e) => e.preventDefault()); // keep cell selection
      cellColorMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-color]');
        if (!btn) return;
        applyCellColor(cellColorMenu.__ck, btn.getAttribute('data-color'));
        closeCellColorMenu();
      });
    }
    function applyCellColor(ck, color) {
      const all = loadSecColors();
      if (color) all[ck] = color; else delete all[ck];
      saveSecColors(all);
      document.querySelectorAll('.cal-sec-cell[data-key][data-section]').forEach((c) => {
        if (c.dataset.key + '::' + c.dataset.section === ck) c.style.backgroundColor = color || '';
      });
    }
    function openCellColorMenu(e, ck) {
      if (!cellColorMenu) buildCellColorMenu();
      cellColorMenu.__ck = ck;
      cellColorMenu.classList.add('is-open');
      cellColorMenu.style.left = (e.pageX) + 'px';
      cellColorMenu.style.top  = (e.pageY) + 'px';
      const r = cellColorMenu.getBoundingClientRect();
      if (r.right  > window.innerWidth)  cellColorMenu.style.left = Math.max(6, e.pageX - r.width) + 'px';
      if (r.bottom > window.innerHeight) cellColorMenu.style.top  = Math.max(6, e.pageY - r.height) + 'px';
      const outside = (ev) => { if (!cellColorMenu.contains(ev.target)) closeCellColorMenu(); };
      setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
      cellColorMenu.__outside = outside;
    }
    function closeCellColorMenu() {
      if (!cellColorMenu) return;
      cellColorMenu.classList.remove('is-open');
      if (cellColorMenu.__outside) { document.removeEventListener('mousedown', cellColorMenu.__outside, true); cellColorMenu.__outside = null; }
    }

    // Build the section grid for one week into `container` (the .cal-grid).
    function renderSectionGrid(days, container, todayKey) {
      const weekKey = days[0].key;
      container.innerHTML = '';
      // Drop the old 7-column day-grid class: its CSS (display:grid, 7 cols)
      // is more specific than .cal-sec-grid and would crush the section rows
      // into 1/7 of the width. The section rows do their own column layout.
      container.classList.remove('cal-grid-week');
      container.classList.add('cal-sec-grid');

      const headRow = document.createElement('div');
      headRow.className = 'cal-sec-headrow';
      headRow.innerHTML = '<div class="cal-sec-corner"></div>';
      days.forEach((d) => {
        const h = document.createElement('div');
        h.className = 'cwg-col-head cal-sec-dayhead' + (d.key === todayKey ? ' is-today' : '');
        h.innerHTML = '<span class="cwg-dow">' + DOW[dowMon(d.dt)] + '</span>' +
                      '<span class="cwg-num">' + d.dt.getDate() + '</span>';
        headRow.appendChild(h);
      });
      container.appendChild(headRow);

      const sections = getWeekSections(days);
      const sf = loadSecFree();
      const CC = loadSecColors();

      sections.forEach((sec) => {
        const row = document.createElement('div');
        row.className = 'cal-sec-row';
        row.style.minHeight = sec.height + 'px';
        row.dataset.section = sec.id;

        const label = document.createElement('div');
        label.className = 'cal-sec-label';
        label.innerHTML =
          '<span class="cal-sec-name" contenteditable="true" spellcheck="false"></span>' +
          '<div class="cal-sec-tools">' +
            '<button type="button" class="cal-sec-up" title="Move section up" aria-label="Move up">↑</button>' +
            '<button type="button" class="cal-sec-down" title="Move section down" aria-label="Move down">↓</button>' +
            '<button type="button" class="cal-sec-del" title="Delete section" aria-label="Delete">×</button>' +
          '</div>';
        const nameEl = label.querySelector('.cal-sec-name');
        nameEl.textContent = sec.name;
        nameEl.addEventListener('click', (e) => e.stopPropagation());
        nameEl.addEventListener('input', () => {
          if (!safeToPersist(nameEl, nameEl.textContent)) return;
          const all = loadAllSections();
          const s = (all[weekKey] || []).find((x) => x.id === sec.id);
          if (s) { s.name = nameEl.textContent; saveAllSections(all); flashSaved(nameEl); }
        });
        label.querySelector('.cal-sec-up').addEventListener('click', (e) => { e.stopPropagation(); moveSection(weekKey, sec.id, -1); });
        label.querySelector('.cal-sec-down').addEventListener('click', (e) => { e.stopPropagation(); moveSection(weekKey, sec.id, 1); });
        label.querySelector('.cal-sec-del').addEventListener('click', (e) => { e.stopPropagation(); deleteSection(weekKey, sec.id, days); });
        row.appendChild(label);

        days.forEach((d) => {
          const cell = document.createElement('div');
          cell.className = 'cwg-col-free cal-sec-cell' + (d.key === todayKey ? ' is-today' : '');
          cell.setAttribute('contenteditable', 'true');
          cell.dataset.key = d.key;
          cell.dataset.section = sec.id;
          cell.dataset.placeholder = '';
          const ck = cellKey(d.key, sec.id);
          cell.innerHTML = sf[ck] || '';
          if (CC[ck]) cell.style.backgroundColor = CC[ck];
          cell.addEventListener('click', (e) => e.stopPropagation());
          cell.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openCellColorMenu(e, ck);
          });
          cell.addEventListener('input', () => {
            const html = cell.innerHTML;
            if (!safeToPersist(cell, html)) return;
            const cur = loadSecFree();
            const stripped = html.replace(/<br\s*\/?>/gi, '').trim();
            if (!stripped) delete cur[ck]; else cur[ck] = html;
            saveSecFree(cur);
            flashSaved(cell);
          });
          row.appendChild(cell);
        });
        container.appendChild(row);

        const divider = document.createElement('div');
        divider.className = 'cal-sec-divider';
        divider.title = 'Drag to resize this section for the whole week';
        divider.addEventListener('click', (e) => e.stopPropagation());
        divider.addEventListener('mousedown', (e) => startSectionResize(e, weekKey, sec.id, row));
        container.appendChild(divider);
      });

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'cal-sec-add';
      add.textContent = '+ Add section';
      add.addEventListener('click', (e) => { e.stopPropagation(); addSection(weekKey); });
      container.appendChild(add);
    }

    function renderMonthWeeks(view, weeksEl) {
      const today = new Date();
      const todayKey = ymd(today);
      const firstOfMonth = new Date(view.getFullYear(), view.getMonth(), 1);
      const firstDow = dowMon(firstOfMonth);
      const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
      const prevDays    = new Date(view.getFullYear(), view.getMonth(), 0).getDate();
      const totalCells = firstDow + daysInMonth;
      const weekCount  = Math.ceil(totalCells / 7);
      const openState  = JSON.parse(localStorage.getItem(STORE_KEY + '::open') || '{}');
      const monthOpenKey = view.getFullYear() + '-' + (view.getMonth() + 1);
      const monthOpens   = openState[monthOpenKey] || null;

      weeksEl.innerHTML = '';

      for (let w = 0; w < weekCount; w++) {
        // Compute the 7 dates of this week.
        const days = [];
        let weekHasToday = false;
        for (let i = 0; i < 7; i++) {
          const cellIdx = w * 7 + i - firstDow + 1;
          let dt, outside = false;
          if (cellIdx < 1) {
            dt = new Date(view.getFullYear(), view.getMonth() - 1, prevDays + cellIdx);
            outside = true;
          } else if (cellIdx > daysInMonth) {
            dt = new Date(view.getFullYear(), view.getMonth() + 1, cellIdx - daysInMonth);
            outside = true;
          } else {
            dt = new Date(view.getFullYear(), view.getMonth(), cellIdx);
          }
          const key = ymd(dt);
          if (key === todayKey) weekHasToday = true;
          days.push({ dt, outside, key, events: state.events[key] || [] });
        }

        // Decide default open: monthOpens overrides; else open any week with
        // events, the week containing today, or week 1 as a last resort.
        let isOpen;
        if (monthOpens) {
          isOpen = !!monthOpens[w];
        } else {
          const hasEvents = days.some((d) => d.events.length);
          isOpen = hasEvents || weekHasToday || (w === 0 && !todayInMonth(view, todayKey));
        }

        const eventCount = days.reduce((n, d) => n + d.events.length, 0);
        const firstDay = days[0].dt;
        const lastDay  = days[6].dt;
        const rangeLabel = firstDay.getDate() + ' ' + MONTH_NAMES[firstDay.getMonth()].slice(0,3) +
                           ' – ' + lastDay.getDate() + ' ' + MONTH_NAMES[lastDay.getMonth()].slice(0,3);

        const wkSection = document.createElement('section');
        wkSection.className = 'cal-week' + (isOpen ? ' is-open' : '') + (weekHasToday ? ' has-today' : '');
        wkSection.dataset.weekIdx = w;
        wkSection.innerHTML = `
          <div type="button" class="cal-week-head" aria-expanded="${isOpen}">
            <span class="cal-week-label">Week ${w + 1}</span>
            <span class="cal-week-range">${rangeLabel}</span>
            <span class="cal-week-inline-note" contenteditable="true" data-week-key="${view.getFullYear()}-${view.getMonth() + 1}-w${w}" spellcheck="true"></span>
            <button type="button" class="cal-week-note-btn" data-week-key="${view.getFullYear()}-${view.getMonth() + 1}-w${w}" aria-label="Week note" title="Week note">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h11l3 3v13H5z"/><line x1="9" y1="10" x2="15" y2="10"/><line x1="9" y1="14" x2="14" y2="14"/></svg>
              <span class="cwnb-preview"></span>
            </button>
            ${eventCount ? `<span class="cal-week-count">${eventCount} event${eventCount === 1 ? '' : 's'}</span>` : ''}
            <button type="button" class="cal-week-chev" aria-label="Toggle week">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>
          <div class="cal-week-body">
            <div class="cal-grid"></div>
          </div>
        `;
        const grid = wkSection.querySelector('.cal-grid');
        grid.classList.add('cal-grid-week'); // signal: render as open columns
        // Days are now divided into shared, resizable horizontal sections.
        renderSectionGrid(days, grid, todayKey);
        // Wire up the week-note popup trigger
        const NOTES = JSON.parse(localStorage.getItem(STORE_KEY + '::weekNotes') || '{}');
        const noteBtn = wkSection.querySelector('.cal-week-note-btn');
        const weekKey = noteBtn.dataset.weekKey;
        const preview = noteBtn.querySelector('.cwnb-preview');
        const refreshPreview = () => {
          const raw = (NOTES[weekKey] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          preview.textContent = raw ? raw.slice(0, 40) + (raw.length > 40 ? '…' : '') : '';
          noteBtn.classList.toggle('has-note', !!raw);
        };
        refreshPreview();
        noteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openWeekNotePopup(weekKey, noteBtn, refreshPreview);
        });

        // Toggle open/close — only the chevron and label area collapse the row
        const head = wkSection.querySelector('.cal-week-head');
        const toggle = () => {
          wkSection.classList.toggle('is-open');
          const nowOpen = wkSection.classList.contains('is-open');
          head.setAttribute('aria-expanded', nowOpen);
          const cur = JSON.parse(localStorage.getItem(STORE_KEY + '::open') || '{}');
          if (!cur[monthOpenKey]) cur[monthOpenKey] = {};
          cur[monthOpenKey][w] = nowOpen;
          localStorage.setItem(STORE_KEY + '::open', JSON.stringify(cur));
        };
        wkSection.querySelector('.cal-week-chev').addEventListener('click', toggle);
        wkSection.querySelector('.cal-week-label').addEventListener('click', toggle);
        wkSection.querySelector('.cal-week-range').addEventListener('click', toggle);

        // Inline week-note editor (in the row), persists to its OWN store
        // (separate from the popup note so the two are independent).
        const inlineNote = wkSection.querySelector('.cal-week-inline-note');
        const inlineKey = inlineNote.dataset.weekKey;
        const inlineAll = JSON.parse(localStorage.getItem(STORE_KEY + '::weekInline') || '{}');
        if (inlineAll[inlineKey]) inlineNote.textContent = inlineAll[inlineKey];
        inlineNote.addEventListener('click', (e) => e.stopPropagation());
        inlineNote.addEventListener('input', () => {
          const text = inlineNote.textContent.trim();
          if (!safeToPersist(inlineNote, inlineNote.textContent)) return;
          const cur = JSON.parse(localStorage.getItem(STORE_KEY + '::weekInline') || '{}');
          if (!text) delete cur[inlineKey]; else cur[inlineKey] = text;
          localStorage.setItem(STORE_KEY + '::weekInline', JSON.stringify(cur));
          flashSaved(inlineNote);
          mirrorToPinned('.cal-week-inline-note[data-week-key="' + inlineKey + '"]',
                         inlineNote.textContent, 'textContent');
        });
        weeksEl.appendChild(wkSection);
      }
    }

    function todayInMonth(viewDate, todayKey) {
      const [y, m] = todayKey.split('-').map(Number);
      return y === viewDate.getFullYear() && (m - 1) === viewDate.getMonth();
    }

    // ── Week-note popup (one shared element, retargeted per click) ──
    let weekNotePop = null;
    function buildWeekNotePop() {
      weekNotePop = document.createElement('div');
      weekNotePop.className = 'cwn-pop';
      weekNotePop.innerHTML = `
        <div class="cwn-pop-head">
          <span class="cwn-pop-title">Week note</span>
          <button type="button" class="cwn-pop-close" aria-label="Close">×</button>
        </div>
        <textarea class="cwn-pop-body"></textarea>
      `;
      document.body.appendChild(weekNotePop);
      weekNotePop.querySelector('.cwn-pop-close').addEventListener('click', closeWeekNotePopup);
    }
    function openWeekNotePopup(weekKey, anchorBtn, onChange) {
      if (!weekNotePop) buildWeekNotePop();
      const NOTES = JSON.parse(localStorage.getItem(STORE_KEY + '::weekNotes') || '{}');
      const textarea = weekNotePop.querySelector('.cwn-pop-body');
      // Strip HTML for textarea
      const raw = (NOTES[weekKey] || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
      textarea.value = raw;
      // Position below the button, clamped within the viewport
      const r = anchorBtn.getBoundingClientRect();
      const POP_W = 340;
      const MARGIN = 12;
      const maxLeft = window.innerWidth - POP_W - MARGIN;
      let left = r.left + window.scrollX;
      // Prefer right-aligning the popup with the button if the button is on the right
      if (r.left + POP_W > window.innerWidth - MARGIN) {
        left = r.right - POP_W + window.scrollX;
      }
      left = Math.min(Math.max(MARGIN + window.scrollX, left), maxLeft + window.scrollX);
      weekNotePop.style.top  = (r.bottom + window.scrollY + 6) + 'px';
      weekNotePop.style.left = left + 'px';
      weekNotePop.classList.add('is-open');
      setTimeout(() => textarea.focus(), 0);

      const handler = () => {
        const cur = JSON.parse(localStorage.getItem(STORE_KEY + '::weekNotes') || '{}');
        const v = textarea.value.trim();
        if (!v) delete cur[weekKey]; else cur[weekKey] = textarea.value.replace(/\n/g, '<br>');
        localStorage.setItem(STORE_KEY + '::weekNotes', JSON.stringify(cur));
        NOTES[weekKey] = cur[weekKey] || '';
        if (onChange) onChange();
      };
      textarea.oninput = handler;

      const outside = (e) => {
        if (weekNotePop.contains(e.target)) return;
        if (anchorBtn.contains(e.target)) return;
        closeWeekNotePopup();
      };
      setTimeout(() => document.addEventListener('click', outside, true), 0);
      weekNotePop._outside = outside;
    }
    function closeWeekNotePopup() {
      if (!weekNotePop) return;
      weekNotePop.classList.remove('is-open');
      if (weekNotePop._outside) {
        document.removeEventListener('click', weekNotePop._outside, true);
        weekNotePop._outside = null;
      }
    }

    function openDay(key) {
      state.openDay = key;
      const modal = document.getElementById('cal-modal');
      const dateEl = document.getElementById('cal-modal-date');
      const list = document.getElementById('cal-event-list');
      if (!modal) return;
      dateEl.textContent = fmtLong(key);
      renderEventList(list, key);
      modal.classList.add('is-open');
    }
    function closeDay() {
      const modal = document.getElementById('cal-modal');
      if (modal) modal.classList.remove('is-open');
      state.openDay = null;
      render();
    }
    function renderEventList(list, key) {
      list.innerHTML = '';
      const events = state.events[key] || [];
      events.forEach((ev, idx) => {
        const row = document.createElement('div');
        row.className = 'cal-event-row';
        row.innerHTML = `
          <select data-idx="${idx}" class="ev-kind">
            <option value="task">Task</option>
            <option value="busy">Meeting</option>
            <option value="note">Note</option>
          </select>
          <input data-idx="${idx}" class="ev-text" type="text" value="${(ev.text || '').replace(/"/g, '&quot;')}" placeholder="What's happening?" />
          <input data-idx="${idx}" class="ev-start" type="time" value="${ev.start || ''}" title="Start time" />
          <input data-idx="${idx}" class="ev-end"   type="time" value="${ev.end   || ''}" title="End time" />
          <button data-idx="${idx}" class="ev-del" type="button" title="Delete">×</button>
        `;
        row.querySelector('.ev-kind').value = ev.kind || 'task';
        list.appendChild(row);
      });

      list.querySelectorAll('.ev-text').forEach((inp) => {
        inp.addEventListener('input', (e) => {
          const idx = +e.target.dataset.idx;
          state.events[key][idx].text = e.target.value;
          saveEvents(state.events);
        });
      });
      list.querySelectorAll('.ev-kind').forEach((sel) => {
        sel.addEventListener('change', (e) => {
          const idx = +e.target.dataset.idx;
          state.events[key][idx].kind = e.target.value;
          saveEvents(state.events);
        });
      });
      list.querySelectorAll('.ev-start').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const idx = +e.target.dataset.idx;
          state.events[key][idx].start = e.target.value || undefined;
          saveEvents(state.events);
        });
      });
      list.querySelectorAll('.ev-end').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const idx = +e.target.dataset.idx;
          state.events[key][idx].end = e.target.value || undefined;
          saveEvents(state.events);
        });
      });
      list.querySelectorAll('.ev-del').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const idx = +e.target.dataset.idx;
          state.events[key].splice(idx, 1);
          if (!state.events[key].length) delete state.events[key];
          saveEvents(state.events);
          renderEventList(list, key);
        });
      });
    }

    function attachHandlers() {
      const wrapHead = document.getElementById('cal-wrap-head');
      if (wrapHead) {
        wrapHead.addEventListener('click', () => {
          state.collapsed = !state.collapsed;
          localStorage.setItem(STORE_KEY + '::collapsed', state.collapsed ? '1' : '0');
          document.getElementById('planner-cal').classList.toggle('is-collapsed', state.collapsed);
          wrapHead.setAttribute('aria-expanded', !state.collapsed);
        });
        wrapHead.setAttribute('aria-expanded', !state.collapsed);
      }
      document.getElementById('cal-prev').addEventListener('click', () => {
        state.view.setMonth(state.view.getMonth() - 1);
        render();
      });
      document.getElementById('cal-next').addEventListener('click', () => {
        state.view.setMonth(state.view.getMonth() + 1);
        render();
      });
      document.getElementById('cal-today').addEventListener('click', () => {
        const t = new Date(); t.setDate(1);
        state.view = t;
        render();
      });
      document.getElementById('cal-modal-close').addEventListener('click', closeDay);
      document.getElementById('cal-save').addEventListener('click', closeDay);
      document.getElementById('cal-modal').addEventListener('click', (e) => {
        if (e.target.id === 'cal-modal') closeDay();
      });
      document.getElementById('cal-add').addEventListener('click', () => {
        const key = state.openDay;
        if (!key) return;
        if (!state.events[key]) state.events[key] = [];
        state.events[key].push({ kind: 'task', text: '' });
        saveEvents(state.events);
        renderEventList(document.getElementById('cal-event-list'), key);
        // Focus the new input
        const inputs = document.querySelectorAll('#cal-event-list .ev-text');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    }

    function init(attempt) {
      // With the shared dashboard this waits for it to render #panel-home;
      // standalone it mounts straight into [data-calendar-root].
      const host = calendarHost();
      if (!host) {
        if (attempt > 20) return;
        return setTimeout(() => init((attempt || 0) + 1), 50);
      }
      buildShell();
      attachHandlers();
      render();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => init(0));
    } else {
      init(0);
    }
  })();
})();
