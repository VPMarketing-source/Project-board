/* =========================================================================
   Project Clarity — client roster
   Single source of truth for which clients exist and where their pages live.
   Read by:
     - shared/nav.js     (top-of-page client switcher)
     - index.html        (home page tile grid)

   To add a client:
     1. Copy clients/_template.html → clients/<slug>.html and edit CLIENT_DATA
     2. Add a row below

   Each entry mirrors enough of CLIENT_DATA to render a tile without having
   to fetch each client's HTML.
   ========================================================================= */
window.CLIENTS_REGISTRY = [
  {
    id:       'vpm',
    name:     'Personal Planner',
    initials: 'MH',
    sub:      'Planner',
    href:     'clients/vpm.html',
    accent:   '#a86b14',
  },
  {
    id:       'mlc',
    name:     'MLC',
    initials: 'ML',
    sub:      'Melbourne Leather Co · Email marketing',
    href:     'clients/mlc.html',
    accent:   '#7a4b1f',
  },
  {
    id:       'linen',
    name:     'Linen Connections',
    initials: 'LC',
    sub:      '',
    href:     'clients/linen.html',
    accent:   '#b8a07a',
  },
  {
    id:       'boho',
    name:     'Boho Eclectica',
    initials: 'BE',
    sub:      '',
    href:     'clients/boho.html',
    accent:   '#8a4a7a',
  },
  {
    id:       'fudge',
    name:     'Fudge Lifestyle',
    initials: 'FL',
    sub:      '',
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
    id:       'orro',
    name:     'Orro and Co',
    initials: 'OC',
    sub:      '',
    href:     'clients/orro.html',
    accent:   '#c9941a',
  },
  {
    id:       'qubik',
    name:     'Qubik Accounting',
    initials: 'QA',
    sub:      '',
    href:     'clients/qubik.html',
    accent:   '#2a5080',
  },
  {
    id:       'jan-legal',
    name:     'Jan Legal',
    initials: 'JL',
    sub:      '',
    href:     'clients/jan-legal.html',
    accent:   '#1c3458',
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
