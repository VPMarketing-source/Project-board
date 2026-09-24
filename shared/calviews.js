/* =========================================================================
   Project Clarity — calendar view switcher

   The calendar is three planning layers, not one screen:

     Week     execution    — what am I doing now
     Horizon  preparation  — what is coming in 3–6 months
     Years    direction    — where is the business and my life heading

   Each layer is its own module. This file owns the one thing they share:
   the Week | Horizon | Years control in the calendar header, and which
   view is currently on. Modules register themselves; nobody else touches
   the switcher, and shared/calendar.js stays untouched entirely — the
   Week view is registered here by pointing at the markup it already
   renders.

     CalViews.register({ id, label, order, els, onShow })
     CalViews.set(id)            switch programmatically
     CalViews.get()              the current view id

   A view can also be asked for in the URL — ?view=years, or #years — which
   is how anything that renders the page without a person clicking (a
   screenshot tool, a link in a message) gets the view it actually wants.
   Without it a fresh browser has no stored choice and always lands on
   Week. A view asked for this way is shown but not remembered, so a
   screenshot link never changes what the owner sees next time.

   Showing and hiding is done with inline display, so a view's own
   stylesheet keeps the last word on how it looks when it IS shown (the
   week grid, for one, still hides itself when the calendar is collapsed).
   ========================================================================= */
(function bootCalViews() {
  'use strict';

  const C = window.CLIENT_DATA;
  if (!C || !C.id) return;
  const VIEW_KEY = 'pc-ops::' + C.id + '::calendar::v1::calview';

  // ?view=years / #years, when present, beats the remembered choice.
  function viewFromUrl(search, hash) {
    const q = /[?&]view=([a-z]+)/i.exec(String(search || ''));
    const h = /^#([a-z]+)$/i.exec(String(hash || ''));
    const asked = (q && q[1]) || (h && h[1]) || '';
    return asked ? asked.toLowerCase() : '';
  }

  const views = [];                        // { id, label, order, els, onShow }
  const asked = viewFromUrl(window.location.search, window.location.hash);
  let current = asked || localStorage.getItem(VIEW_KEY) || 'week';
  let switchEl = null;

  const elsOf = (v) => (v.els || []).map((e) => (typeof e === 'string' ? document.querySelector(e) : e)).filter(Boolean);

  // The view modules register one after another, so the stored view can be
  // one that has not loaded yet. Fall back for painting only — never
  // overwrite `current`, or the last module to register would find the
  // choice already reset to Week and the remembered view would be lost.
  const shown = () => (views.some((v) => v.id === current) ? current : 'week');

  function apply() {
    const on_ = shown();
    const cal = document.getElementById('planner-cal');
    if (cal) {
      views.forEach((v) => cal.classList.toggle('view-' + v.id, v.id === on_));
      cal.setAttribute('data-calview', on_);
    }
    views.forEach((v) => {
      const on = v.id === on_;
      elsOf(v).forEach((el) => { el.style.display = on ? (el.dataset.viewDisplay || '') : 'none'; });
    });
    if (switchEl) {
      switchEl.querySelectorAll('button').forEach((b) => {
        const on = b.dataset.view === on_;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    const v = views.find((x) => x.id === on_);
    if (v && typeof v.onShow === 'function') v.onShow();
  }

  function paintButtons() {
    if (!switchEl) return;
    switchEl.innerHTML = views.slice().sort((a, b) => a.order - b.order)
      .map((v) => '<button type="button" role="tab" data-view="' + v.id + '">' + v.label + '</button>').join('');
  }

  function set(id) {
    if (!views.some((v) => v.id === id)) return;
    current = id;
    localStorage.setItem(VIEW_KEY, id);
    apply();
  }

  function register(view) {
    const i = views.findIndex((v) => v.id === view.id);
    const entry = Object.assign({ order: views.length, els: [] }, view);
    if (i >= 0) views[i] = entry; else views.push(entry);
    paintButtons();
    apply();
    return entry;
  }

  /* ── Mount ───────────────────────────────────────────────────────
     calendar.js builds its shell asynchronously, so poll briefly for the
     header, then group the month arrows and the switcher on the right.
     The switcher goes last so hiding the arrows (they belong to the week
     view) can't shift the control you just clicked. */
  function mount() {
    const cal = document.getElementById('planner-cal');
    const head = cal && cal.querySelector('.cal-head');
    if (!cal || !head || switchEl) return !!switchEl;

    const right = document.createElement('div');
    right.className = 'cal-head-right';
    const nav = head.querySelector('.cal-nav');
    head.appendChild(right);
    if (nav) right.appendChild(nav);

    switchEl = document.createElement('div');
    switchEl.className = 'cal-viewswitch';
    switchEl.setAttribute('role', 'tablist');
    switchEl.setAttribute('aria-label', 'Calendar view');
    right.appendChild(switchEl);
    switchEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (b) set(b.dataset.view);
    });

    // Week is the calendar that already exists: its grid and its own month
    // arrows. Registering it here means no other module has to know about it.
    register({ id: 'week', label: 'Week', order: 0, els: ['#cal-months', '.cal-nav'] });

    // Asking for a view by URL implies wanting to see it, so an accordion
    // that happens to be collapsed (the state syncs between devices) must
    // not hand back a blank page.
    if (asked) cal.classList.remove('is-collapsed');
    return true;
  }

  function boot(attempt) {
    if (mount()) return;
    if (attempt > 60) return;
    setTimeout(() => boot((attempt || 0) + 1), 50);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => boot(0));
  else boot(0);

  window.CalViews = {
    register, set, get: () => shown(), apply, viewFromUrl,
    asked: () => asked,
    ready: () => !!switchEl,
  };
})();
