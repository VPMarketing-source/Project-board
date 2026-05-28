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
];
