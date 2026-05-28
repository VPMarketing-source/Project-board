/* =========================================================================
   Project Clarity — monthly notes cards
   Renders a stack of editable month cards below the Notes box on the Home
   tab. Each client gets its own storage namespace via CLIENT_DATA.id.

   Include AFTER dashboard.js so the Home panel exists:
     <script src="../shared/dashboard.js"></script>
     <script src="../shared/months.js"></script>

   Storage key: pc-ops::<client-id>::months::v1 (auto-synced by sync.js).
   ========================================================================= */
(function bootMonths() {
  const C = window.CLIENT_DATA || {};
  if (!C.id) {
    console.warn('[months] window.CLIENT_DATA.id missing — months disabled.');
    return;
  }
  const STORE_KEY = `pc-ops::${C.id}::months::v1`;

  injectStyles();

  function init() {
    const panel = document.getElementById('panel-home');
    if (!panel) { setTimeout(init, 50); return; }
    if (panel.querySelector('.pc-months')) return;

    const state = load();

    const wrap = document.createElement('div');
    wrap.className = 'pc-months';
    panel.appendChild(wrap);

    function load() {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) return normalize(JSON.parse(raw));
      } catch (_) {}
      return seedDefault();
    }
    function save() {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
    }
    function normalize(s) {
      return {
        order:     Array.isArray(s.order)     ? s.order     : [],
        notes:     (s.notes     && typeof s.notes     === 'object') ? s.notes     : {},
        collapsed: (s.collapsed && typeof s.collapsed === 'object') ? s.collapsed : {},
      };
    }
    function seedDefault() {
      const now = new Date();
      const months = [];
      for (let i = 0; i < 3; i++) {
        months.push(ymKey(new Date(now.getFullYear(), now.getMonth() + i, 1)));
      }
      return { order: months, notes: {}, collapsed: {} };
    }
    function ymKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
    function monthName(key) {
      const [y, m] = key.split('-').map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long' });
    }
    function yearOf(key) { return key.split('-')[0]; }
    function nextAfter(key) {
      const [y, m] = key.split('-').map(Number);
      return ymKey(new Date(y, m, 1));
    }
    function escape(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function render() {
      wrap.innerHTML = state.order.map((key) => {
        const collapsed = !!state.collapsed[key];
        const noteHtml = state.notes[key] || '';
        return `
          <div class="pc-month${collapsed ? ' is-collapsed' : ''}" data-key="${escape(key)}">
            <div class="pc-month-head">
              <div class="pc-month-title">
                <span class="pc-month-name">${escape(monthName(key))}</span>
                <span class="pc-month-year">${escape(yearOf(key))}</span>
              </div>
              <div class="pc-month-actions">
                <button type="button" class="pc-month-x" aria-label="Remove ${escape(monthName(key))}">×</button>
                <button type="button" class="pc-month-toggle" aria-label="${collapsed ? 'Expand' : 'Collapse'}">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="6 15 12 9 18 15"/>
                  </svg>
                </button>
              </div>
            </div>
            <div class="pc-month-body" contenteditable="true"
                 data-placeholder="Notes, goals, planning for ${escape(monthName(key))}…">${noteHtml}</div>
          </div>
        `;
      }).join('') + `<button type="button" class="pc-month-add">+ Add month</button>`;
      wire();
    }

    function wire() {
      wrap.querySelectorAll('.pc-month').forEach((card) => {
        const key  = card.dataset.key;
        const body = card.querySelector('.pc-month-body');

        body.addEventListener('input', () => {
          const stripped = body.innerHTML.replace(/<br\s*\/?>/gi, '').trim();
          if (!stripped) delete state.notes[key]; else state.notes[key] = body.innerHTML;
          save();
        });

        card.querySelector('.pc-month-toggle').addEventListener('click', () => {
          state.collapsed[key] = !state.collapsed[key];
          save();
          card.classList.toggle('is-collapsed', state.collapsed[key]);
          card.querySelector('.pc-month-toggle').setAttribute(
            'aria-label', state.collapsed[key] ? 'Expand' : 'Collapse'
          );
        });

        card.querySelector('.pc-month-x').addEventListener('click', () => {
          if (!confirm(`Remove ${monthName(key)} ${yearOf(key)}?`)) return;
          state.order = state.order.filter((k) => k !== key);
          delete state.notes[key];
          delete state.collapsed[key];
          save();
          render();
        });
      });

      const addBtn = wrap.querySelector('.pc-month-add');
      if (addBtn) {
        addBtn.addEventListener('click', () => {
          const last = state.order[state.order.length - 1];
          const next = last ? nextAfter(last) : ymKey(new Date());
          if (state.order.includes(next)) return;
          state.order.push(next);
          save();
          render();
        });
      }
    }

    render();
  }

  function injectStyles() {
    if (document.getElementById('pc-months-styles')) return;
    const s = document.createElement('style');
    s.id = 'pc-months-styles';
    s.textContent = `
      .pc-months {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-top: 18px;
      }
      .pc-month {
        background: #fbf7e9;
        border: 1px solid #ebe2c8;
        border-radius: 12px;
        padding: 18px 22px 20px;
        transition: padding 160ms ease;
      }
      .pc-month.is-collapsed { padding-bottom: 14px; }
      .pc-month-head {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .pc-month-title {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex: 1 1 auto;
        min-width: 0;
      }
      .pc-month-name {
        font-size: 22px;
        font-weight: 700;
        letter-spacing: -0.005em;
        color: #1f1f29;
        line-height: 1.1;
      }
      .pc-month-year {
        font-size: 17px;
        color: #b0a78a;
        font-weight: 500;
      }
      .pc-month-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .pc-month-x,
      .pc-month-toggle {
        appearance: none;
        background: transparent;
        border: 0;
        color: #8a8676;
        cursor: pointer;
        width: 26px;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        transition: background 120ms ease, color 120ms ease;
        font-size: 18px;
        line-height: 1;
      }
      .pc-month-x:hover { background: rgba(184,96,64,0.10); color: #b86040; }
      .pc-month-toggle:hover { background: rgba(17,19,26,0.05); color: #2b2f3a; }
      .pc-month-toggle svg { transition: transform 180ms ease; }
      .pc-month.is-collapsed .pc-month-toggle svg { transform: rotate(-180deg); }
      .pc-month-body {
        margin-top: 10px;
        min-height: 28px;
        font-size: 14px;
        line-height: 1.55;
        color: #2b2f3a;
        outline: none;
      }
      .pc-month-body:empty::before {
        content: attr(data-placeholder);
        color: #b0a78a;
        font-style: italic;
        pointer-events: none;
      }
      .pc-month-body:focus-visible {
        box-shadow: 0 0 0 2px rgba(168,107,20,0.18);
        border-radius: 4px;
      }
      .pc-month.is-collapsed .pc-month-body { display: none; }
      .pc-month-add {
        appearance: none;
        background: transparent;
        border: 1px dashed #d6cca8;
        color: #8a7340;
        padding: 12px 16px;
        border-radius: 12px;
        font: 600 11px/1 'Poppins', -apple-system, sans-serif;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
      }
      .pc-month-add:hover {
        background: #faf5e2;
        border-color: #b89c4f;
        color: #6b4a13;
      }
    `;
    document.head.appendChild(s);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
