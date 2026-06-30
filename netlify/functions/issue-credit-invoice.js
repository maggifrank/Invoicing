/**
 * issue-credit-invoice.js
 *
 * Issues a credit invoice (kreditreikningur) that cancels a previously
 * sent real invoice. The original invoice is never deleted — Icelandic
 * law requires the full audit trail. Instead:
 *
 *   1. A new invoice row is created with is_credit = true,
 *      referencing the original via credit_for_invoice_id.
 *      All amounts are negative.
 *   2. A credit PDF is generated and emailed to the client
 *      (and optionally cc'd to self).
 *   3. The entries and km_entries that were locked by the original
 *      invoice are unlocked (invoice_id set back to null) so they
 *      can be corrected and re-invoiced.
 *
 * Called from the invoices app when the user taps "Issue credit invoice"
 * on a sent invoice.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   RESEND_API_KEY
 *   INVOICE_FROM_EMAIL
 *   PDFSHIFT_API_KEY
 */

const { createClient } = require('@supabase/supabase-js');
const { Resend }       = require('resend');

const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

async function restampOriginalPDF(invoiceId, userId) {
  // Reuse the same in-process logic as restamp-invoice-pdf.js rather than
  // making an HTTP call to another function (faster, same execution context).
  const { restampInvoicePDF } = require('./restamp-invoice-pdf');
  return restampInvoicePDF ? restampInvoicePDF({ invoiceId, userId }) : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  const { invoiceId, userId, unlockEntries = true } = safeJSON(event.body);
  if (!invoiceId || !userId) return respond(400, { error: 'invoiceId and userId required' });

  try {
    const result = await issueCreditInvoice({ invoiceId, userId, unlockEntries });
    return respond(200, result);
  } catch (err) {
    console.error('[issue-credit-invoice]', err);
    return respond(500, { error: err.message });
  }
};

