/* =========================================================================
   Project Clarity — shared dashboard behaviour
   Reads from window.CLIENT_DATA (per-client config) and renders everything.
   Edit this file to change behaviour or layout for EVERY client at once.

   window.CLIENT_DATA shape:
   {
     id:        'fudge',                       // unique — scopes localStorage
     name:      'Fudge Lifestyle',
     initials:  'FL',
     sub:       'Email marketing · Klaviyo',
     funnel:    { spend, cpv, cvr, aov, ret, rov },   // initial values
     campaigns: [{ name, date, status, url }, ...],
     notes:     [{ text, muted }, ...],
     links:     [{ label, url }, ...],
   }
   ========================================================================= */

(function bootDashboard() {
  const C = window.CLIENT_DATA;
  if (!C || !C.id) {
    document.body.innerHTML =
      '<pre style="padding:32px;color:#b7341f;font-family:monospace">' +
      'No window.CLIENT_DATA found. Add a &lt;script&gt; block setting it before loading dashboard.js.' +
      '</pre>';
    return;
  }

  // localStorage keys — all scoped by client id so data never leaks between clients
  const KEYS = {
    funnel:    `pc-ops::${C.id}::funnel::v1`,
    campaigns: `pc-ops::${C.id}::campaigns::v1`,
    retainer:  `pc-ops::${C.id}::retainer::v1`,
    tasks:     `pc-ops::${C.id}::tasks::v1`,
    notes:     `pc-ops::${C.id}::notes::v1`,
    links:     `pc-ops::${C.id}::links::v1`,
    pages:     `pc-ops::${C.id}::pages::v1`,
    pinned:    `pc-ops::${C.id}::pinned::v1`,
    clickup:   `pc-ops::${C.id}::clickup::v1`,
    sections:  `pc-ops::${C.id}::sections::v1`,
    hiddenTabs:`pc-ops::${C.id}::hiddenTabs::v1`,
  };

  function loadStore(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(fallback));
    } catch (e) { return JSON.parse(JSON.stringify(fallback)); }
  }
  function saveStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function clearAll() {
    Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
  }

  // ── Shell HTML ──────────────────────────────────────────────────────────
  const tabIcons = {
    home:      '<path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/>',
    forecast:  '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/>',
    campaigns: '<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/>',
    retainer:  '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
    notes:     '<rect x="5" y="3" width="14" height="18" rx="2"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>',
    links:     '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
    tasks:     '<polyline points="4 11 8 15 17 6"/><polyline points="4 18 8 22 17 13" opacity="0.5"/>',
  };
  function tabIcon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${tabIcons[name] || ''}</svg>`;
  }

  document.title = `${C.name} — Project Clarity`;
  document.body.innerHTML = `
    <div class="site-shell">
      <div class="site-inner">
        <header class="header" data-screen-label="Client header">
          <div class="avatar" aria-hidden="true">${escapeHtml(C.initials || '')}</div>
          <div class="client-block">
            <h1 class="client-name">${escapeHtml(C.name || '')}</h1>
            <div class="client-sub">${escapeHtml(C.sub || '')}</div>
          </div>
          <div class="client-meta">
            <button class="reset-template" type="button" id="open-clickup" title="ClickUp integration settings" aria-label="ClickUp settings">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;vertical-align:-1px;margin-right:4px;"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              ClickUp
            </button>
            <button class="reset-template" type="button" id="reset-template" title="Discard local edits and reload defaults from the client config">Reset to template</button>
          </div>
        </header>
        <nav class="tabs" role="tablist" aria-label="Client sections" id="tabs">
          <button class="tab" role="tab" aria-selected="true"  data-tab="home"  type="button">${tabIcon('home')} Home</button>
          <button class="tab" role="tab" aria-selected="false" data-tab="forecast" type="button">${tabIcon('forecast')} Forecast</button>
          <button class="tab" role="tab" aria-selected="false" data-tab="campaigns" type="button">${tabIcon('campaigns')} Campaigns</button>
          <button class="tab" role="tab" aria-selected="false" data-tab="retainer" type="button">${tabIcon('retainer')} Retainer</button>
          <button class="tab" role="tab" aria-selected="false" data-tab="tasks" type="button">${tabIcon('tasks')} Tasks</button>
          <button class="tab" role="tab" aria-selected="false" data-tab="notes" type="button">${tabIcon('notes')} Notes</button>
          <button class="tab" role="tab" aria-selected="false" data-tab="links" type="button">${tabIcon('links')} Links</button>
          <button class="tab tab-add" type="button" id="tab-add" title="Add a free-form page" aria-label="Add page">+</button>
          <button class="tab tab-manage" type="button" id="tab-manage" title="Show / hide tabs" aria-label="Manage tabs">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
          </button>
        </nav>
      </div>
    </div>

    <main class="page">
      <section class="panel is-active" id="panel-home" role="tabpanel" data-screen-label="Home panel">
        ${homePanelHtml()}
      </section>
      <section class="panel" id="panel-forecast" role="tabpanel" data-screen-label="Forecast panel">
        ${forecastPanelHtml()}
      </section>
      <section class="panel" id="panel-campaigns" role="tabpanel" data-screen-label="Campaigns panel">
        ${campaignsPanelHtml()}
      </section>
      <section class="panel" id="panel-retainer" role="tabpanel" data-screen-label="Retainer panel">
        ${retainerPanelHtml()}
      </section>
      <section class="panel" id="panel-tasks" role="tabpanel" data-screen-label="Tasks panel">
        <div class="tasks-page">
          <div class="tasks-page-head">
            <span class="home-section-title">Tasks</span>
            <span class="home-section-count" id="tasks-count">(0)</span>
            <span class="tasks-page-source" id="tasks-source"></span>
          </div>
          <table class="ctable">
            <thead>
              <tr>
                <th class="col-client">Task</th>
                <th class="col-date">Due date</th>
                <th class="col-status">Status</th>
                <th class="col-link">ClickUp</th>
              </tr>
            </thead>
            <tbody id="tasks-rows"></tbody>
          </table>
        </div>
      </section>
      <section class="panel" id="panel-notes" role="tabpanel" data-screen-label="Notes panel">
        <div class="notes-wrap" id="notes-list"></div>
        <button class="add-btn" type="button" id="add-note-btn">+ Add note</button>
      </section>
      <section class="panel" id="panel-links" role="tabpanel" data-screen-label="Links panel">
        <div class="links-wrap" id="links-list"></div>
        <button class="add-btn" type="button" id="add-link-btn">+ Add link</button>
      </section>
    </main>

    <div class="modal-overlay" id="clickup-modal" hidden>
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="clickup-title">
        <button class="modal-close" type="button" id="clickup-close" aria-label="Close">×</button>
        <div class="connect-wrap">
          <div class="connect-head">
            <div class="connect-status" id="connect-status">
              <span class="connect-dot"></span>
              <span class="connect-status-label">Not connected</span>
            </div>
            <span class="connect-title" id="clickup-title">ClickUp integration</span>
            <span class="connect-sub">Sync ${escapeHtml(C.name || 'this client')}’s campaigns, retainer tasks, and tasks directly from ClickUp.</span>
          </div>

          <div class="connect-grid">
            <label class="field field-full">
              <span class="field-label">Proxy URL</span>
              <input type="text" id="cu-proxy" autocomplete="off" placeholder="https://your-worker.workers.dev" />
              <span class="field-hint">Your Cloudflare Worker URL. The Worker holds the ClickUp token as a secret — no token needed here.</span>
            </label>

            <div class="field field-full discover-row">
              <button type="button" class="connect-test" id="connect-discover">🔍 Discover workspace</button>
              <span class="discover-hint" id="discover-hint">Pulls your workspaces, folders and lists from ClickUp so you can pick them from a dropdown.</span>
            </div>

            <label class="field">
              <span class="field-label">Workspace</span>
              <select id="cu-workspace"><option value="">— discover first —</option></select>
              <span class="field-hint">Auto-detected.</span>
            </label>
            <label class="field">
              <span class="field-label">Client filter</span>
              <input type="text" id="cu-client-field" placeholder="${escapeHtml((C.clientAliases || []).join(', ') || C.name || '')}" />
              <span class="field-hint">Optional. Comma-separated aliases — only show tasks whose "Client" custom field matches any of these. Leave blank to use the client config defaults.</span>
            </label>
            <label class="field">
              <span class="field-label">Campaigns list</span>
              <select id="cu-camp-list"><option value="">— pick a list —</option></select>
              <span class="field-hint">→ Home: Email campaigns</span>
            </label>
            <label class="field">
              <span class="field-label">Retainer list</span>
              <select id="cu-ret-list"><option value="">— pick a list —</option></select>
              <span class="field-hint">→ Home: Retainer tasks</span>
            </label>
            <label class="field field-full">
              <span class="field-label">Tasks list</span>
              <select id="cu-tasks-list"><option value="">— pick a list —</option></select>
              <span class="field-hint">→ Tasks tab. Catch-all for ad-hoc tasks.</span>
            </label>
          </div>

          <div class="connect-actions">
            <button type="button" class="connect-save" id="connect-save">Save &amp; sync</button>
            <button type="button" class="connect-test" id="connect-test">Test connection</button>
            <button type="button" class="connect-test" id="connect-sync">Sync now</button>
            <button type="button" class="connect-clear" id="connect-clear">Disconnect</button>
          </div>

          <p class="connect-note" id="connect-log">
            <strong>Heads up</strong> — credentials are stored in this browser only.
            All three tables auto-populate from ClickUp on page load when connected.
          </p>
        </div>
      </div>
    </div>
  `;

  function homePanelHtml() {
    const heroBlock = C.heroImage
      ? `<div class="client-hero" data-screen-label="Client hero"><img src="${escapeHtml(C.heroImage)}" alt="${escapeHtml(C.name || '')} hero" /></div>`
      : '';
    // Optional per-client custom HTML injected above Notes. Raw HTML
    // string set on CLIENT_DATA.customHomeHtml — used for things like
    // the VPM "Three priorities" working document.
    const customBlock = C.customHomeHtml
      ? `<div class="home-custom" data-screen-label="Custom home block">${C.customHomeHtml}</div>`
      : '';
    return `
      ${heroBlock}
      ${customBlock}
      <div class="pinned" data-screen-label="Notes">
        <div class="pinned-head">
          <span class="pinned-label">${escapeHtml(C.notesLabel || 'Notes')}</span>
        </div>
        <div class="pinned-body" contenteditable="true" id="pinned-body"></div>
      </div>
    `;
  }

  function forecastPanelHtml() {
    return `
      <div class="tasks-page">
        <div class="tasks-page-head">
          <span class="home-section-title">Revenue forecast</span>
        </div>
        <div class="forecast-body" id="forecast-body">
          <div class="result-cards">
            <div class="result is-revenue">
              <span class="rs-label">Total revenue</span>
              <span class="rs-value" id="rs-total">$0</span>
              <span class="rs-sub">new + returning</span>
            </div>
            <div class="result is-headline">
              <span class="rs-label">MER</span>
              <span class="rs-value" id="rs-mer">0×</span>
              <span class="rs-sub">return on every $1 of ad spend</span>
            </div>
          </div>

          <div class="funnel funnel-flow" id="funnel">
            <div class="funnel-row">
              ${stageBox('spend', 'Ad spend', 'in-spend', 1000, 12000, 100,  'stage-input')}
              ${arrow('cpv')}
              ${stageBox('visits', 'Visits', 'in-cpv', 0.20, 2.00, 0.01, '', 'Cost per visit')}
              ${arrow('cvr')}
              ${stageBox('new', 'New customers', 'in-cvr', 0.5, 8, 0.1, '', 'Conversion rate')}
              ${arrow('aov')}
              ${stageBox('newrev', 'New revenue', 'in-aov', 40, 200, 1, '', 'Order value')}
            </div>
            <div class="funnel-row funnel-row-2">
              <div class="st-arrow st-arrow-down" aria-hidden="true">
                <span class="ar-rate" id="ar-ret">0% back</span>
                <svg viewBox="0 0 10 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 0v20M1 16l4 4 4-4"></path></svg>
              </div>
              ${stageBox('retc', 'Returning customers', 'in-ret', 0, 60, 0.5, '', 'Returning rate')}
              ${arrow('rov')}
              ${stageBox('retrev', 'Returning revenue', 'in-rov', 40, 250, 1, '', 'Repeat order value')}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function retainerPanelHtml() {
    return `
      <div class="tasks-page">
        <div class="tasks-page-head">
          <span class="home-section-title">Retainer tasks</span>
          <span class="home-section-count" id="ret-count">(0)</span>
        </div>
        <table class="ctable">
          <thead>
            <tr>
              <th class="col-client">Task</th>
              <th class="col-date">Due date</th>
              <th class="col-status">Status</th>
              <th class="col-link">ClickUp</th>
            </tr>
          </thead>
          <tbody id="retainer-rows"></tbody>
        </table>
      </div>
    `;
  }

  function campaignsPanelHtml() {
    return `
      <div class="tasks-page">
        <div class="tasks-page-head">
          <span class="home-section-title">Email campaigns</span>
          <span class="home-section-count" id="camp-count">(0)</span>
        </div>
        <table class="ctable">
          <thead>
            <tr>
              <th class="col-client">Campaign</th>
              <th class="col-date">Klaviyo Send Date</th>
              <th class="col-status">Status</th>
              <th class="col-link">ClickUp</th>
            </tr>
          </thead>
          <tbody id="campaign-rows"></tbody>
        </table>
      </div>
    `;
  }

  function stageBox(slug, label, inputId, min, max, step, extraClass, sliderLabel) {
    return `
      <div class="stage ${extraClass || ''}">
        <span class="st-label">${escapeHtml(label)}</span>
        <span class="st-value" id="st-${slug}">—</span>
        <div class="st-slider">
          ${sliderLabel ? `<span class="st-slider-label">${escapeHtml(sliderLabel)}</span>` : ''}
          <input type="range" id="${inputId}" min="${min}" max="${max}" step="${step}" />
        </div>
      </div>
    `;
  }
  function arrow(slug) {
    return `
      <div class="st-arrow" aria-hidden="true">
        <span class="ar-rate" id="ar-${slug}"></span>
        <svg viewBox="0 0 22 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M0 5h20M16 1l4 4-4 4"></path></svg>
      </div>
    `;
  }

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ── Tabs ────────────────────────────────────────────────────────────────
  // ── Show / hide built-in tabs ───────────────────────────
  (function initTabManager() {
    const BUILTIN = [
      { key: 'forecast',  label: 'Forecast'  },
      { key: 'campaigns', label: 'Campaigns' },
      { key: 'retainer',  label: 'Retainer'  },
      { key: 'tasks',     label: 'Tasks'     },
      { key: 'notes',     label: 'Notes'     },
      { key: 'links',     label: 'Links'     },
    ];
    const HIDDEN = new Set(loadStore(KEYS.hiddenTabs, []));
    function applyHidden() {
      document.querySelectorAll('#tabs .tab[data-tab]').forEach((t) => {
        t.style.display = HIDDEN.has(t.dataset.tab) ? 'none' : '';
      });
      const active = document.querySelector('#tabs .tab[aria-selected="true"]');
      if (active && HIDDEN.has(active.dataset.tab) && window.__pcSelectTab) {
        window.__pcSelectTab('home');
      }
    }
    function save() { saveStore(KEYS.hiddenTabs, [...HIDDEN]); }
    let pop = null;
    function buildPop() {
      pop = document.createElement('div');
      pop.className = 'tab-manage-pop';
      pop.innerHTML = '<div class="tmp-head">Show tabs</div><div class="tmp-list"></div>';
      document.body.appendChild(pop);
    }
    function renderPop() {
      const list = pop.querySelector('.tmp-list');
      list.innerHTML = '';
      // Walk every real tab currently in the DOM so dynamically-added tabs
      // (e.g. Overdue, This Week) get checkboxes too. Builtin labels are
      // kept consistent via the BUILTIN map; other tabs fall back to their
      // own DOM text.
      const builtinLabels = Object.fromEntries(BUILTIN.map((b) => [b.key, b.label]));
      const seen = new Set();
      const allTabs = [...document.querySelectorAll('#tabs .tab[data-tab]')]
        .filter((t) => !t.classList.contains('tab-add') && !t.classList.contains('tab-manage'));
      allTabs.forEach((tabEl) => {
        const key = tabEl.dataset.tab;
        if (!key || key === 'home' || seen.has(key)) return;
        seen.add(key);
        const labelText = builtinLabels[key]
          || (tabEl.querySelector('.tab-label') && tabEl.querySelector('.tab-label').textContent.trim())
          || tabEl.textContent.trim()
          || key;
        const row = document.createElement('label');
        row.className = 'tmp-row';
        const visible = !HIDDEN.has(key);
        row.innerHTML = '<input type="checkbox" ' + (visible ? 'checked' : '') + ' /><span></span>';
        row.querySelector('span').textContent = labelText;
        row.querySelector('input').addEventListener('change', (e) => {
          if (e.target.checked) HIDDEN.delete(key); else HIDDEN.add(key);
          save();
          applyHidden();
        });
        list.appendChild(row);
      });
    }
    function positionPop(btn) {
      const r = btn.getBoundingClientRect();
      pop.style.top  = (r.bottom + window.scrollY + 6) + 'px';
      pop.style.left = Math.max(12, r.right + window.scrollX - 220) + 'px';
    }
    function openPop(btn) {
      if (!pop) buildPop();
      renderPop();
      positionPop(btn);
      pop.classList.add('is-open');
      setTimeout(() => document.addEventListener('click', outsideClose, true), 0);
    }
    function closePop() {
      if (pop) pop.classList.remove('is-open');
      document.removeEventListener('click', outsideClose, true);
    }
    function outsideClose(e) {
      if (!pop) return;
      if (pop.contains(e.target)) return;
      if (e.target.closest('#tab-manage')) return;
      closePop();
    }
    const btn = document.getElementById('tab-manage');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pop && pop.classList.contains('is-open')) closePop();
        else openPop(btn);
      });
    }
    applyHidden();
  })();

  (function initTabs() {
    function currentTabs() { return [...document.querySelectorAll('#tabs .tab:not(.tab-add):not(.tab-manage)')]; }
    window.__pcSelectTab = function selectTab(name) {
      const tabs = currentTabs();
      tabs.forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('is-active', p.id === 'panel-' + name));
      try { history.replaceState(null, '', '#' + name); } catch (e) {}
    };
    document.getElementById('tabs').addEventListener('click', (e) => {
      if (e.target.closest('.tab-manage')) return;
      const addBtn = e.target.closest('.tab-add');
      if (addBtn) { addPage(); return; }
      const tab = e.target.closest('.tab');
      if (!tab) return;
      window.__pcSelectTab(tab.dataset.tab);
    });
    document.getElementById('tabs').addEventListener('keydown', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      const list = currentTabs();
      const i = list.indexOf(tab);
      if (i < 0) return;
      const go = (n) => { list[n].focus(); list[n].click(); };
      if (e.key === 'ArrowRight') { e.preventDefault(); go((i + 1) % list.length); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); go((i - 1 + list.length) % list.length); }
      if (e.key === 'Home')       { e.preventDefault(); go(0); }
      if (e.key === 'End')        { e.preventDefault(); go(list.length - 1); }
    });
  })();

  // ── Funnel ──────────────────────────────────────────────────────────────
  const FUNNEL_DEFAULTS = C.funnel || { spend: 4000, cpv: 0.68, cvr: 2.0, aov: 95, ret: 28, rov: 105 };
  const FUNNEL = loadStore(KEYS.funnel, FUNNEL_DEFAULTS);
  const fmtMoney0 = (n) => '$' + Math.round(n).toLocaleString('en-AU');
  const fmtInt    = (n) => Math.round(n).toLocaleString('en-AU');

  ['spend', 'cpv', 'cvr', 'aov', 'ret', 'rov'].forEach((k) => {
    const el = document.getElementById('in-' + k);
    if (el && FUNNEL[k] != null) el.value = FUNNEL[k];
  });

  function recalcFunnel() {
    const $ = (id) => document.getElementById(id);
    const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    const spend = +$('in-spend').value;
    const cpv   = +$('in-cpv').value;
    const cvr   = +$('in-cvr').value;
    const aov   = +$('in-aov').value;
    const ret   = +$('in-ret').value;
    const rov   = +$('in-rov').value;

    const visits = spend / cpv;
    const newc   = visits * (cvr / 100);
    const newrev = newc * aov;
    const retc   = newc * (ret / 100);
    const retrev = retc * rov;
    const total  = newrev + retrev;
    const mer    = total / spend;

    setText('st-spend',  fmtMoney0(spend));
    setText('st-visits', fmtInt(visits));
    setText('st-new',    fmtInt(newc));
    setText('st-newrev', fmtMoney0(newrev));
    setText('st-retc',   fmtInt(retc));
    setText('st-retrev', fmtMoney0(retrev));

    setText('ar-cpv', '$' + cpv.toFixed(2) + ' / visit');
    setText('ar-cvr', cvr.toFixed(1) + '%');
    setText('ar-aov', '$' + aov);
    setText('ar-ret', ret.toFixed(1) + '% back');
    setText('ar-rov', '$' + rov);

    setText('rs-total', fmtMoney0(total));
    setText('rs-mer',   mer.toFixed(1) + '×');

    saveStore(KEYS.funnel, { spend, cpv, cvr, aov, ret, rov });
  }
  ['in-spend','in-cpv','in-cvr','in-aov','in-ret','in-rov'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', recalcFunnel);
  });
  recalcFunnel();

  // ── Pinned / Top of mind ────────────────────────────────────────
  const PINNED = loadStore(KEYS.pinned, { html: '' });
  const pinnedEl = document.getElementById('pinned-body');
  if (pinnedEl) {
    pinnedEl.innerHTML = PINNED.html || '';
    pinnedEl.addEventListener('input', () => {
      PINNED.html = pinnedEl.innerHTML;
      saveStore(KEYS.pinned, PINNED);
    });
  }

  // ── Email campaigns ─────────────────────────────────────────────────────
  const CAMPAIGNS = loadStore(KEYS.campaigns, C.campaigns || []);
  const STATUS_LABEL = { scheduled: 'Scheduled', draft: 'Draft', review: 'In review', sent: 'Sent', paused: 'Paused' };
  const STATUS_CYCLE = ['draft', 'review', 'scheduled', 'sent', 'paused'];
  const linkIconSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M10 14L20 4"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/></svg>';

  const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  function parseSendDate(s) {
    if (!s) return Infinity;
    const m = String(s).toLowerCase().match(/(\d{1,2})\s+([a-z]{3,})(?:[^0-9]*?(\d{1,2}):(\d{2})\s*(am|pm)?)?/);
    if (!m) return Infinity;
    const day = +m[1];
    const mon = MONTHS[m[2].slice(0, 3)];
    if (mon == null) return Infinity;
    let hr = m[3] ? +m[3] : 0;
    const mn = m[4] ? +m[4] : 0;
    if (m[5] === 'pm' && hr < 12) hr += 12;
    if (m[5] === 'am' && hr === 12) hr = 0;
    return (mon * 31 + day) * 24 * 60 + hr * 60 + mn;
  }
  function emptyRow(noun) {
    // Check storage directly — CLICKUP const may not be initialized yet during first render
    let connected = false;
    try {
      const raw = localStorage.getItem(KEYS.clickup);
      if (raw) {
        const cu = JSON.parse(raw);
        connected = !!(cu && cu.proxyUrl && (cu.campList || cu.retList || cu.tasksList));
      }
    } catch (e) {}
    const msg = connected
      ? `No ${noun} found in the connected ClickUp list.`
      : `No ${noun} yet — connect ClickUp to sync, or add rows by editing this file.`;
    return `<tr class="empty-row"><td colspan="4">${msg}</td></tr>`;
  }
  function renderCampaigns() {
    CAMPAIGNS.sort((a, b) => parseSendDate(a.date) - parseSendDate(b.date));
    const tbody = document.getElementById('campaign-rows');
    if (!tbody) return;
    if (!CAMPAIGNS.length) {
      tbody.innerHTML = emptyRow('campaigns');
      document.getElementById('camp-count').textContent = '(0)';
      saveStore(KEYS.campaigns, CAMPAIGNS);
      return;
    }
    tbody.innerHTML = CAMPAIGNS.map((c, i) => `
      <tr data-i="${i}">
        <td class="col-client">${escapeHtml(c.name)}</td>
        <td class="col-date">${escapeHtml(c.date)}</td>
        <td class="col-status">
          <span class="st st-${c.status}" data-action="cycle-status" data-i="${i}" title="Click to change">
            <span class="dot"></span>${STATUS_LABEL[c.status] || c.status}
          </span>
        </td>
        <td class="col-link">
          <a class="link-btn" href="${escapeHtml(c.url || '#')}" target="_blank" rel="noopener noreferrer" aria-label="Open in ClickUp" title="Open in ClickUp">${linkIconSVG}</a>
        </td>
      </tr>`).join('');
    document.getElementById('camp-count').textContent = '(' + CAMPAIGNS.length + ')';
    saveStore(KEYS.campaigns, CAMPAIGNS);
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action="cycle-status"]');
    if (!t) return;
    const i = +t.dataset.i;
    const cur = CAMPAIGNS[i].status;
    CAMPAIGNS[i].status = STATUS_CYCLE[(STATUS_CYCLE.indexOf(cur) + 1) % STATUS_CYCLE.length];
    renderCampaigns();
  });
  renderCampaigns();

  // ── Retainer tasks (same shape as campaigns; task statuses) ─────────────────
  const RETAINER = loadStore(KEYS.retainer, C.retainer || []);
  const TASK_STATUS_LABEL = { todo: 'To do', doing: 'In progress', review: 'In review', done: 'Done', blocked: 'Blocked' };
  const TASK_STATUS_CYCLE = ['todo', 'doing', 'review', 'done', 'blocked'];

  function renderRetainer() {
    RETAINER.sort((a, b) => parseSendDate(a.date) - parseSendDate(b.date));
    const tbody = document.getElementById('retainer-rows');
    if (!tbody) return;
    if (!RETAINER.length) {
      tbody.innerHTML = emptyRow('retainer tasks');
      document.getElementById('ret-count').textContent = '(0)';
      saveStore(KEYS.retainer, RETAINER);
      return;
    }
    tbody.innerHTML = RETAINER.map((t, i) => `
      <tr data-i="${i}">
        <td class="col-client">${escapeHtml(t.name)}</td>
        <td class="col-date">${escapeHtml(t.date)}</td>
        <td class="col-status">
          <span class="st st-task-${t.status}" data-action="cycle-task-status" data-i="${i}" title="Click to change">
            <span class="dot"></span>${TASK_STATUS_LABEL[t.status] || t.status}
          </span>
        </td>
        <td class="col-link">
          <a class="link-btn" href="${escapeHtml(t.url || '#')}" target="_blank" rel="noopener noreferrer" aria-label="Open in ClickUp" title="Open in ClickUp">${linkIconSVG}</a>
        </td>
      </tr>`).join('');
    document.getElementById('ret-count').textContent = '(' + RETAINER.length + ')';
    saveStore(KEYS.retainer, RETAINER);
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action="cycle-task-status"]');
    if (!t) return;
    const i = +t.dataset.i;
    const cur = RETAINER[i].status;
    RETAINER[i].status = TASK_STATUS_CYCLE[(TASK_STATUS_CYCLE.indexOf(cur) + 1) % TASK_STATUS_CYCLE.length];
    renderRetainer();
  });
  renderRetainer();

  // ── Tasks (catch-all, populated from ClickUp Tasks list) ──────────────────
  const TASKS = loadStore(KEYS.tasks, C.tasks || []);
  function renderTasks() {
    TASKS.sort((a, b) => parseSendDate(a.date) - parseSendDate(b.date));
    const tbody = document.getElementById('tasks-rows');
    if (!tbody) return;
    if (!TASKS.length) {
      tbody.innerHTML = emptyRow('tasks');
      document.getElementById('tasks-count').textContent = '(0)';
      saveStore(KEYS.tasks, TASKS);
      return;
    }
    tbody.innerHTML = TASKS.map((t, i) => `
      <tr data-i="${i}">
        <td class="col-client">${escapeHtml(t.name)}</td>
        <td class="col-date">${escapeHtml(t.date)}</td>
        <td class="col-status">
          <span class="st st-task-${t.status}" data-action="cycle-tasks-status" data-i="${i}" title="Click to change">
            <span class="dot"></span>${TASK_STATUS_LABEL[t.status] || t.status}
          </span>
        </td>
        <td class="col-link">
          <a class="link-btn" href="${escapeHtml(t.url || '#')}" target="_blank" rel="noopener noreferrer" aria-label="Open in ClickUp" title="Open in ClickUp">${linkIconSVG}</a>
        </td>
      </tr>`).join('');
    document.getElementById('tasks-count').textContent = '(' + TASKS.length + ')';
    saveStore(KEYS.tasks, TASKS);
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action="cycle-tasks-status"]');
    if (!t) return;
    const i = +t.dataset.i;
    const cur = TASKS[i].status;
    TASKS[i].status = TASK_STATUS_CYCLE[(TASK_STATUS_CYCLE.indexOf(cur) + 1) % TASK_STATUS_CYCLE.length];
    renderTasks();
  });
  renderTasks();

  // ── Collapsible section open/closed state (persisted) ────────
  (function initCampaignsToggle() {
    const SECTIONS = loadStore(KEYS.sections, {});
    ['forecast', 'campaigns', 'retainer'].forEach((slug) => {
      const section = document.getElementById(slug + '-section');
      const btn = document.getElementById(slug + '-toggle');
      if (!section || !btn) return;
      // Restore saved state (fall back to whatever's in the markup)
      if (Object.prototype.hasOwnProperty.call(SECTIONS, slug)) {
        const open = !!SECTIONS[slug];
        section.dataset.open = open ? 'true' : 'false';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      btn.addEventListener('click', () => {
        const open = section.dataset.open === 'true';
        section.dataset.open = open ? 'false' : 'true';
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
        SECTIONS[slug] = !open;
        saveStore(KEYS.sections, SECTIONS);
      });
    });
  })();

  // ── Notes ───────────────────────────────────────────────────────────────
  const NOTES = loadStore(KEYS.notes, C.notes || []);
  function renderNotes() {
    const wrap = document.getElementById('notes-list');
    if (!wrap) return;
    wrap.innerHTML = NOTES.map((n, i) => `
      <div class="note-item ${n.muted ? 'muted' : ''}" data-i="${i}">
        <span class="note-text" contenteditable="true" data-placeholder="Type a note…" data-action="edit-note" data-i="${i}">${escapeHtml(n.text)}</span>
        <span class="row-actions">
          <button type="button" title="Toggle muted"  data-action="mute-note" data-i="${i}">●</button>
          <button class="del" type="button" title="Delete" data-action="del-note" data-i="${i}">×</button>
        </span>
      </div>`).join('');
  }
  document.addEventListener('input', (e) => {
    const t = e.target.closest('[data-action="edit-note"]');
    if (!t) return;
    NOTES[+t.dataset.i].text = t.textContent;
    saveStore(KEYS.notes, NOTES);
  });
  document.addEventListener('click', (e) => {
    const mute = e.target.closest('[data-action="mute-note"]');
    if (mute) {
      const i = +mute.dataset.i;
      NOTES[i].muted = !NOTES[i].muted;
      saveStore(KEYS.notes, NOTES);
      renderNotes();
      return;
    }
    const del = e.target.closest('[data-action="del-note"]');
    if (del) {
      NOTES.splice(+del.dataset.i, 1);
      saveStore(KEYS.notes, NOTES);
      renderNotes();
    }
  });
  document.getElementById('add-note-btn').addEventListener('click', () => {
    NOTES.push({ text: '', muted: false });
    saveStore(KEYS.notes, NOTES);
    renderNotes();
    const wrap = document.getElementById('notes-list');
    const last = wrap && wrap.lastElementChild && wrap.lastElementChild.querySelector('.note-text');
    last && last.focus();
  });
  renderNotes();

  // ── Links ───────────────────────────────────────────────────────────────
  const LINKS = loadStore(KEYS.links, C.links || []);
  const linkRowIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg>';
  const linkOpenIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M10 14L20 4"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/></svg>';

  function renderLinks() {
    const wrap = document.getElementById('links-list');
    if (!wrap) return;
    wrap.innerHTML = LINKS.map((l, i) => {
      const safeUrl = l.url && (l.url.startsWith('http://') || l.url.startsWith('https://')) ? l.url : '#';
      return `
      <div class="link-item" data-i="${i}">
        <span class="li-icon">${linkRowIcon}</span>
        <div class="li-body">
          <span class="li-label" contenteditable="true" data-placeholder="Label" data-action="edit-link" data-i="${i}" data-key="label">${escapeHtml(l.label)}</span>
          <span class="li-url"   contenteditable="true" data-placeholder="https://…" data-action="edit-link" data-i="${i}" data-key="url">${escapeHtml(l.url)}</span>
        </div>
        <a class="li-open" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" title="Open link" aria-label="Open link">${linkOpenIcon}</a>
        <span class="row-actions">
          <button class="del" type="button" title="Delete" data-action="del-link" data-i="${i}">×</button>
        </span>
      </div>`;
    }).join('');
  }
  document.addEventListener('input', (e) => {
    const t = e.target.closest('[data-action="edit-link"]');
    if (!t) return;
    LINKS[+t.dataset.i][t.dataset.key] = t.textContent;
    saveStore(KEYS.links, LINKS);
  });
  document.addEventListener('click', (e) => {
    const del = e.target.closest('[data-action="del-link"]');
    if (!del) return;
    LINKS.splice(+del.dataset.i, 1);
    saveStore(KEYS.links, LINKS);
    renderLinks();
  });
  document.getElementById('add-link-btn').addEventListener('click', () => {
    LINKS.push({ label: '', url: '' });
    saveStore(KEYS.links, LINKS);
    renderLinks();
    const wrap = document.getElementById('links-list');
    const last = wrap && wrap.lastElementChild && wrap.lastElementChild.querySelector('.li-label');
    last && last.focus();
  });
  renderLinks();

  // ── ClickUp connection (via Cloudflare Worker proxy) ────────────────────
  // The Worker holds the ClickUp token as a secret. The dashboard only calls
  // these proxy endpoints (no token leaves the browser):
  //   GET /health
  //   GET /tree
  //   GET /tasks?list_id=...&field_id=...&value=...
  //   GET /fields?list_id=...
  const DEFAULT_PROXY = 'https://quiet-rice-6344clarity-clickup-proxy.hanfeld-matthew.workers.dev';
  const CLICKUP = loadStore(KEYS.clickup, {
    proxyUrl: DEFAULT_PROXY, workspace: '',
    campList: '', retList: '', tasksList: '', clientField: '',
  });
  if (!CLICKUP.proxyUrl) CLICKUP.proxyUrl = DEFAULT_PROXY;

  function refreshConnectStatus(state) {
    const status = document.getElementById('connect-status');
    if (!status) return;
    const ready = !!CLICKUP.proxyUrl;
    status.classList.toggle('is-connected', state === 'live');
    status.classList.toggle('is-error', state === 'error');
    const label = status.querySelector('.connect-status-label');
    if (label) {
      if (state === 'live')     label.textContent = 'Live — synced with ClickUp';
      else if (state === 'syncing') label.textContent = 'Syncing…';
      else if (state === 'error')   label.textContent = 'Connection error';
      else if (ready)               label.textContent = 'Configured — not yet synced';
      else                          label.textContent = 'Not connected';
    }
    const src = document.getElementById('tasks-source');
    if (src) {
      if (state === 'live' && CLICKUP.tasksList) src.textContent = 'Live · ClickUp list ' + CLICKUP.tasksList;
      else if (CLICKUP.tasksList)                src.textContent = 'ClickUp list · ' + CLICKUP.tasksList;
      else                                       src.textContent = 'Local only — connect ClickUp to live-sync';
    }
  }
  function logLine(msg, kind) {
    const el = document.getElementById('connect-log');
    if (!el) return;
    el.classList.remove('is-error', 'is-ok');
    if (kind === 'ok') el.classList.add('is-ok');
    if (kind === 'error') el.classList.add('is-error');
    el.innerHTML = msg;
  }
  function ensureSelectOption(sel, val) {
    if (!val) return;
    if ([...sel.options].some((o) => o.value === val)) return;
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = `(stored) ${val}`;
    sel.appendChild(opt);
  }
  function hydrateClickUpForm() {
    const map = {
      'cu-proxy': 'proxyUrl', 'cu-workspace': 'workspace',
      'cu-camp-list': 'campList', 'cu-ret-list': 'retList', 'cu-tasks-list': 'tasksList',
      'cu-client-field': 'clientField',
    };
    Object.entries(map).forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (!el) return;
      const val = CLICKUP[key] || '';
      if (el.tagName === 'SELECT') {
        ensureSelectOption(el, val);
        el.value = val;
      } else {
        el.value = val;
      }
    });
    const proxy = document.getElementById('cu-proxy');
    if (proxy && !proxy.value) proxy.value = DEFAULT_PROXY;
    const cf = document.getElementById('cu-client-field');
    if (cf && !CLICKUP.clientField && C.name) cf.placeholder = C.name;
    refreshConnectStatus();
  }
  function flashButton(id, msg) {
    const btn = document.getElementById(id);
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = msg;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1600);
  }

  // ── Proxy fetch ──
  async function cuFetch(path) {
    if (!CLICKUP.proxyUrl) throw new Error('Proxy URL not set');
    const base = CLICKUP.proxyUrl.replace(/\/+$/, '');
    const url = base + (path.startsWith('/') ? path : '/' + path);
    let res;
    try {
      res = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
    } catch (e) {
      throw new Error('Network error reaching proxy — ' + (e.message || e));
    }
    let body = null;
    try { body = await res.json(); } catch (e) {}
    if (!res.ok) {
      const msg = body && body.error ? body.error : ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return body || {};
  }

  // ── Status normalisation ──
  function normCampaignStatus(s) {
    const k = String(s || '').toLowerCase().trim();
    if (/(complete|closed|sent|deployed|live)/.test(k)) return 'sent';
    if (/scheduled|queued|approved/.test(k))            return 'scheduled';
    if (/review|approval|qa/.test(k))                   return 'review';
    if (/paus|hold/.test(k))                            return 'paused';
    return 'draft';
  }
  function normTaskStatus(s) {
    const k = String(s || '').toLowerCase().trim();
    if (/(complete|closed|done)/.test(k))    return 'done';
    if (/block/.test(k))                     return 'blocked';
    if (/review|approval|qa/.test(k))        return 'review';
    if (/progress|doing|in.?prog/.test(k))   return 'doing';
    return 'todo';
  }

  // ── Date formatting ──
  const DOWS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTH3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function formatDueDate(ms) {
    if (!ms) return '';
    const d = new Date(+ms);
    if (isNaN(d.getTime())) return '';
    const day = d.getDate().toString().padStart(2, '0');
    const base = `${DOWS[d.getDay()]} ${day} ${MONTH3[d.getMonth()]}`;
    const h0 = d.getHours();
    const m = d.getMinutes();
    if (h0 === 0 && m === 0) return base;
    const ap = h0 >= 12 ? 'pm' : 'am';
    let h = h0 % 12; if (h === 0) h = 12;
    return `${base} · ${h}:${m.toString().padStart(2, '0')}${ap}`;
  }

  // ── Client-field filter (matches proxy's trimmed customFields shape) ──
  // Returns the list of strings the task's "client" custom field(s) resolve to,
  // using `fieldDefs` to look up dropdown option names from numeric indices.
  function extractClientStrings(task, fieldDefs) {
    const out = [];
    const fields = task.customFields || [];
    for (const f of fields) {
      const name = String(f.name || '').toLowerCase();
      if (!/client/.test(name)) continue;
      const v = f.value;
      if (v == null) continue;
      const def = (fieldDefs && fieldDefs.get(f.id)) || null;
      if (def && def.type === 'drop_down' && Array.isArray(def.options)) {
        // ClickUp drop_down values are option indices (number) OR option ids (string)
        const opt = def.options[+v] || def.options.find((o) => o.id === v);
        if (opt && opt.name) out.push(String(opt.name));
      } else if (def && def.type === 'labels' && Array.isArray(def.options) && Array.isArray(v)) {
        v.forEach((idx) => {
          const opt = def.options[+idx] || def.options.find((o) => o.id === idx);
          if (opt && opt.name) out.push(String(opt.name));
        });
      } else if (typeof v === 'string' || typeof v === 'number') {
        out.push(String(v));
      } else if (Array.isArray(v)) {
        v.forEach((x) => out.push(typeof x === 'object' ? (x.name || JSON.stringify(x)) : String(x)));
      } else if (typeof v === 'object') {
        out.push(v.name || JSON.stringify(v));
      }
    }
    return out;
  }

  // Build the alias list used for matching. Combines the user's typed value
  // (comma-separated) with C.clientAliases from the client config.
  function activeClientAliases() {
    const typed = String(CLICKUP.clientField || '').split(',').map((s) => s.trim()).filter(Boolean);
    const fromConfig = Array.isArray(C.clientAliases) ? C.clientAliases.map(String) : [];
    const set = new Set([...typed, ...fromConfig].map((s) => s.toLowerCase()));
    return [...set];
  }

  function matchesAnyAlias(strings, aliases) {
    if (!aliases.length) return true;
    for (const s of strings) {
      const low = String(s).toLowerCase();
      for (const a of aliases) {
        if (low.includes(a)) return true;
      }
    }
    return false;
  }

  function mapTask(task, kind) {
    return {
      name: task.name || '(untitled)',
      date: formatDueDate(task.due),
      status: kind === 'campaign' ? normCampaignStatus(task.status) : normTaskStatus(task.status),
      url: task.url || '#',
    };
  }

  // Cache of field definitions per list, used to resolve dropdown indices.
  const FIELD_DEFS_CACHE = new Map();
  async function getFieldDefs(listId) {
    if (FIELD_DEFS_CACHE.has(listId)) return FIELD_DEFS_CACHE.get(listId);
    let map = new Map();
    try {
      const data = await cuFetch(`/fields?list_id=${encodeURIComponent(listId)}`);
      const arr = Array.isArray(data.fields) ? data.fields : [];
      arr.forEach((f) => map.set(f.id, f));
    } catch (e) { /* fall through with empty map */ }
    FIELD_DEFS_CACHE.set(listId, map);
    return map;
  }

  async function fetchList(listId, kind) {
    if (!listId) return null;
    const [data, defs] = await Promise.all([
      cuFetch(`/tasks?list_id=${encodeURIComponent(listId)}`),
      getFieldDefs(listId),
    ]);
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const aliases = activeClientAliases();
    return tasks
      .filter((t) => matchesAnyAlias(extractClientStrings(t, defs), aliases))
      .map((t) => mapTask(t, kind))
      // Hide completed task-kind rows (retainer + tasks tabs). Campaigns keep
      // their "sent" history visible because you usually want the audit trail.
      .filter((row) => kind === 'campaign' ? true : row.status !== 'done');
  }

  async function syncAll(opts) {
    const verbose = opts && opts.verbose;
    if (!CLICKUP.proxyUrl) {
      if (verbose) logLine('Paste the proxy URL first.', 'error');
      return;
    }
    refreshConnectStatus('syncing');
    if (verbose) logLine('Fetching from ClickUp…');
    try {
      const [camps, rets, tks] = await Promise.all([
        fetchList(CLICKUP.campList,  'campaign'),
        fetchList(CLICKUP.retList,   'task'),
        fetchList(CLICKUP.tasksList, 'task'),
      ]);
      const summary = [];
      if (camps) {
        CAMPAIGNS.length = 0; camps.forEach((c) => CAMPAIGNS.push(c));
        renderCampaigns();
        summary.push(`${camps.length} campaign${camps.length === 1 ? '' : 's'}`);
      }
      if (rets) {
        RETAINER.length = 0; rets.forEach((r) => RETAINER.push(r));
        renderRetainer();
        summary.push(`${rets.length} retainer task${rets.length === 1 ? '' : 's'}`);
      }
      if (tks) {
        TASKS.length = 0; tks.forEach((t) => TASKS.push(t));
        renderTasks();
        summary.push(`${tks.length} task${tks.length === 1 ? '' : 's'}`);
      }
      refreshConnectStatus('live');
      if (verbose) {
        logLine(summary.length
          ? '<strong>Synced ✓</strong> — pulled ' + summary.join(', ') + ' from ClickUp.'
          : '<strong>Synced ✓</strong> — pick a list from each dropdown above, then click Save &amp; sync.', 'ok');
      }
    } catch (err) {
      refreshConnectStatus('error');
      logLine('<strong>Sync failed</strong> — ' + escapeHtml(err.message || String(err)), 'error');
    }
  }

  async function testConnection() {
    if (!CLICKUP.proxyUrl) {
      logLine('Paste the proxy URL first.', 'error');
      flashButton('connect-test', 'Missing URL');
      return;
    }
    refreshConnectStatus('syncing');
    logLine('Pinging proxy…');
    try {
      const data = await cuFetch('/health');
      refreshConnectStatus('live');
      logLine(data.hasToken
        ? '<strong>Connected ✓</strong> — proxy reachable, ClickUp token is configured on the Worker.'
        : '<strong>Proxy reachable</strong>, but no ClickUp token is set on the Worker (<code>CLICKUP_TOKEN</code> env var).', data.hasToken ? 'ok' : 'error');
      flashButton('connect-test', data.hasToken ? 'Looks good ✓' : 'No token on Worker');
    } catch (err) {
      refreshConnectStatus('error');
      logLine('<strong>Test failed</strong> — ' + escapeHtml(err.message || String(err)), 'error');
      flashButton('connect-test', 'Failed');
    }
  }

  // ── Discovery: walks the proxy's /tree endpoint ──
  let DISCOVERED = { tree: [], workspaces: [], listsByWs: {} };

  function flattenLists(workspace) {
    const out = [];
    (workspace.spaces || []).forEach((space) => {
      const sName = space.name || ('Space ' + space.id);
      (space.lists || []).forEach((l) => out.push({ id: l.id, label: `${sName} / ${l.name}` }));
      (space.folders || []).forEach((f) => {
        const fName = f.name || ('Folder ' + f.id);
        (f.lists || []).forEach((l) => out.push({ id: l.id, label: `${sName} / ${fName} / ${l.name}` }));
      });
    });
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  function populateWorkspaceSelect(workspaces, selected) {
    const sel = document.getElementById('cu-workspace');
    if (!sel) return;
    sel.innerHTML = '<option value="">— pick a workspace —</option>' +
      workspaces.map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join('');
    if (selected && workspaces.some((w) => w.id === selected)) sel.value = selected;
    else if (workspaces.length === 1) sel.value = workspaces[0].id;
  }

  function populateListSelects(lists, current) {
    const ids = ['cu-camp-list', 'cu-ret-list', 'cu-tasks-list'];
    const opts = '<option value="">— pick a list —</option>' +
      lists.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.label)} · ${escapeHtml(l.id)}</option>`).join('');
    ids.forEach((id, i) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const want = current[i];
      sel.innerHTML = opts;
      if (want) {
        if (lists.some((l) => l.id === want)) sel.value = want;
        else { ensureSelectOption(sel, want); sel.value = want; }
      }
    });
  }

  async function discoverAll() {
    if (!CLICKUP.proxyUrl) {
      const p = document.getElementById('cu-proxy');
      CLICKUP.proxyUrl = (p && p.value.trim()) || DEFAULT_PROXY;
    }
    if (!CLICKUP.proxyUrl) {
      logLine('Paste the proxy URL, then click Discover.', 'error');
      flashButton('connect-discover', 'Need URL');
      return;
    }
    const btn = document.getElementById('connect-discover');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Discovering…'; }
    logLine('Calling proxy <code>/tree</code>…');
    refreshConnectStatus('syncing');
    try {
      const data = await cuFetch('/tree');
      const tree = Array.isArray(data.tree) ? data.tree : [];
      DISCOVERED.tree = tree;
      const workspaces = tree.map((w) => ({ id: w.id, name: w.name || ('Workspace ' + w.id) }));
      DISCOVERED.workspaces = workspaces;
      DISCOVERED.listsByWs = {};
      tree.forEach((w) => { DISCOVERED.listsByWs[w.id] = flattenLists(w); });

      if (!workspaces.length) throw new Error('Proxy returned no workspaces. Check the Worker has a valid CLICKUP_TOKEN.');

      populateWorkspaceSelect(workspaces, CLICKUP.workspace);
      const wsSel = document.getElementById('cu-workspace');
      const chosen = wsSel && wsSel.value;
      if (chosen) {
        const lists = DISCOVERED.listsByWs[chosen] || [];
        populateListSelects(lists, [CLICKUP.campList, CLICKUP.retList, CLICKUP.tasksList]);
        CLICKUP.workspace = chosen;
        saveStore(KEYS.clickup, CLICKUP);
        const wsName = (workspaces.find((w) => w.id === chosen) || {}).name || chosen;
        refreshConnectStatus('live');
        logLine('<strong>Discovered ✓</strong> — ' + workspaces.length + ' workspace' +
                (workspaces.length === 1 ? '' : 's') + ', ' + lists.length + ' list' +
                (lists.length === 1 ? '' : 's') + ' in <strong>' + escapeHtml(wsName) +
                '</strong>. Pick a list for each section, then click <strong>Save &amp; sync</strong>.', 'ok');
      } else {
        refreshConnectStatus();
        logLine('Found ' + workspaces.length + ' workspace' + (workspaces.length === 1 ? '' : 's') +
                '. Pick one above to load its lists.', 'ok');
      }
    } catch (err) {
      refreshConnectStatus('error');
      logLine('<strong>Discovery failed</strong> — ' + escapeHtml(err.message || String(err)), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔍 Discover workspace'; }
    }
  }

  // Re-load lists when the user changes workspace (uses cached tree)
  document.addEventListener('change', (e) => {
    if (!e.target.matches || !e.target.matches('#cu-workspace')) return;
    const wsId = e.target.value;
    if (!wsId) return;
    const lists = DISCOVERED.listsByWs[wsId] || [];
    populateListSelects(lists, [CLICKUP.campList, CLICKUP.retList, CLICKUP.tasksList]);
    if (lists.length) {
      logLine('<strong>Loaded ✓</strong> — ' + lists.length + ' list' +
              (lists.length === 1 ? '' : 's') + ' in this workspace.', 'ok');
    } else {
      logLine('No lists cached for this workspace yet — click Discover again.', 'error');
    }
  });

  const saveBtn = document.getElementById('connect-save');
  if (saveBtn) saveBtn.addEventListener('click', () => {
    CLICKUP.proxyUrl    = (document.getElementById('cu-proxy').value.trim()) || DEFAULT_PROXY;
    CLICKUP.workspace   = document.getElementById('cu-workspace').value.trim();
    CLICKUP.campList    = document.getElementById('cu-camp-list').value.trim();
    CLICKUP.retList     = document.getElementById('cu-ret-list').value.trim();
    CLICKUP.tasksList   = document.getElementById('cu-tasks-list').value.trim();
    CLICKUP.clientField = document.getElementById('cu-client-field').value.trim();
    saveStore(KEYS.clickup, CLICKUP);
    flashButton('connect-save', 'Saved — syncing…');
    syncAll({ verbose: true });
  });
  const testBtn = document.getElementById('connect-test');
  if (testBtn) testBtn.addEventListener('click', testConnection);
  const discBtn = document.getElementById('connect-discover');
  if (discBtn) discBtn.addEventListener('click', discoverAll);
  const syncBtn = document.getElementById('connect-sync');
  if (syncBtn) syncBtn.addEventListener('click', () => syncAll({ verbose: true }));
  const clearBtn = document.getElementById('connect-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (!confirm('Disconnect ClickUp for ' + C.name + '? Stored selections in this browser will be cleared.')) return;
    localStorage.removeItem(KEYS.clickup);
    Object.assign(CLICKUP, {
      proxyUrl: DEFAULT_PROXY, workspace: '',
      campList: '', retList: '', tasksList: '', clientField: '',
    });
    hydrateClickUpForm();
    logLine('<strong>Disconnected.</strong> Tables now show local-only data.');
  });
  hydrateClickUpForm();

  // Auto-sync on boot if at least one list is configured
  if (CLICKUP.proxyUrl && (CLICKUP.campList || CLICKUP.retList || CLICKUP.tasksList)) {
    syncAll({ verbose: false });
  }

  // ClickUp modal open/close
  (function initClickUpModal() {
    const overlay = document.getElementById('clickup-modal');
    const openBtn = document.getElementById('open-clickup');
    const closeBtn = document.getElementById('clickup-close');
    if (!overlay || !openBtn) return;
    const open  = () => { overlay.hidden = false; document.body.style.overflow = 'hidden'; };
    const close = () => { overlay.hidden = true;  document.body.style.overflow = ''; };
    openBtn.addEventListener('click', open);
    closeBtn && closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });
  })();

  // ── Reset-to-template button ────────────────────────────────────────────
  document.getElementById('reset-template').addEventListener('click', () => {
    const ok = confirm(
      'Reset this client to its template defaults?\n\n' +
      'Local edits to the funnel, campaigns, notes and links for ' + C.name + ' will be cleared. ' +
      'Other clients are untouched.'
    );
    if (!ok) return;
    clearAll();
    location.reload();
  });

  // ── Custom pages (user-added free-form tabs) ───────────────────────────
  const PAGES = loadStore(KEYS.pages, []);
  const pageTabIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h9l3 3v15H6z"/><path d="M15 3v3h3"/></svg>';

  function renderCustomTabs() {
    const tablist = document.getElementById('tabs');
    tablist.querySelectorAll('.tab-custom').forEach((el) => el.remove());
    const addBtn = document.getElementById('tab-add');
    PAGES.forEach((p) => {
      const btn = document.createElement('button');
      btn.className = 'tab tab-custom';
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', 'false');
      btn.dataset.tab = 'page-' + p.id;
      btn.innerHTML = pageTabIcon + ' <span class="tab-label">' + escapeHtml(p.name || 'Untitled') + '</span>';
      tablist.insertBefore(btn, addBtn);
    });
  }
  function renderCustomPanels() {
    const main = document.querySelector('main.page');
    main.querySelectorAll('.panel-custom').forEach((el) => el.remove());
    PAGES.forEach((p) => {
      const sec = document.createElement('section');
      sec.className = 'panel panel-custom';
      sec.id = 'panel-page-' + p.id;
      sec.setAttribute('role', 'tabpanel');
      sec.dataset.pageId = p.id;
      sec.innerHTML =
        '<div class="page-head">' +
          '<h2 class="page-title" contenteditable="true" data-action="edit-page-name" data-page-id="' + p.id + '" data-placeholder="Untitled page">' + escapeHtml(p.name || '') + '</h2>' +
          '<button class="page-del" type="button" data-action="delete-page" data-page-id="' + p.id + '" title="Delete this page">\u00d7</button>' +
        '</div>' +
        '<div class="page-content" contenteditable="true" data-action="edit-page-body" data-page-id="' + p.id + '" data-placeholder="Start writing\u2026"></div>';
      main.appendChild(sec);
      sec.querySelector('.page-content').innerHTML = p.content || '';
    });
  }
  function addPage() {
    const id = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
    PAGES.push({ id, name: 'New page', content: '' });
    saveStore(KEYS.pages, PAGES);
    renderCustomTabs();
    renderCustomPanels();
    window.__pcSelectTab('page-' + id);
    const title = document.querySelector('[data-action="edit-page-name"][data-page-id="' + id + '"]');
    if (title) {
      title.focus();
      const range = document.createRange();
      range.selectNodeContents(title);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  function deletePage(id) {
    const idx = PAGES.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const name = PAGES[idx].name || 'this page';
    if (!confirm('Delete "' + name + '"? This can\'t be undone.')) return;
    PAGES.splice(idx, 1);
    saveStore(KEYS.pages, PAGES);
    renderCustomTabs();
    renderCustomPanels();
    window.__pcSelectTab('home');
  }
  document.addEventListener('input', (e) => {
    const name = e.target.closest('[data-action="edit-page-name"]');
    if (name) {
      const page = PAGES.find((p) => p.id === name.dataset.pageId);
      if (page) {
        page.name = name.textContent;
        saveStore(KEYS.pages, PAGES);
        const lab = document.querySelector('#tabs .tab[data-tab="page-' + page.id + '"] .tab-label');
        if (lab) lab.textContent = page.name || 'Untitled';
      }
      return;
    }
    const body = e.target.closest('[data-action="edit-page-body"]');
    if (body) {
      const page = PAGES.find((p) => p.id === body.dataset.pageId);
      if (page) { page.content = body.innerHTML; saveStore(KEYS.pages, PAGES); }
    }
  });
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action="delete-page"]');
    if (!t) return;
    deletePage(t.dataset.pageId);
  });
  renderCustomTabs();
  renderCustomPanels();

  // Restore tab from URL hash now that all tabs (including custom) exist
  const fromHash = location.hash.replace('#', '');
  if (fromHash) {
    const exists = [...document.querySelectorAll('#tabs .tab:not(.tab-add)')].some((t) => t.dataset.tab === fromHash);
    if (exists) window.__pcSelectTab(fromHash);
  }
})();
