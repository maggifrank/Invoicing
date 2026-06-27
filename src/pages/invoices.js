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

  let html = '';
  data.forEach(inv => {
    const statusClass = { sent: 'badge-green', pending: 'badge-amber', failed: 'badge-red' }[inv.status] ?? 'badge-neutral';
    html += `
      <div class="invoice-card">
        <div class="invoice-card-header">
          <div>
            <div class="invoice-number">
              ${escHtml(inv.invoice_number)}
              ${inv.is_draft ? '<span class="badge badge-amber">draft</span>' : ''}
            </div>
            <div class="invoice-meta" style="margin-top:0.25rem">
              <span>${escHtml(inv.clients?.name ?? '—')}</span>
              <span>·</span>
              <span>${fmtDate(inv.issued_date)}</span>
            </div>
          </div>
          <div style="text-align:right">
            <div class="invoice-amount">${fmtISK(inv.total_amount)}</div>
            <div style="margin-top:0.3rem">
              <span class="badge ${statusClass}">${inv.status}</span>
            </div>
          </div>
        </div>
        <div class="invoice-meta">
          <span>Cycle: ${fmtDate(inv.cycle_start)} – ${fmtDate(inv.cycle_end)}</span>
        </div>
        <div class="invoice-actions">
          ${inv.pdf_path
            ? `<button class="btn-xs btn-xs-outline" onclick="window.viewInvoicePDF('${inv.id}', '${escHtml(inv.pdf_path)}', '${escHtml(inv.invoice_number)}')">
                 👁 View PDF
               </button>`
            : ''}
          ${inv.status === 'failed'
            ? `<span style="font-size:0.7rem;color:var(--red)">${escHtml(inv.error_message ?? '')}</span>`
            : ''}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
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
