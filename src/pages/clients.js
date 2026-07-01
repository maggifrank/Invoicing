// src/pages/clients.js

import { sb } from '../supabase.js';
import { currentUser } from '../auth.js';
import { showToast } from '../components/toast.js';
import { setLoading } from '../components/spinner.js';
import { escHtml } from '../utils.js';

let _profile = {};

export async function mount(container, profile) {
  _profile = profile ?? {};
  container.innerHTML = loadingHTML();

  const { data, error } = await sb
    .from('clients')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('name', { ascending: true });

  if (error) { container.innerHTML = '<div class="empty">Failed to load clients.</div>'; return; }

  // Check which clients have entries or invoices
  const { data: usedEntries } = await sb
    .from('entries')
    .select('client_id')
    .eq('user_id', currentUser.id);

  const { data: usedInvoices } = await sb
    .from('invoices')
    .select('client_id')
    .eq('user_id', currentUser.id);

  const usedClientIds = new Set([
    ...(usedEntries ?? []).map(e => e.client_id),
    ...(usedInvoices ?? []).map(i => i.client_id),
  ]);

  const active   = (data ?? []).filter(c => !c.archived);
  const archived = (data ?? []).filter(c => c.archived);
  const showArchived = container.dataset.showArchived === 'true';

  let html = `<button class="btn btn-primary" style="margin-bottom:1rem"
    onclick="window.openClientModal()">+ New client</button>`;

  if (!active.length && !archived.length) {
    html += `<div class="empty"><div class="empty-icon">👥</div>No clients yet.</div>`;
  }

  active.forEach(c => { html += clientCardHTML(c, usedClientIds.has(c.id)); });

  if (archived.length) {
    html += `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:1.25rem;margin-bottom:0.75rem">
        <span class="section-label" style="margin:0">Archived</span>
        <button class="btn-xs btn-xs-outline" onclick="window.toggleArchivedClients()">
          ${showArchived ? 'Hide' : `Show (${archived.length})`}
        </button>
      </div>`;
    if (showArchived) {
      archived.forEach(c => { html += clientCardHTML(c, usedClientIds.has(c.id)); });
    }
  }

  container.innerHTML = html;
  container.dataset.showArchived = showArchived;
}

function isClientComplete(c) {
  return !!(c.email && c.email !== 'incomplete@placeholder.is' &&
            c.invoice_prefix && c.hourly_rate > 0 &&
            (c.bank_account || _profile?.bank_account));
}

function clientCardHTML(c, isUsed) {
  const complete = isClientComplete(c);
  const canDelete = !isUsed;
  return `
    <div class="client-card" onclick="window.openClientModal('${c.id}')">
      <div class="client-card-header">
        <span class="client-card-name">${escHtml(c.name)}</span>
        <span class="client-card-rate">${c.hourly_rate > 0 ? Number(c.hourly_rate).toLocaleString('is-IS') + ' ISK/klst' : '—'}</span>
      </div>
      <div class="client-card-meta">
        <span class="badge badge-accent">${escHtml(c.invoice_prefix)}</span>
        <span>${escHtml(c.email === 'incomplete@placeholder.is' ? 'No email set' : c.email)}</span>
        ${!complete ? '<span class="badge badge-amber">incomplete</span>' : ''}
        ${c.archived ? '<span class="badge badge-red">archived</span>' : ''}
        ${canDelete ? `
          <button class="btn-xs btn-xs-outline" style="margin-left:auto;color:var(--red);border-color:rgba(224,92,92,0.3)"
            onclick="event.stopPropagation();window.deleteClient('${c.id}', '${escHtml(c.name)}')">
            Delete
          </button>` : ''}
      </div>
    </div>
  `;
}

// ── Modal ──────────────────────────────────────────────────────
export function openClientModal(id) {
  clearModal();
  document.getElementById('client-modal-title').textContent = id ? 'Edit Client' : 'New Client';
  document.getElementById('cm-archive-btn').style.display   = id ? 'block' : 'none';
  document.getElementById('client-modal').classList.add('open');

  // Pre-fill defaults from profile for new clients
  if (!id) {
    document.getElementById('cm-prefix').value  = _profile.invoice_prefix || '';
    document.getElementById('cm-rate').value    = _profile.default_rate   || '';
    document.getElementById('cm-counter').value = '1001';
    return;
  }

  loadClientIntoModal(id);
}

