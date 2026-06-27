// src/components/toast.js

let _timer = null;

export function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className   = `toast ${type} show`;
  el.style.pointerEvents = 'auto';
  clearTimeout(_timer);
  _timer = setTimeout(() => dismiss(el), 3000);
}

function dismiss(el) {
  el.classList.remove('show');
  el.style.pointerEvents = 'none';
}

// Wire up click-to-dismiss once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('toast');
  if (el) el.addEventListener('click', () => dismiss(el));
});
