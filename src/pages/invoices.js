// src/pages/invoices.js

import { sb } from '../supabase.js';
import { currentUser } from '../auth.js';
import { showToast } from '../components/toast.js';
import { escHtml } from '../utils.js';

export async function mount(container) {
  container.innerHTML = loadingHTML();

  const { data, error } = await sb
    .from('invoices')
    .select('*, clients(name)')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  if (error) { container.innerHTML = '<div class="empty">Failed to load invoices.</div>'; return; }
  if (!data?.length) {
    container.innerHTML = '<div class="empty"><div class="empty-icon">📄</div>No invoices yet.</div>';
    return;
  }

  const drafts = data.filter(inv => inv.is_draft);
  const real   = data.filter(inv => !inv.is_draft);

  let html = '';

  if (drafts.length) {
    html += `
      <div class="period-block" id="invoices-drafts">
        <div class="period-header">
          <span class="period-label">Drafts</span>
          <div class="period-meta">
            <span class="period-total">${drafts.length}</span>
            <span class="period-chevron">▼</span>
          </div>
        </div>
        <div class="period-body">
          ${drafts.map(inv => invoiceCardHTML(inv, data)).join('')}
        </div>
      </div>
    `;
  }

  if (real.length) {
    html += `
      <div class="period-block" id="invoices-real">
        <div class="period-header">
          <span class="period-label">Invoices</span>
          <div class="period-meta">
            <span class="period-total">${real.length}</span>
            <span class="period-chevron">▼</span>
          </div>
        </div>
        <div class="period-body">
          ${real.map(inv => invoiceCardHTML(inv, data)).join('')}
        </div>
      </div>
    `;
  }

  container.innerHTML = html;

  container.querySelectorAll('.period-header').forEach(h => {
    h.addEventListener('click', () => h.closest('.period-block').classList.toggle('collapsed'));
  });
}

function invoiceCardHTML(inv, allInvoices) {
  const isPaid      = !!inv.paid_at;
  const isCredit    = inv.is_credit;
  const isCancelled = inv.status === 'cancelled';
  const statusClass = isCredit ? 'badge-red'
    : isCancelled ? 'badge-neutral'
    : isPaid ? 'badge-green'
    : { sent: 'badge-amber', pending: 'badge-amber', failed: 'badge-red' }[inv.status] ?? 'badge-neutral';
  const statusLabel = isCredit ? 'credit' : isCancelled ? 'cancelled' : isPaid ? 'paid' : inv.status === 'sent' ? 'unpaid' : inv.status;

  // Find if a credit already exists for this invoice
  const hasCredit = !inv.is_credit && allInvoices.some(d => d.credit_for_invoice_id === inv.id);

  return `
    <div class="invoice-card">
      <div class="invoice-card-header">
        <div>
          <div class="invoice-number">
            ${escHtml(inv.invoice_number)}
            ${inv.is_draft ? '<span class="badge badge-amber">draft</span>' : ''}
            ${isCredit ? '<span class="badge badge-red">kredit</span>' : ''}
          </div>
          <div class="invoice-meta" style="margin-top:0.25rem">
            <span>${escHtml(inv.clients?.name ?? '—')}</span>
            <span>·</span>
            <span>${fmtDate(inv.issued_date)}</span>
          </div>
        </div>
        <div style="text-align:right">
          <div class="invoice-amount" style="${isCredit ? 'color:var(--red)' : isCancelled ? 'color:var(--text3);text-decoration:line-through' : ''}">${fmtISK(inv.total_amount)}</div>
          <div style="margin-top:0.3rem">
            <span class="badge ${statusClass}">${statusLabel}</span>
          </div>
        </div>
      </div>
      <div class="invoice-meta">
        <span>Cycle: ${fmtDate(inv.cycle_start)} – ${fmtDate(inv.cycle_end)}</span>
        ${isPaid ? `<span>·</span><span>Paid ${fmtDate(inv.paid_at?.slice(0, 10))}</span>` : ''}
        ${isCredit ? `<span>·</span><span>Cancels invoice</span>` : ''}
        ${isCancelled ? `<span>·</span><span>Cancelled via credit invoice</span>` : ''}
      </div>
      <div class="invoice-actions">
        ${inv.pdf_path
          ? `<button class="btn-xs btn-xs-outline" onclick="window.viewInvoicePDF('${inv.id}', '${escHtml(inv.pdf_path)}', '${escHtml(inv.invoice_number)}')">
               👁 View PDF
             </button>`
          : ''}
        ${!inv.is_draft && !isCredit && !isCancelled && inv.status === 'sent' && !isPaid
          ? `<button class="btn-xs btn-xs-green" onclick="window.markInvoicePaid('${inv.id}')">
               ✓ Mark as paid
             </button>`
          : ''}
        ${!inv.is_draft && !isCredit && !isCancelled && isPaid
          ? `<button class="btn-xs btn-xs-outline" onclick="window.markInvoiceUnpaid('${inv.id}')">
               Undo paid
             </button>`
          : ''}
        ${!inv.is_draft && !isCredit && !isCancelled && !hasCredit
          ? `<button class="btn-xs btn-xs-outline" style="color:var(--red);border-color:rgba(224,92,92,0.3)"
               onclick="window.issueCreditInvoice('${inv.id}', '${escHtml(inv.invoice_number)}')">
               ⟲ Issue credit invoice
             </button>`
          : ''}
        ${inv.status === 'failed'
          ? `<span style="font-size:0.7rem;color:var(--red)">${escHtml(inv.error_message ?? '')}</span>`
          : ''}
      </div>
    </div>
  `;
}

export async function markPaid(invoiceId) {
  const { error } = await sb
    .from('invoices')
    .update({ paid_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('user_id', currentUser.id);

  if (error) { showToast('Could not update invoice', 'error'); return; }
  await restamp(invoiceId);
  showToast('Marked as paid');
  mount(document.getElementById('page-invoices'));
}

export async function markUnpaid(invoiceId) {
  const { error } = await sb
    .from('invoices')
    .update({ paid_at: null })
    .eq('id', invoiceId)
    .eq('user_id', currentUser.id);

  if (error) { showToast('Could not update invoice', 'error'); return; }
  await restamp(invoiceId);
  showToast('Marked as unpaid');
  mount(document.getElementById('page-invoices'));
}

async function restamp(invoiceId) {
  try {
    await fetch('/.netlify/functions/restamp-invoice-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId, userId: currentUser.id }),
    });
  } catch (err) {
    console.error('Restamp failed', err);
  }
}

export async function viewInvoicePDF(invoiceId, pdfPath, invoiceNumber) {
  const { data, error } = await sb.storage
    .from('invoices')
    .createSignedUrl(pdfPath, 300); // 5 min expiry

  if (error || !data?.signedUrl) {
    showToast('Could not load PDF', 'error');
    return;
  }

  document.getElementById('pdf-modal-title').textContent = invoiceNumber;
  document.getElementById('pdf-frame').src = data.signedUrl;
  document.getElementById('pdf-send-draft-btn').style.display = 'none'; // viewing existing PDF
  document.getElementById('pdf-modal').classList.add('open');
}

function fmtISK(n) { return Number(n).toLocaleString('is-IS') + ' ISK'; }
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${parseInt(d)}/${parseInt(m)}/${y}`;
}

function loadingHTML() {
  return `<div class="empty"><span class="spinner" style="border-top-color:var(--accent);color:var(--border)"></span></div>`;
}
