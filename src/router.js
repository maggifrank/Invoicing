// src/router.js
// Path-based client-side router.
// Netlify redirects all paths to index.html (see netlify.toml).

const _routes  = {};
let   _current = null;

export function register(path, handler) {
  _routes[path] = handler;
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else         history.pushState({}, '', path);
  _dispatch(path);
}

export function start(fallback = '/') {
  window.addEventListener('popstate', () => _dispatch(location.pathname));

  // Intercept in-app nav link clicks
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-route]');
    if (!a) return;
    e.preventDefault();
    navigate(a.dataset.route);
  });

  _dispatch(location.pathname || fallback);
}

function _dispatch(path) {
  const handler = _routes[path] ?? _routes['/'];
  if (!handler) return;
  _current = path;
  handler(path);

  // Keep bottom nav in sync
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.route === path);
  });
}

export function currentPath() { return _current; }