async function issueCreditInvoice({ invoiceId, userId, unlockEntries }) {
  // ── 1. Load the original invoice ──
  const { data: original, error: origErr } = await sb
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('user_id', userId)
    .single();

  if (origErr || !original) throw new Error('Original invoice not found');
  if (original.is_draft)    throw new Error('Cannot issue a credit for a draft invoice');
  if (original.is_credit)   throw new Error('Cannot issue a credit for a credit invoice');

  // Check a credit hasn't already been issued for this invoice
  const { data: existingCredit } = await sb
    .from('invoices')
    .select('id')
    .eq('credit_for_invoice_id', invoiceId)
    .maybeSingle();

  if (existingCredit) throw new Error('A credit invoice has already been issued for this invoice');

  // ── 2. Load profile for issuer details ──
  const { data: profile } = await sb.from('profiles').select('*').eq('id', userId).single();
  const p = profile ?? {};

  // ── 3. Load the original line item snapshots ──
  const { data: lineItems } = await sb
    .from('invoice_entries')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('line_number', { ascending: true });

  // km_entries have no snapshot table — fetch them directly while still locked
  const { data: kmEntries } = await sb
    .from('km_entries')
    .select('*')
    .eq('invoice_id', invoiceId);

  const kmRate = original.client_id
    ? (await sb.from('clients').select('km_rate').eq('id', original.client_id).single()).data?.km_rate
    : null;
  const effectiveKmRate = kmRate || p.default_km_rate || 0;

  const kmLineItems = (kmEntries ?? []).map(e => ({
    name:        `${e.from_location} → ${e.to_location}`,
    minutes:     parseFloat(e.kilometres), // reused as "amount" field for km
    line_amount: Math.round(parseFloat(e.kilometres) * effectiveKmRate),
  }));

  // ── 4. Build credit invoice number — next in the normal sequence ──
  const { data: client } = await sb
    .from('clients')
    .select('invoice_prefix')
    .eq('id', original.client_id)
    .single();

  const { data: nextCounter, error: counterErr } = await sb
    .rpc('increment_client_invoice_counter', { p_client_id: original.client_id });

  if (counterErr) throw new Error('Counter error: ' + counterErr.message);

  const creditNumber = `${client.invoice_prefix}-${nextCounter}`;

  // ── 5. Generate credit PDF ──
  const pdfHtml = buildCreditHTML({ original, profile: p, lineItems: lineItems ?? [], kmLineItems, creditNumber });
  const pdfBuffer = await htmlToPDF(pdfHtml);

  const pdfPath = `${userId}/credits/${creditNumber}-${Date.now()}.pdf`;
  const { error: uploadErr } = await sb.storage
    .from('invoices')
    .upload(pdfPath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

  if (uploadErr) throw new Error('PDF upload failed: ' + uploadErr.message);

  // ── 6. Insert the credit invoice row ──
  const creditPayload = {
    user_id:          userId,
    client_id:        original.client_id,
    invoice_number:   creditNumber,
    cycle_start:      original.cycle_start,
    cycle_end:        original.cycle_end,
    issued_date:      isoToday(),
    due_date:         isoToday(),
    final_date:       isoToday(),
    hourly_rate:      original.hourly_rate,
    total_minutes:    original.total_minutes,
    total_amount:     -original.total_amount,
    vsk_rate:         original.vsk_rate,
    vsk_amount:       -original.vsk_amount,
    issuer_name:      original.issuer_name,
    issuer_kennitala: original.issuer_kennitala,
    issuer_address:   original.issuer_address,
    issuer_city:      original.issuer_city,
    issuer_email:     original.issuer_email,
    issuer_vsk:       original.issuer_vsk,
    bank_account:     original.bank_account,
    bank_utibú:       original.bank_utibú,
    bank_hb:          original.bank_hb,
    bank_reikningur:  original.bank_reikningur,
    client_name:      original.client_name,
    client_address:   original.client_address,
    client_city:      original.client_city,
    client_kennitala: original.client_kennitala,
    client_email:     original.client_email,
    pdf_path:         pdfPath,
    is_draft:         false,
    is_credit:        true,
    credit_for_invoice_id: invoiceId,
    status:           'pending',
  };

  const { data: credit, error: creditErr } = await sb
    .from('invoices')
    .insert(creditPayload)
    .select()
    .single();

  if (creditErr) throw new Error('Credit insert failed: ' + creditErr.message);

  // ── 7. Send email ──
  const toEmail  = original.client_email;
  const ccEmails = p.copy_to_self ? [p.issuer_email] : [];

  const { error: emailErr } = await resend.emails.send({
    from:        process.env.INVOICE_FROM_EMAIL,
    to:          toEmail,
    cc:          ccEmails.length ? ccEmails : undefined,
    replyTo:     p.issuer_email,
    subject:     `Kreditreikningur ${creditNumber} — leiðrétting á ${original.invoice_number}`,
    html:        buildCreditEmailHTML({ creditNumber, original, issuer: p }),
    attachments: [{ filename: `${creditNumber}.pdf`, content: pdfBuffer.toString('base64') }],
  });

  if (emailErr) {
    await sb.from('invoices').update({ status: 'failed', error_message: emailErr.message }).eq('id', credit.id);
    throw new Error('Email failed: ' + emailErr.message);
  }

  await sb.from('invoices').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', credit.id);

  // ── 7b. Mark the original invoice as cancelled ──
  await sb.from('invoices').update({ status: 'cancelled' }).eq('id', invoiceId);

  // Restamp the original PDF with the ÓGILT stamp
  try {
    await restampOriginalPDF(invoiceId, userId);
  } catch (err) {
    console.error('[issue-credit-invoice] restamp failed (non-fatal):', err.message);
  }

  // ── 8. Unlock the original entries so they can be corrected and re-invoiced ──
  if (unlockEntries) {
    const entryIds = (lineItems ?? []).filter(li => li.entry_id).map(li => li.entry_id);
    if (entryIds.length) {
      await sb.from('entries')
        .update({ invoice_id: null, invoiced_at: null })
        .in('id', entryIds);
    }

    // km_entries are linked by invoice_id directly (no snapshot table) — unlock those too
    await sb.from('km_entries')
      .update({ invoice_id: null, invoiced_at: null })
      .eq('invoice_id', invoiceId);
  }

  return { creditNumber, creditId: credit.id, message: 'Credit invoice issued and entries unlocked' };
}

// ── Credit PDF ───────────────────────────────────────────────
function buildCreditHTML({ original, profile, lineItems, kmLineItems, creditNumber }) {
  const vskLabel = profile.issuer_vsk ? `vsknr: ${esc(profile.issuer_vsk)}` : 'vsknr:';
  const vskCode  = original.vsk_rate === 0 ? 'Z(0%)' : `S(${original.vsk_rate}%)`;

  let lineNum = 0;
  const timeRows = lineItems.filter(li => li.time_from).map(li => {
    lineNum++;
    const hrs = li.minutes / 60;
    const amount = Math.abs(li.line_amount);
    return `<tr>
      <td>${lineNum}. 2</td>
      <td>${esc(li.name)} ${fmtTime(li.time_from)} - ${fmtTime(li.time_until)} ${fmtDec(hrs)} klst</td>
      <td>${fmtDec(hrs)} klst</td>
      <td>${fmtISK(original.hourly_rate)}</td>
      <td>${vskCode.includes('0') ? '0%' : original.vsk_rate + '%'}</td>
      <td>${fmtISK(amount)}</td>
      <td>${fmtISK(amount)}</td>
    </tr>`;
  }).join('');

  const kmRows = (kmLineItems ?? []).map(li => {
    lineNum++;
    const amount = Math.abs(li.line_amount);
    return `<tr>
      <td>${lineNum}. 3</td>
      <td>${esc(li.name)} ${fmtDec(li.minutes)} km</td>
      <td>${fmtDec(li.minutes)} km</td>
      <td>${fmtISK(amount / li.minutes)}</td>
      <td>${vskCode.includes('0') ? '0%' : original.vsk_rate + '%'}</td>
      <td>${fmtISK(amount)}</td>
      <td>${fmtISK(amount)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="is"><head><meta charset="UTF-8"/>
<style>
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:Arial,sans-serif; font-size:10pt; color:#222; background:#fff; }
.issuer { text-align:center; margin-bottom:1.5rem; font-size:9pt; }
.title-block { text-align:right; margin-bottom:1rem; }
.title-block h1 { font-size:14pt; letter-spacing:0.1em; color:#a00; }
.title-block .inv-num { font-size:9pt; color:#444; }
table.info { width:100%; border-collapse:collapse; margin-bottom:1.5rem; }
table.info td { border:1px solid #ccc; padding:6px 8px; font-size:9pt; }
.label { font-weight:bold; font-size:8pt; text-transform:uppercase; }
.total { font-weight:bold; font-size:12pt; }
.currency { font-size:8pt; color:#555; }
.notice-section { margin-bottom:1.5rem; }
.notice-title { font-weight:bold; font-size:9pt; text-transform:uppercase; margin-bottom:0.5rem; }
table.notice { border-collapse:collapse; }
table.notice td { font-size:9pt; padding:4px 8px 4px 0; vertical-align:top; }
table.notice .notice-label { font-weight:bold; white-space:nowrap; }
table.lines { width:100%; border-collapse:collapse; margin-bottom:1.5rem; }
table.lines th { font-size:8pt; border-bottom:2px solid #333; padding:4px 6px; text-align:left; }
table.lines td { font-size:9pt; border:1px solid #ddd; padding:5px 6px; }
table.lines tr:nth-child(even) td { background:#f9f9f9; }
.footnote { font-size:8pt; color:#555; margin-bottom:1.5rem; }
table.tax { width:60%; margin-left:auto; border-collapse:collapse; margin-bottom:1.5rem; }
table.tax td { font-size:9pt; padding:4px 8px; }
table.tax .total-row td { font-weight:bold; border-top:2px solid #333; }
.footer { text-align:center; font-size:7.5pt; color:#666; margin-top:2rem; border-top:1px solid #ddd; padding-top:0.5rem; }
</style></head><body>
<div class="issuer">
  ${esc(profile.issuer_name)} | ${esc(profile.issuer_kennitala)}<br>
  ${esc(profile.issuer_address)}${profile.issuer_city ? ' | ' + esc(profile.issuer_city) : ''}<br>
  ${esc(profile.issuer_email)} | ${vskLabel}
</div>
<div class="title-block">
  <h1>KREDITREIKNINGUR</h1>
  <div class="inv-num">Reikn.nr. ${esc(creditNumber)}</div>
</div>
<table class="info">
  <tr>
    <td rowspan="2" style="vertical-align:top;width:45%">
      <div class="label">Greiðandi</div>
      <div style="margin-top:4px">
        <strong>${esc(original.client_name)}</strong><br>
        ${original.client_address ? esc(original.client_address) + '<br>' : ''}
        ${original.client_city    ? esc(original.client_city)    + '<br>' : ''}
        ${original.client_kennitala ? esc(original.client_kennitala) + '<br>' : ''}
        ${esc(original.client_email)}
      </div>
    </td>
    <td style="width:18%"><div class="label">Gjalddagi</div><div>${fmtDateIS(isoToday())}</div></td>
    <td style="width:18%"><div class="label">Útgáfudagur</div><div>${fmtDateIS(isoToday())}</div></td>
    <td style="width:19%"><div class="label">Eindagi</div><div>${fmtDateIS(isoPlusDays(7))}</div></td>
  </tr>
  <tr>
    <td colspan="2"><div class="label">Til greiðslu</div></td>
    <td class="total">${fmtISK(Math.abs(original.total_amount))}</td>
  </tr>
  <tr><td colspan="4" class="currency">Gjaldmiðill á reikningi: ISK</td></tr>
</table>
<div class="notice-section">
  <div class="notice-title">Viðbótarupplýsingar</div>
  <table class="notice">
    <tr>
      <td class="notice-label">Bókunarupplýsingar:</td>
      <td>Þetta er kredit reikningur fyrir reikning nr. ${esc(original.invoice_number)}</td>
    </tr>
  </table>
</div>
<table class="lines">
  <thead><tr>
    <th>Vörunr.</th><th>Lýsing</th><th>Magn</th>
    <th>Einingarverð*</th><th>Vsk.</th><th>Upphæð án/vsk</th><th>Upphæð m/vsk</th>
  </tr></thead>
  <tbody>${timeRows}${kmRows}</tbody>
</table>
<p class="footnote">* Einingarverð er án VSK</p>
<table class="tax">
  <tr><td><strong>Skattaupplýsingar:</strong></td><td><strong>Upphæð:</strong></td><td><strong>Skattur:</strong></td><td></td><td></td></tr>
  <tr>
    <td>${vskCode}</td><td>${fmtISK(Math.abs(original.total_amount) - Math.abs(original.vsk_amount))}</td><td>${fmtISK(Math.abs(original.vsk_amount))}</td>
    <td style="padding-left:2rem">Samtals:</td><td style="text-align:right">${fmtISKDec(Math.abs(original.total_amount) - Math.abs(original.vsk_amount))}</td>
  </tr>
  <tr><td colspan="3"></td><td style="padding-left:2rem">Samtals vsk.:</td><td style="text-align:right">${fmtISKDec(Math.abs(original.vsk_amount))}</td></tr>
  <tr class="total-row">
    <td colspan="3"></td>
    <td style="padding-left:2rem">Heildarupphæð:</td>
    <td style="text-align:right">${fmtISK(Math.abs(original.total_amount))} ISK</td>
  </tr>
</table>
<div class="footer">Reikningur útgefinn af reikningakerfinu Talva skv. reglugerð nr. 505/2013.</div>
</body></html>`;
}

function buildCreditEmailHTML({ creditNumber, original, issuer }) {
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:560px;margin:0 auto">
    <p>Sæl/Sæll,</p>
    <p style="margin-top:1rem">Meðfylgjandi er kreditreikningur <strong>${esc(creditNumber)}</strong>,
    sem ógildir reikning <strong>${esc(original.invoice_number)}</strong> í heild sinni.</p>
    <p style="margin-top:0.5rem">Upphæð: <strong>${fmtISK(-original.total_amount)} ISK</strong></p>
    <p style="margin-top:1rem">Leiðréttur reikningur verður sendur sérstaklega.</p>
    <p style="margin-top:1.5rem">Kveðja,<br>${esc(issuer.issuer_name)}</p>
    <p style="margin-top:0.5rem;font-size:12px;color:#666">${esc(issuer.issuer_email)}</p>
  </div>`;
}

// ── PDF generation via PDFShift ────────────────────────────────
async function htmlToPDF(html) {
  const response = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`api:${process.env.PDFSHIFT_API_KEY}`).toString('base64'),
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      source: html,
      format: 'A4',
      margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`PDFShift error ${response.status}: ${err}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

// ── Helpers ────────────────────────────────────────────────────
function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function isoPlusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtDateIS(iso) {
  const [y, m, d] = iso.split('-');
  return `${parseInt(d)}/${parseInt(m)}/${y}`;
}
function fmtTime(t) {
  const [h, m] = t.split(':').map(Number);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function fmtISK(n)    { return Number(n).toLocaleString('is-IS'); }
function fmtISKDec(n) { return Number(n).toLocaleString('is-IS', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDec(n)    { return n.toLocaleString('is-IS', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function esc(s)       { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function safeJSON(s)  { try { return JSON.parse(s); } catch { return {}; } }
function respond(code, body) { return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
