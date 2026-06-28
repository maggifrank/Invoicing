// src/components/toast.js

export function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  if (!el) return;

  // Clear any existing timer stored on the element
  if (el._toastTimer) {
    clearTimeout(el._toastTimer);
    el._toastTimer = null;
  }

  // Wire click-to-dismiss once
  if (!el._toastWired) {
    el.addEventListener('click', () => {
      el.classList.remove('show');
      if (el._toastTimer) { clearTimeout(el._toastTimer); el._toastTimer = null; }
    });
    el._toastWired = true;
  }

  el.textContent = msg;
  el.className   = `toast ${type} show`;

  el._toastTimer = setTimeout(() => {
    el.classList.remove('show');
    el._toastTimer = null;
  }, 3000);
}
