/* =========================================================================
   Project Clarity — sticky announcement bar

   One announcement, shown on every page, editable in place. Include on any
   page (order doesn't matter, it waits for the DOM):

     <script src="../shared/announcement.js"></script>

   Storage is deliberately NOT scoped by client. sync.js mirrors keys for a
   single CLIENT_DATA.id, so a per-space key would give you a different
   announcement on every page. This talks to Supabase directly under a
   fixed '__global' client_id, the same way the home page handles its own
   widgets, and caches to localStorage so it paints instantly and survives
   offline.

   The write rules match the rest of the app, for the same reason: nothing
   persists until the server copy has landed, and an *erasing* write is
   only accepted while the bar has focus. A stale or empty render can
   therefore never wipe the announcement for every device at once.
   ========================================================================= */
(function bootAnnouncement() {
  const SUPABASE_URL = 'https://rqlrpxxkskqxpjgiqyql.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxbHJweHhrc2txeHBqZ2lxeXFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5Mjc3OTYsImV4cCI6MjA5NTUwMzc5Nn0.RG7fzJxp_SoSMNxHlkfLgrAx7ycupmt0jEDm3q9XHBE';
  const ROW_CLIENT   = '__global';
  const ROW_KEY      = 'pc-ops::global::announcement::v1';
  // Collapsed state is a per-device view preference, not content, so it is
  // kept out of the synced key.
  const COLLAPSE_KEY = 'plannerAnnounceCollapsed::v1';

  let hydrated = false;
  let bar = null, body = null;

  function isVisuallyEmpty(html) {
    const s = String(html == null ? '' : html);
    if (/<(input|img)\b/i.test(s)) return false;
    return !s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').replace(/[\s​ ]/g, '').length;
  }
  function safeToPersist(el, nextHtml) {
    if (!hydrated) return false;
    if (isVisuallyEmpty(nextHtml) && document.activeElement !== el) return false;
    return true;
  }

  function readLocal() {
    try {
      const raw = localStorage.getItem(ROW_KEY);
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed.html === 'string') ? parsed.html : '';
    } catch (_) { return ''; }
  }
  function writeLocal(html) {
    try { localStorage.setItem(ROW_KEY, JSON.stringify({ html })); } catch (_) {}
  }

  let pushTimer = null;
  function push(html) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      fetch(SUPABASE_URL + '/rest/v1/planner_state?on_conflict=client_id,key', {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify([{
          client_id: ROW_CLIENT,
          key: ROW_KEY,
          value: { raw: JSON.stringify({ html }) },
          updated_at: new Date().toISOString(),
        }]),
        keepalive: true,
      }).then(() => flash()).catch(() => {});
    }, 400);
  }

  function flash() {
    if (!bar) return;
    clearTimeout(bar.__savedTimer);
    bar.classList.add('is-saved');
    bar.__savedTimer = setTimeout(() => bar.classList.remove('is-saved'), 900);
  }

  function injectStyles() {
    if (document.getElementById('pc-announce-styles')) return;
    const s = document.createElement('style');
    s.id = 'pc-announce-styles';
    s.textContent = `
      .pc-announce {
        position: sticky;
        z-index: 8000;
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 10px 18px;
        background: #fdf6dd;
        border-bottom: 1px solid #e8d9a0;
        box-shadow: 0 1px 0 rgba(17,19,26,0.03);
        font-family: Poppins, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        transition: box-shadow 180ms ease;
      }
      .pc-announce.is-saved { box-shadow: inset 3px 0 0 #16a34a; }
      .pc-announce-kicker {
        flex: 0 0 auto;
        margin-top: 2px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: #a86b14;
      }
      .pc-announce-body {
        flex: 1 1 auto;
        min-width: 0;
        font-size: 14px;
        line-height: 1.5;
        color: #2b2f3a;
        outline: none;
        overflow-wrap: anywhere;
      }
      .pc-announce-body:empty::before {
        content: attr(data-placeholder);
        color: #b2a377;
        font-style: italic;
      }
      .pc-announce-toggle {
        flex: 0 0 auto;
        width: 22px; height: 22px;
        display: inline-flex; align-items: center; justify-content: center;
        padding: 0;
        background: transparent;
        border: 1px solid rgba(17,19,26,0.12);
        border-radius: 50%;
        color: #8a7a4a;
        cursor: pointer;
        line-height: 1;
      }
      .pc-announce-toggle:hover { color: #a86b14; border-color: #a86b14; }
      .pc-announce.is-collapsed { padding: 4px 18px; }
      .pc-announce.is-collapsed .pc-announce-body { display: none; }
      @media print { .pc-announce { display: none; } }
    `;
    document.head.appendChild(s);
  }

  function mount() {
    if (document.getElementById('pc-announce')) return;
    injectStyles();

    bar = document.createElement('div');
    bar.id = 'pc-announce';
    bar.className = 'pc-announce';
    bar.innerHTML =
      '<span class="pc-announce-kicker">Announcement</span>' +
      '<div class="pc-announce-body" contenteditable="true" ' +
      'data-placeholder="Type an announcement — it shows on every page, on every device…"></div>' +
      '<button type="button" class="pc-announce-toggle" aria-label="Collapse announcement">–</button>';

    // Client pages carry a fixed top nav; sit directly beneath it rather
    // than sliding underneath when the page scrolls.
    const nav = document.getElementById('pc-nav');
    const spacer = document.querySelector('.pc-nav-spacer');
    bar.style.top = nav ? (nav.offsetHeight || 40) + 'px' : '0px';
    if (spacer && spacer.parentNode) spacer.parentNode.insertBefore(bar, spacer.nextSibling);
    else document.body.insertBefore(bar, document.body.firstChild);

    body = bar.querySelector('.pc-announce-body');
    body.innerHTML = readLocal();

    body.addEventListener('input', () => {
      const html = body.innerHTML;
      if (!safeToPersist(body, html)) return;
      writeLocal(html);
      push(html);
    });

    const toggle = bar.querySelector('.pc-announce-toggle');
    function applyCollapsed(on) {
      bar.classList.toggle('is-collapsed', on);
      toggle.textContent = on ? '+' : '–';
      toggle.setAttribute('aria-label', on ? 'Expand announcement' : 'Collapse announcement');
    }
    applyCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    toggle.addEventListener('click', () => {
      const on = !bar.classList.contains('is-collapsed');
      applyCollapsed(on);
      try { localStorage.setItem(COLLAPSE_KEY, on ? '1' : '0'); } catch (_) {}
    });

    // Pull the shared copy, then allow writes. Settles either way so an
    // unreachable network leaves the bar editable rather than read-only.
    fetch(SUPABASE_URL + '/rest/v1/planner_state?select=value&client_id=eq.' +
          encodeURIComponent(ROW_CLIENT) + '&key=eq.' + encodeURIComponent(ROW_KEY), {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
    })
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((rows) => {
        if (!rows || !rows.length) return;
        const raw = rows[0].value && rows[0].value.raw;
        if (typeof raw !== 'string') return;
        if (document.activeElement === body) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.html !== 'string') return;
        if (parsed.html === body.innerHTML) return;
        writeLocal(parsed.html);
        body.innerHTML = parsed.html;
      })
      .catch(() => {})
      .then(() => { hydrated = true; });
  }

  // nav.js prepends its bar on DOMContentLoaded too; defer a tick so the
  // announcement lands underneath it rather than racing it.
  function start() { setTimeout(mount, 0); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
