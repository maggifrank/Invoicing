// src/main.js

import { sb, ENV, COMPANION_URL } from './supabase.js';
import { initAuth, signOut, mountAuthUI, currentUser } from './auth.js';
import { register, start, navigate } from './router.js';
import { showToast } from './components/toast.js';
import { setLoading } from './components/spinner.js';

import * as DashboardPage from './pages/dashboard.js';
import * as ClientsPage   from './pages/clients.js';
import * as InvoicesPage  from './pages/invoices.js';
import * as SettingsPage  from './pages/settings.js';

// ── Profile ────────────────────────────────────────────────────
let profile = {};

async function loadProfile() {
  const { data } = await sb
    .from('profiles')
    .select('*')
    .eq('id', currentUser.id)
    .maybeSingle();
  profile = data ?? {};
}

// ── Page helpers ───────────────────────────────────────────────
function activatePage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

// ── Routes ─────────────────────────────────────────────────────
function setupRoutes() {
  register('/', () => {
    activatePage('page-dashboard');
    DashboardPage.mount(document.getElementById('page-dashboard'), profile);
  });

  register('/clients', () => {
    activatePage('page-clients');
    ClientsPage.mount(document.getElementById('page-clients'), profile);
  });

  register('/invoices', () => {
    activatePage('page-invoices');
    InvoicesPage.mount(document.getElementById('page-invoices'));
  });

  register('/settings', () => {
    activatePage('page-settings');
    SettingsPage.mount(document.getElementById('page-settings'), profile);
  });
}

// ── Global actions (called from HTML onclick) ──────────────────
window.openClientModal  = (id) => ClientsPage.openClientModal(id);
window.saveClient       = ()   => ClientsPage.saveClient();

window.deleteClient = async (id, name) => {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  const { error } = await sb.from('clients').delete().eq('id', id).eq('user_id', currentUser.id);
  if (error) { showToast('Could not delete client', 'error'); return; }
  showToast('Client deleted');
  const container = document.getElementById('page-clients');
  if (container) ClientsPage.mount(container, profile);
};

window.toggleArchivedClients = () => {
  const container = document.getElementById('page-clients');
  if (!container) return;
  container.dataset.showArchived = container.dataset.showArchived === 'true' ? 'false' : 'true';
  ClientsPage.mount(container, profile);
};
window.saveSettings     = ()   => SettingsPage.saveSettings(profile);
window.updateCyclePreview = () => SettingsPage.updateCyclePreview();

window.sendInvite = async () => {
  const email = document.getElementById('s-invite-email')?.value.trim();
  if (!email) { showToast('Enter an email address', 'error'); return; }
  const btn = document.getElementById('s-invite-btn');
  setLoading(btn, true, 'Sending…');
  try {
    const res  = await fetch('/.netlify/functions/invite-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Unknown error');
    showToast(`Invite sent to ${email}`);
    document.getElementById('s-invite-email').value = '';
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    setLoading(btn, false, 'Send invite');
  }
};
window.closeModal = (id) => document.getElementById(id)?.classList.remove('open');

window.viewInvoicePDF = (invoiceId, pdfPath, invoiceNumber) =>
  InvoicesPage.viewInvoicePDF(invoiceId, pdfPath, invoiceNumber);

// Preview invoice — generates PDF via function and shows in modal
window.previewInvoice = async (clientId, sendDraft) => {
  const btn = document.querySelector(`[onclick*="previewInvoice('${clientId}'"]`);
  showToast('Generating preview…');

  try {
    const res  = await fetch('/.netlify/functions/generate-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        userId:    currentUser.id,
        isDraft:   true,
        sendEmail: sendDraft,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Unknown error');

    if (sendDraft) {
      showToast('Draft sent to ' + (profile.preview_email || 'your preview email'));
      return;
    }

    // Show in PDF modal
    document.getElementById('pdf-modal-title').textContent = json.invoiceNumber + ' (DRAFT)';
    document.getElementById('pdf-frame').src = json.signedUrl;
    document.getElementById('pdf-send-draft-btn').style.display = 'block';
    document.getElementById('pdf-send-draft-btn').onclick = () => window.previewInvoice(clientId, true);
    document.getElementById('pdf-modal').classList.add('open');

  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
};

// Send real invoice for a client
window.sendRealInvoice = async (clientId) => {
  if (!confirm('Send the real invoice for this client now? This cannot be undone.')) return;

  showToast('Sending invoice…');
  try {
    const res  = await fetch('/.netlify/functions/generate-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        userId:    currentUser.id,
        isDraft:   false,
        sendEmail: true,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Unknown error');

    showToast('Invoice sent ✓');
    // Refresh dashboard
    DashboardPage.mount(document.getElementById('page-dashboard'), profile);

  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
};

// ── Auth lifecycle ─────────────────────────────────────────────
async function onSignedIn(user) {
  await loadProfile();
  document.getElementById('auth-screen').style.display   = 'none';
  document.getElementById('app-screen').style.display    = 'block';
  document.getElementById('loading-overlay').style.display = 'none';

  document.getElementById('topbar-user').textContent = user.email;
  const companion = document.getElementById('nav-companion');
  if (companion) companion.href = COMPANION_URL;
  const badge = document.getElementById('env-badge');
  if (ENV === 'dev') { badge.textContent = 'dev'; badge.className = 'env-badge dev'; }
  else badge.className = 'env-badge';

  setupRoutes();
  start('/');
}

function onSignedOut() {
  document.getElementById('auth-screen').style.display   = 'flex';
  document.getElementById('app-screen').style.display    = 'none';
  document.getElementById('loading-overlay').style.display = 'none';
}

// ── Boot ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  mountAuthUI();
  document.getElementById('topbar-signout')?.addEventListener('click', signOut);

  // Close modals on backdrop click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });

  initAuth(onSignedIn, onSignedOut);
});
