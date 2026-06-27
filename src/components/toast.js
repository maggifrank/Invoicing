// src/components/toast.js

let _timer    = null;
let _wired    = false;

export function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  if (!el) return;

  // Wire up click-to-dismiss once
  if (!_wired) {
    el.addEventListener('click', () => dismiss(el));
    _wired = true;
  }

  el.textContent         = msg;
  el.className           = `toast ${type} show`;
  el.style.pointerEvents = 'auto';
  clearTimeout(_timer);
  _timer = setTimeout(() => dismiss(el), 3000);
}

function dismiss(el) {
  el.classList.remove('show');
  el.style.pointerEvents = 'none';
}
