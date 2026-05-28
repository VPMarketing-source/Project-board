/* =========================================================================
   Project Clarity — shared top nav
   Renders a small bar across the top of every client page:
     ← Home          Personal Planner ▾

   Requirements (load order in HTML):
     <script src="../shared/clients.js"></script>   <!-- defines window.CLIENTS_REGISTRY -->
     <script>window.CLIENT_DATA = { id: '...' };</script>
     <script src="../shared/sync.js"></script>
     <script src="../shared/nav.js"></script>

   The bar is fixed at the top; pages with their own headers add
   padding-top to make room (see .pc-nav-spacer below).
   ========================================================================= */
(function bootNav() {
  const registry = window.CLIENTS_REGISTRY || [];
  const current  = (window.CLIENT_DATA && window.CLIENT_DATA.id) || null;

  function render() {
    if (document.getElementById('pc-nav')) return;

    const nav = document.createElement('nav');
    nav.id = 'pc-nav';
    nav.innerHTML = `
      <a class="pc-nav-home" href="../index.html" aria-label="All clients">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6"/>
        </svg>
        <span>Home</span>
      </a>
      <div class="pc-nav-switch">
        <button type="button" class="pc-nav-switch-btn" aria-haspopup="true" aria-expanded="false">
          <span class="pc-nav-switch-label">${escape(currentName())}</span>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <ul class="pc-nav-switch-menu" role="menu" hidden>
          ${registry.map((c) => `
            <li role="none">
              <a role="menuitem" href="../${escape(c.href)}" ${c.id === current ? 'aria-current="page"' : ''}>
                <span class="pc-nav-switch-initials">${escape(c.initials || '')}</span>
                <span class="pc-nav-switch-name">${escape(c.name || c.id)}</span>
              </a>
            </li>
          `).join('')}
        </ul>
      </div>
    `;
    document.body.prepend(nav);

    // Push existing page content down so nothing hides behind the bar.
    const spacer = document.createElement('div');
    spacer.className = 'pc-nav-spacer';
    nav.after(spacer);

    wireSwitcher(nav);
  }

  function currentName() {
    if (current) {
      const found = registry.find((c) => c.id === current);
      if (found) return found.name;
    }
    return (window.CLIENT_DATA && window.CLIENT_DATA.name) || 'Untitled';
  }

  function wireSwitcher(nav) {
    const btn  = nav.querySelector('.pc-nav-switch-btn');
    const menu = nav.querySelector('.pc-nav-switch-menu');
    function close() {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
    function toggle() {
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    }
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    document.addEventListener('click', (e) => { if (!nav.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  function escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Styles — injected once, scoped via #pc-nav.
  function injectStyles() {
    if (document.getElementById('pc-nav-styles')) return;
    const s = document.createElement('style');
    s.id = 'pc-nav-styles';
    s.textContent = `
      #pc-nav {
        position: fixed; top: 0; left: 0; right: 0; z-index: 9000;
        display: flex; align-items: center; gap: 14px;
        padding: 8px 16px;
        background: rgba(255,255,255,0.85);
        backdrop-filter: saturate(140%) blur(10px);
        border-bottom: 1px solid rgba(17,19,26,0.06);
        font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #2b2f3a;
      }
      .pc-nav-spacer { height: 40px; }
      .pc-nav-home {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 5px 9px; border-radius: 7px;
        color: #4a5160; text-decoration: none;
        transition: background 120ms ease, color 120ms ease;
      }
      .pc-nav-home:hover { background: rgba(17,19,26,0.05); color: #11131a; }
      .pc-nav-switch { position: relative; margin-left: auto; }
      .pc-nav-switch-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 11px; border-radius: 7px;
        background: transparent; border: 1px solid rgba(17,19,26,0.10);
        font: inherit; color: #2b2f3a; cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease;
      }
      .pc-nav-switch-btn:hover { background: rgba(17,19,26,0.04); border-color: rgba(17,19,26,0.16); }
      .pc-nav-switch-menu {
        position: absolute; top: calc(100% + 6px); right: 0;
        min-width: 220px; max-height: 60vh; overflow: auto;
        margin: 0; padding: 6px;
        list-style: none;
        background: #fff;
        border: 1px solid rgba(17,19,26,0.08);
        border-radius: 10px;
        box-shadow: 0 8px 28px rgba(17,19,26,0.10);
      }
      .pc-nav-switch-menu li { margin: 0; }
      .pc-nav-switch-menu a {
        display: flex; align-items: center; gap: 10px;
        padding: 7px 9px; border-radius: 7px;
        text-decoration: none; color: #2b2f3a;
      }
      .pc-nav-switch-menu a:hover { background: rgba(41,96,255,0.08); color: #1c3fb0; }
      .pc-nav-switch-menu a[aria-current="page"] { background: rgba(17,19,26,0.04); font-weight: 600; }
      .pc-nav-switch-initials {
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px; border-radius: 50%;
        background: #f1ecdc; color: #6b4a13;
        font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
      }
      .pc-nav-switch-name { font-size: 13px; }
    `;
    document.head.appendChild(s);
  }

  function start() {
    injectStyles();
    render();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
