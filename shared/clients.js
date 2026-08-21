/* =========================================================================
   Project Clarity — client roster
   Single source of truth for which clients exist and where their pages live.
   Read by:
     - shared/nav.js     (top-of-page client switcher)
     - index.html        (home page tile grid)

   To add a client:
     1. Copy clients/_template.html → clients/<slug>.html and edit CLIENT_DATA
     2. Add a row below

   { divider: true } entries split the list into visual groups on the home
   page and in the client switcher. Add as many as you like.

   Clients added with the "+ Add client" button on the home page are NOT
   listed here — they can't be, since a browser can't write to this file.
   They live in Supabase and are merged in at runtime by PC_REGISTRY below.
   ========================================================================= */
window.CLIENTS_REGISTRY = [
  {
    id:       'vpm',
    name:     'Personal',
    initials: 'MH',
    sub:      '',
    href:     'clients/vpm.html',
    accent:   '#a86b14',
    pinned:   true,
  },
  {
    id:       'personal-planner',
    name:     'Personal Planner',
    initials: 'PP',
    sub:      '',
    href:     'clients/personal-planner.html',
    accent:   '#5b4bb0',
    pinned:   true,
  },
  {
    id:       'vpmarketing',
    name:     'VP Marketing',
    initials: 'VP',
    sub:      'Agency · Quarterly priorities',
    href:     'clients/vpmarketing.html',
    accent:   '#2960ff',
    pinned:   true,
  },
  {
    id:       'weekly',
    name:     'Clients',
    initials: 'CL',
    sub:      'Mon–Sun template',
    href:     'clients/weekly.html',
    accent:   '#1c6e72',
    pinned:   true,
  },
  {
    id:       'linen',
    name:     'Linen Connections',
    initials: 'LC',
    sub:      'Handcrafted linen · Email marketing',
    href:     'clients/linen.html',
    accent:   '#b8a07a',
  },
  {
    id:       'fudge',
    name:     'Fudge Lifestyle',
    initials: 'FL',
    sub:      'Womens clothing · Email marketing',
    href:     'clients/fudge.html',
    accent:   '#6b4a2a',
  },
  {
    id:       'eskimo',
    name:     'Eskimo Heat',
    initials: 'EH',
    sub:      '',
    href:     'clients/eskimo.html',
    accent:   '#2a7080',
  },
  {
    id:       'jan-legal',
    name:     'Jan Legal',
    initials: 'JL',
    sub:      'Legal services',
    href:     'clients/jan-legal.html',
    accent:   '#1c3458',
  },
  {
    id:       'mlc',
    name:     'Melbourne Leather Co',
    initials: 'ML',
    sub:      'Email marketing',
    href:     'clients/mlc.html',
    accent:   '#7a4b1f',
  },
  {
    id:       'boho',
    name:     'Boho Eclectica',
    initials: 'BE',
    sub:      'Bohemian fashion · Email marketing',
    href:     'clients/boho.html',
    accent:   '#8a4a7a',
  },

  { divider: true },

  {
    id:       'orro',
    name:     'Orro and Co',
    initials: 'OC',
    sub:      'Fashion · Email marketing',
    href:     'clients/orro.html',
    accent:   '#c9941a',
  },
  {
    id:       'qubik',
    name:     'Qubik Accounting',
    initials: 'QA',
    sub:      'Accounting · Strategic consultancy',
    href:     'clients/qubik.html',
    accent:   '#2a5080',
  },
  {
    id:       'elite',
    name:     'Elite Collectors',
    initials: 'EC',
    sub:      '',
    href:     'clients/elite.html',
    accent:   '#7a2a3a',
  },
];

/* =========================================================================
   PC_REGISTRY — built-in clients above + clients added from the UI.

   A page served from a static host can't write to this file, so clients
   created with the "+ Add client" button are stored as a single row in
   Supabase (client_id '__registry') and cached in localStorage so the list
   paints instantly and still works offline. They render through the generic
   clients/space.html?id=<slug> page rather than a file of their own.

   Custom entries carry custom:true. Nothing here can modify or remove a
   built-in client — those are owned by the array above.
   ========================================================================= */
