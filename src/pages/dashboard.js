// src/pages/dashboard.js
// Shows current cycle stats per client and countdown to 22nd/25th.

import { sb } from '../supabase.js';
import { currentUser } from '../auth.js';
import {
  getCycleForDate, isoDate, cyclePeriodLabel,
  formatDuration, escHtml,
} from '../utils.js';

export async function mount(container, profile) {
  container.innerHTML = loadingHTML();

  if (!issuerComplete(profile)) {
    container.innerHTML = `
      <div class="warning-banner">
        ⚠️ Your issuer details are incomplete.
        Go to <strong>Settings</strong> to fill them in before generating invoices.
      </div>
    ` + loadingHTML();
  }

  const cycleStartDay = profile?.cycle_start_day ?? 21;
  const { start, end } = getCycleForDate(new Date(), cycleStartDay);
  const cycleStartISO = isoDate(start);
  const cycleEndISO   = isoDate(end);

  // Fetch active clients
  const { data: clients } = await sb
    .from('clients')
    .select('*')
    .eq('user_id', currentUser.id)
    .eq('archived', false)
    .order('name', { ascending: true });

  if (!clients?.length) {
    container.innerHTML = `
      ${!issuerComplete(profile) ? `<div class="warning-banner">⚠️ Your issuer details are incomplete. Go to <strong>Settings</strong> to fill them in.</div>` : ''}
      <div class="empty">
        <div class="empty-icon">👥</div>
        No clients yet.<br>Add your first client under <strong>Clients</strong>.
      </div>`;
    return;
  }

  // Fetch uninvoiced entries for current cycle grouped by client
  const { data: entries } = await sb
    .from('entries')
    .select('client_id, minutes')
    .eq('user_id', currentUser.id)
    .gte('date', cycleStartISO)
    .lte('date', cycleEndISO)
    .is('invoice_id', null);

  // Build per-client minute totals
  const minutesByClient = {};
  (entries ?? []).forEach(e => {
    if (!e.client_id) return;
    minutesByClient[e.client_id] = (minutesByClient[e.client_id] ?? 0) + e.minutes;
  });

  // Countdown days
  const today     = new Date();
  const draftDay  = daysUntil(today, 22);
  const sendDay   = daysUntil(today, 25);
  const cycleLabel = cyclePeriodLabel(cycleStartISO, cycleEndISO);

  let html = `
    ${!issuerComplete(profile) ? `<div class="warning-banner">⚠️ Your issuer details are incomplete. Go to <strong>Settings</strong> to fill them in.</div>` : ''}

    <div class="countdown-row">
      <div class="countdown-pill">
        <div class="countdown-days ${draftDay <= 3 ? 'amber' : ''}">${draftDay}</div>
        <div class="countdown-label">days to draft (22nd)</div>
      </div>
      <div class="countdown-pill">
        <div class="countdown-days ${sendDay <= 3 ? 'amber' : ''}">${sendDay}</div>
        <div class="countdown-label">days to invoice (25th)</div>
      </div>
    </div>

    <div class="section-label" style="margin-bottom:0.75rem">
      Current cycle · ${escHtml(cycleLabel)}
    </div>
  `;

  clients.forEach(client => {
    const mins      = minutesByClient[client.id] ?? 0;
    const hours     = mins / 60;
    const amount    = Math.round(hours * client.hourly_rate);
    const hasWork   = mins > 0;
    const complete  = !!(client.email && client.email !== 'incomplete@placeholder.is' &&
                         client.hourly_rate > 0 &&
                         (client.bank_account || profile?.bank_account));

    html += `
      <div class="client-cycle-card">
        <div class="client-cycle-header">
          <span class="client-cycle-name">
            ${escHtml(client.name)}
            ${!complete ? '<span class="badge badge-amber" style="margin-left:0.4rem">incomplete</span>' : ''}
          </span>
          <span class="client-cycle-amount">${hasWork && complete ? fmtISK(amount) : '—'}</span>
        </div>
        <div class="client-cycle-meta">
          ${hasWork
            ? `<span>${formatDuration(mins)}</span>
               <span>·</span>
               <span>${client.hourly_rate > 0 ? fmtISKRate(client.hourly_rate) + '/klst' : 'No rate set'}</span>`
            : `<span style="color:var(--text3)">No entries this cycle</span>`
          }
        </div>
        ${!complete ? `
        <div style="font-size:0.75rem;color:var(--amber);margin-top:0.4rem">
          Complete billing details in Clients before invoicing.
        </div>` : ''}
        ${hasWork && complete ? `
        <div class="client-cycle-actions">
          <button class="btn-xs btn-xs-outline"
            onclick="window.previewInvoice('${client.id}', false)">
            👁 Preview
          </button>
          <button class="btn-xs btn-xs-amber"
            onclick="window.previewInvoice('${client.id}', true)">
            ✉ Send draft to me
          </button>
          <button class="btn-xs btn-xs-green"
            onclick="window.sendRealInvoice('${client.id}')">
            ⚡ Send invoice
          </button>
        </div>` : ''}
      </div>
    `;
  });

  container.innerHTML = html;
}

function daysUntil(from, dayOfMonth) {
  const target = new Date(from.getFullYear(), from.getMonth(), dayOfMonth);
  if (target <= from) target.setMonth(target.getMonth() + 1);
  return Math.ceil((target - from) / (1000 * 60 * 60 * 24));
}

function issuerComplete(profile) {
  return !!(profile?.issuer_name && profile?.issuer_kennitala &&
            profile?.issuer_address && profile?.issuer_email &&
            profile?.bank_account);
}

function fmtISK(n) {
  return Number(n).toLocaleString('is-IS') + ' ISK';
}

function fmtISKRate(n) {
  return Number(n).toLocaleString('is-IS') + ' ISK';
}

function loadingHTML() {
  return `<div class="empty"><span class="spinner" style="border-top-color:var(--accent);color:var(--border)"></span></div>`;
}