async function loadClientIntoModal(id) {
  const { data } = await sb.from('clients').select('*').eq('id', id).single();
  if (!data) return;
  document.getElementById('cm-id').value          = data.id;
  document.getElementById('cm-name').value        = data.name           || '';
  document.getElementById('cm-address').value     = data.address        || '';
  document.getElementById('cm-city').value        = data.city           || '';
  document.getElementById('cm-kennitala').value   = data.kennitala      || '';
  document.getElementById('cm-email').value       = data.email          || '';
  document.getElementById('cm-prefix').value      = data.invoice_prefix || '';
  document.getElementById('cm-counter').value     = data.invoice_counter|| '';
  document.getElementById('cm-rate').value        = data.hourly_rate    || '';
  document.getElementById('cm-km-rate').value          = data.km_rate        || '';
  document.getElementById('cm-show-time-range').checked = data.show_time_range !== false;
  document.getElementById('cm-bank-account').value= data.bank_account   || '';
  document.getElementById('cm-utibú').value       = data.bank_utibú     || '';
  document.getElementById('cm-hb').value          = data.bank_hb        || '';
  document.getElementById('cm-reikningur').value  = data.bank_reikningur|| '';

  document.getElementById('cm-archive-btn').onclick = () => archiveClient(data.id, !data.archived);
  document.getElementById('cm-archive-btn').textContent = data.archived ? 'Unarchive client' : 'Archive client';
}

function clearModal() {
  ['cm-id','cm-name','cm-address','cm-city','cm-kennitala','cm-email',
   'cm-prefix','cm-counter','cm-rate','cm-bank-account','cm-utibú','cm-hb','cm-reikningur']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

export async function saveClient() {
  const id    = document.getElementById('cm-id').value;
  const name  = document.getElementById('cm-name').value.trim();
  const email = document.getElementById('cm-email').value.trim();
  const btn   = document.getElementById('cm-save-btn');

  if (!name)  { shake('cm-name');  return; }
  if (!email) { shake('cm-email'); return; }

  setLoading(btn, true, 'Saving…');

  const payload = {
    user_id:         currentUser.id,
    name,
    address:         document.getElementById('cm-address').value.trim()      || null,
    city:            document.getElementById('cm-city').value.trim()          || null,
    kennitala:       document.getElementById('cm-kennitala').value.trim()     || null,
    email,
    invoice_prefix:  document.getElementById('cm-prefix').value.trim()       || 'INV',
    invoice_counter: parseInt(document.getElementById('cm-counter').value)    || 1001,
    hourly_rate:     parseInt(document.getElementById('cm-rate').value)       || (_profile.default_rate ?? 0),
    km_rate:         parseInt(document.getElementById('cm-km-rate').value)     || null,
    show_time_range: document.getElementById('cm-show-time-range').checked,
    bank_account:    document.getElementById('cm-bank-account').value.trim()  || null,
    bank_utibú:      document.getElementById('cm-utibú').value.trim()         || null,
    bank_hb:         document.getElementById('cm-hb').value.trim()            || null,
    bank_reikningur: document.getElementById('cm-reikningur').value.trim()    || null,
  };

  let error;
  if (id) {
    ({ error } = await sb.from('clients').update(payload).eq('id', id).eq('user_id', currentUser.id));
  } else {
    ({ error } = await sb.from('clients').insert(payload));
  }

  setLoading(btn, false, 'Save client');
  if (error) { showToast('Could not save client', 'error'); return; }

  showToast(id ? 'Client updated' : 'Client added');
  closeModal('client-modal');
  // Re-mount the page
  const container = document.getElementById('page-clients');
  if (container) mount(container, _profile);
}

async function archiveClient(id, archive) {
  const { error } = await sb
    .from('clients')
    .update({ archived: archive })
    .eq('id', id)
    .eq('user_id', currentUser.id);

  if (error) { showToast('Could not update client', 'error'); return; }
  showToast(archive ? 'Client archived' : 'Client unarchived');
  closeModal('client-modal');
  const container = document.getElementById('page-clients');
  if (container) mount(container, _profile);
}

function shake(id) {
  const el = document.getElementById(id);
  el.classList.add('error'); el.focus();
  setTimeout(() => el.classList.remove('error'), 1500);
}

function loadingHTML() {
  return `<div class="empty"><span class="spinner" style="border-top-color:var(--accent);color:var(--border)"></span></div>`;
}
