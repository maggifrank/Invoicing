// src/components/spinner.js

export function setLoading(btn, loading, label) {
  if (loading) {
    btn.disabled     = true;
    btn._label       = btn.textContent;
    btn.innerHTML    = `<span class="spinner"></span>${label ?? ''}`;
  } else {
    btn.disabled     = false;
    btn.textContent  = label ?? btn._label ?? '';
  }
}