window.PC_REGISTRY = (function () {
  const SUPABASE_URL = 'https://rqlrpxxkskqxpjgiqyql.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxbHJweHhrc2txeHBqZ2lxeXFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5Mjc3OTYsImV4cCI6MjA5NTUwMzc5Nn0.RG7fzJxp_SoSMNxHlkfLgrAx7ycupmt0jEDm3q9XHBE';
  const ROW_CLIENT = '__registry';
  const ROW_KEY    = 'pc-ops::registry::custom::v1';
  const CACHE_KEY  = 'pc-ops::registry::cache::v1';

  const BUILT_IN = window.CLIENTS_REGISTRY || [];

  function headers(extra) {
    return Object.assign({
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
    }, extra || {});
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function writeCache(list) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(list)); } catch (_) {}
  }

  /* Every id already in use, so a new one can't collide. Includes ids that
     exist only as data (e.g. 'new-client', created by an old template copy)
     — reusing one of those would silently adopt that client's stored data. */
  const RESERVED = ['new-client', '__registry', 'vpm'];
  function takenIds(custom) {
    return new Set(
      BUILT_IN.filter((c) => !c.divider).map((c) => c.id)
        .concat((custom || readCache()).map((c) => c.id))
        .concat(RESERVED)
    );
  }

  function slugify(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
  }

  function uniqueSlug(name, custom) {
    const taken = takenIds(custom);
    const base = slugify(name) || 'client';
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) {
      if (!taken.has(base + '-' + i)) return base + '-' + i;
    }
    return base + '-' + Date.now();
  }

  function initialsFor(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '??';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function normalise(entry) {
    return {
      id:       entry.id,
      name:     entry.name || entry.id,
      initials: entry.initials || initialsFor(entry.name),
      sub:      entry.sub || '',
      accent:   entry.accent || '#6c6f7a',
      href:     'clients/space.html?id=' + encodeURIComponent(entry.id),
      custom:   true,
    };
  }

  async function fetchCustom() {
    const url = SUPABASE_URL + '/rest/v1/planner_state?select=value' +
                '&client_id=eq.' + encodeURIComponent(ROW_CLIENT) +
                '&key=eq.' + encodeURIComponent(ROW_KEY);
    const r = await fetch(url, { headers: headers() });
    if (!r.ok) throw new Error('registry fetch ' + r.status);
    const rows = await r.json();
    if (!rows || !rows.length) return [];
    const raw = rows[0].value && rows[0].value.raw;
    if (typeof raw !== 'string') return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(normalise) : [];
  }

  async function saveCustom(list) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/planner_state?on_conflict=client_id,key', {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' }),
      body: JSON.stringify([{
        client_id: ROW_CLIENT,
        key: ROW_KEY,
        value: { raw: JSON.stringify(list) },
        updated_at: new Date().toISOString(),
      }]),
    });
    if (!r.ok) throw new Error('registry save ' + r.status);
    writeCache(list);
  }

  /* Built-ins first, then a divider, then custom clients — so added
     clients are visually distinct from the hand-maintained roster. */
  function merge(custom) {
    if (!custom || !custom.length) return BUILT_IN.slice();
    return BUILT_IN.concat([{ divider: true }], custom);
  }

  return {
    /* Synchronous, cache-only. Use to paint immediately on load. */
    cached() { return merge(readCache()); },
    cachedCustom() { return readCache(); },

    /* Authoritative. Refreshes the cache; falls back to cache when offline. */
    async load() {
      try {
        const custom = await fetchCustom();
        writeCache(custom);
        return merge(custom);
      } catch (_) {
        return merge(readCache());
      }
    },

    async add({ name, sub, accent }) {
      const clean = String(name || '').trim();
      if (!clean) throw new Error('Name is required');
      let custom;
      try { custom = await fetchCustom(); } catch (_) { custom = readCache(); }
      const entry = normalise({
        id: uniqueSlug(clean, custom),
        name: clean,
        sub: String(sub || '').trim(),
        accent: accent || '#6c6f7a',
      });
      const next = custom.concat([entry]);
      await saveCustom(next);
      return entry;
    },

    async remove(id) {
      let custom;
      try { custom = await fetchCustom(); } catch (_) { custom = readCache(); }
      // Only ever removes the registry entry. The client's own planner rows
      // are left untouched, so re-adding the same slug restores its data.
      await saveCustom(custom.filter((c) => c.id !== id));
    },

    find(id) {
      return merge(readCache()).find((c) => !c.divider && c.id === id) || null;
    },

    slugify,
    initialsFor,
  };
})();
