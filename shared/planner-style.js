/* =========================================================================
   Project Clarity — per-item styling: the strike-through half

   The calendar MCP (api/mcp.js) stores what an item LOOKS like — heading,
   bold, colour — as classes on the item's own block: .pc-head, .pc-b,
   .pc-fg-green / .pc-fg-black / .pc-fg-red. shared/planner-text.css paints
   those.

   What it can't store is what an item's strike-through DEPENDS on, because
   only the planner knows it:

     • a ticked task              → .pc-todo.is-checked (already handled)
     • a timed item whose time    → .is-past, computed from the cell's day
       has passed on its day
     • a multi-step block title   → .is-done on the .pc-drop once every
       whose tasks are all ticked   task in its body is ticked
     • a heading whose tasks are  → .is-done on the .pc-head once every
       all ticked                   task under it is ticked

   So this file derives .is-past / .is-done at render time and does nothing
   else. It never adds, removes, moves or rewrites a line: completed items
   stay exactly where they were completed. The classes are derived, so they
   are recomputed from scratch on every pass — if a stale one ever rides
   along in saved HTML, the next pass corrects it.
   ========================================================================= */
(function () {
  'use strict';

  // Every editable day cell carries its date on data-key (YYYY-MM-DD).
  const CELL_SEL = '.cwg-col-free[data-key]';

  /* ── Time parsing ──────────────────────────────────────────────────
     "3:00pm - Call Marlene", "9am Standup", "15:00 Review", and ranges
     like "9:00am - 10:30am Workshop" (the END of a range is what has to
     pass). A leading number only counts as a time when it carries a colon
     or an am/pm, so "3 emails to send" is never mistaken for 3 o'clock. */
  const TIME = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?';
  const RANGE_RE = new RegExp('^\\s*' + TIME + '\\s*(?:[-–—]|to\\b)\\s*' + TIME, 'i');
  const SINGLE_RE = new RegExp('^\\s*' + TIME, 'i');

  function toMinutes(h, m, mer) {
    let hour = Number(h);
    if (hour > 23) return null;
    const ap = (mer || '').replace(/\./g, '').toLowerCase();
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    const mins = Number(m || 0);
    if (mins > 59) return null;
    return hour * 60 + mins;
  }
  // Minutes-of-day the item is "over" at, or null when the line isn't timed.
  function leadingTime(text) {
    const r = RANGE_RE.exec(text);
    if (r && (r[2] || r[3]) && (r[5] || r[6])) {
      const end = toMinutes(r[4], r[5], r[6] || r[3]);
      if (end != null) return end;
    }
    const s = SINGLE_RE.exec(text);
    if (!s) return null;
    if (!s[2] && !s[3]) return null;          // bare number → not a time
    return toMinutes(s[1], s[2], s[3]);
  }

  /* ── Has this cell's day/time gone? ────────────────────────────────── */
  function dayOffset(dayKey) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey || '');
    if (!m) return null;
    const now = new Date();
    const cell = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((cell - today) / 86400000);
  }

  /* ── Tasks belonging to a heading ──────────────────────────────────
     Everything after the heading, up to the next heading or divider. */
  function tasksUnderHeading(head) {
    const tasks = [];
    let n = head.nextElementSibling;
    while (n) {
      if (n.classList &&
          (n.classList.contains('pc-head') || n.classList.contains('pc-divider'))) break;
      if (n.classList && n.classList.contains('pc-todo')) tasks.push(n);
      else if (n.querySelectorAll) tasks.push(...n.querySelectorAll('.pc-todo'));
      n = n.nextElementSibling;
    }
    return tasks;
  }
  function allTicked(tasks) {
    return tasks.length > 0 && tasks.every((t) => t.classList.contains('is-checked'));
  }
  function setClass(el, name, on) {
    if (!el || !el.classList) return;
    if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
  }

  /* ── One cell ──────────────────────────────────────────────────────── */
  function decorateCell(cell) {
    const offset = dayOffset(cell.dataset ? cell.dataset.key : '');
    const nowMins = (() => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); })();

    // Timed items: struck once their time has gone on their own day. They
    // keep their colour and weight — only the line through is added.
    cell.querySelectorAll('div, p, li').forEach((el) => {
      if (el.classList.contains('pc-head') || el.classList.contains('pc-divider')) return;
      if (el.querySelector('div, p, li, .pc-todo')) return;      // container, not a line
      const textEl = el.querySelector('.pc-todo-text') || el;
      const mins = leadingTime((textEl.textContent || '').replace(/​/g, ''));
      const past = mins != null && offset != null &&
                   (offset < 0 || (offset === 0 && nowMins > mins));
      setClass(el, 'is-past', past);
    });

    // Multi-step block titles: struck once every task in the body is ticked.
    cell.querySelectorAll('.pc-drop').forEach((drop) => {
      const body = drop.querySelector('.pc-drop-body');
      setClass(drop, 'is-done', allTicked([...(body ? body.querySelectorAll('.pc-todo') : [])]));
    });

    // Headings: struck once every task under them is ticked. Colour stays.
    cell.querySelectorAll('.pc-head').forEach((head) => {
      setClass(head, 'is-done', allTicked(tasksUnderHeading(head)));
    });
  }

  function decorateAll(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll(CELL_SEL).forEach(decorateCell);
    if (scope !== document && scope.matches && scope.matches(CELL_SEL)) decorateCell(scope);
  }

  /* ── When to run ───────────────────────────────────────────────────
     After the calendar renders or syncs (DOM changes), when a box is
     ticked (an attribute change, so the observer won't see it), and once a
     minute so a time quietly passing strikes its item through on its own.
     The observer watches structure only — our own class edits can't feed
     back into it. */
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; decorateAll(document); });
  }

  function start() {
    decorateAll(document);
    new MutationObserver(schedule).observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });
    document.addEventListener('change', schedule, true);
    document.addEventListener('click', schedule, true);
    setInterval(schedule, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // Exposed for the tests in tests/planner-style.test.html.
  window.PlannerStyle = { decorateAll, decorateCell, leadingTime };
})();
