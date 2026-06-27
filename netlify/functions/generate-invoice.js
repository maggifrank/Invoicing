/**
 * generate-invoice.js
 *
 * Called by the invoices app UI for:
 *   - Preview (isDraft: true,  sendEmail: false) → returns signed URL
 *   - Send draft (isDraft: true,  sendEmail: true)  → emails DRAFT to preview_email
 *   - Send real  (isDraft: false, sendEmail: true)  → emails real invoice to client
 *
 * Also called by send-invoices.js and send-staging.js scheduled functions.
 *
 * Environment variables (set in Netlify dashboard):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   RESEND_API_KEY
 *   INVOICE_FROM_EMAIL     e.g. invoices@franklin.is
 */

const { createClient } = require('@supabase/supabase-js');
const puppeteer         = require('puppeteer-core');
const chromium          = require('@sparticuz/chromium');
const { Resend }        = require('resend');

const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Entry point ────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  const body = safeJSON(event.body);
  const { clientId, userId, isDraft = false, sendEmail = false, cycleOverride } = body;

  if (!clientId || !userId) return respond(400, { error: 'clientId and userId required' });

  try {
    const result = await generateInvoice({ clientId, userId, isDraft, sendEmail, cycleOverride });
    return respond(200, result);
  } catch (err) {
    console.error('[generate-invoice]', err);
    return respond(500, { error: err.message });
  }
};

// ── Core generator — also exported for use by scheduled functions ──
async function generateInvoice({ clientId, userId, isDraft, sendEmail, cycleOverride }) {
  // ── 1. Load client + profile ──
  const { data: client, error: clientErr } = await sb
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .eq('user_id', userId)
    .single();

  if (clientErr || !client) throw new Error('Client not found');

  const { data: profile, error: profileErr } = await sb
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (profileErr || !profile) throw new Error('Profile not found');

  const p = profile;
  if (!p?.issuer_name || !p?.issuer_kennitala || !p?.issuer_address || !p?.issuer_email) {
    throw new Error('Issuer details incomplete — fill in Settings');
  }

  const bankAccount    = client.bank_account    || p.bank_account;
  const bankUtibú      = client.bank_utibú      || p.bank_utibú;
  const bankHb         = client.bank_hb          || p.bank_hb;
  const bankReikningur = client.bank_reikningur  || p.bank_reikningur;

  if (!bankAccount || !bankUtibú || !bankHb || !bankReikningur) {
    throw new Error('Bank details incomplete');
  }

  // ── 2. Determine cycle dates ──
  const { cycleStart, cycleEnd, issuedDate, dueDate, finalDate } =
    cycleOverride ?? getCurrentCycleDates(profile.cycle_start_day ?? 21);

  // ── 3. Idempotency check (real invoices only) ──
  if (!isDraft) {
    const { data: existing } = await sb
      .from('invoices')
      .select('id, status')
      .eq('client_id', clientId)
      .eq('cycle_start', cycleStart)
      .eq('is_draft', false)
      .maybeSingle();

    if (existing) throw new Error(`Invoice already exists for this cycle (${existing.status})`);
  }

  // ── 4. Fetch entries ──
  const query = sb
    .from('entries')
    .select('*')
    .eq('user_id', userId)
    .eq('client_id', clientId)
    .gte('date', cycleStart)
    .lte('date', cycleEnd)
    .order('date', { ascending: true })
    .order('time_from', { ascending: true });

  if (!isDraft) query.is('invoice_id', null); // only uninvoiced entries for real invoices

  const { data: entries } = await query;
  if (!entries?.length) throw new Error('No entries found for this cycle');

  // ── 5. Calculate totals ──
  const totalMinutes = entries.reduce((s, e) => s + e.minutes, 0);
  const totalAmount  = Math.round((totalMinutes / 60) * client.hourly_rate);

  // ── 6. Get invoice number ──
  let invoiceNumber;
  if (isDraft) {
    invoiceNumber = `${client.invoice_prefix}-DRAFT`;
  } else {
    const { data: counter, error: counterErr } = await sb
      .rpc('increment_client_invoice_counter', { p_client_id: clientId });
    if (counterErr) throw new Error('Counter error: ' + counterErr.message);
    invoiceNumber = `${client.invoice_prefix}-${counter}`;
  }

  // ── 7. Generate PDF ──
  const pdfHtml = buildInvoiceHTML({
    invoiceNumber, issuedDate, dueDate, finalDate,
    issuer: p, client, entries,
    totalMinutes, totalAmount,
    bankAccount, bankUtibú, bankHb, bankReikningur,
    isDraft,
  });

  const pdfBuffer = await htmlToPDF(pdfHtml);

  // ── 8. Upload PDF ──
  const pdfPath = `${userId}/${isDraft ? 'drafts' : 'invoices'}/${invoiceNumber}.pdf`;
  const { error: uploadErr } = await sb.storage
    .from('invoices')
    .upload(pdfPath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

  if (uploadErr) throw new Error('PDF upload failed: ' + uploadErr.message);

  // ── 9. Get signed URL for preview ──
  const { data: signedData } = await sb.storage
    .from('invoices')
    .createSignedUrl(pdfPath, 600); // 10 min

  const signedUrl = signedData?.signedUrl;

  // ── 10. Insert invoice row (skip for draft preview without send) ──
  let invoiceId = null;
  if (sendEmail || !isDraft) {
    const invoicePayload = {
      user_id:          userId,
      client_id:        clientId,
      invoice_number:   invoiceNumber,
      cycle_start:      cycleStart,
      cycle_end:        cycleEnd,
      issued_date:      issuedDate,
      due_date:         dueDate,
      final_date:       finalDate,
      hourly_rate:      client.hourly_rate,
      total_minutes:    totalMinutes,
      total_amount:     totalAmount,
      vsk_rate:         0,
      vsk_amount:       0,
      issuer_name:      p.issuer_name,
      issuer_kennitala: p.issuer_kennitala,
      issuer_address:   p.issuer_address,
      issuer_city:      p.issuer_city        || '',
      issuer_email:     p.issuer_email,
      issuer_vsk:       p.issuer_vsk         || '',
      bank_account:     bankAccount,
      bank_utibú:       bankUtibú,
      bank_hb:          bankHb,
      bank_reikningur:  bankReikningur,
      client_name:      client.name,
      client_address:   client.address,
      client_city:      client.city,
      client_kennitala: client.kennitala,
      client_email:     client.email,
      pdf_path:         pdfPath,
      is_draft:         isDraft,
      status:           'pending',
    };

    const { data: inv, error: invErr } = await sb
      .from('invoices')
      .upsert(invoicePayload, {
        onConflict: 'client_id,cycle_start,is_draft',
        ignoreDuplicates: false,
      })
      .select()
      .single();

    if (invErr) throw new Error('Invoice insert failed: ' + invErr.message);
    invoiceId = inv.id;

    // Insert entry snapshots
    const snapshots = entries.map((e, i) => ({
      invoice_id:       invoiceId,
      entry_id:         e.id,
      name:             e.name,
      date:             e.date,
      time_from:        e.time_from,
      time_until:       e.time_until,
      minutes:          e.minutes,
      crosses_midnight: e.crosses_midnight,
      line_number:      i + 1,
      line_amount:      Math.round((e.minutes / 60) * client.hourly_rate),
    }));

    // Delete existing snapshots if re-generating draft
    if (isDraft) {
      await sb.from('invoice_entries').delete().eq('invoice_id', invoiceId);
    }
    await sb.from('invoice_entries').insert(snapshots);
  }

  // ── 11. Send email ──
  if (sendEmail) {
    const toEmail   = isDraft ? (p.preview_email || p.issuer_email) : client.email;
    const ccEmails  = (!isDraft && p.copy_to_self) ? [p.issuer_email] : [];
    const subject   = isDraft
      ? `[DRAFT] Reikningur ${invoiceNumber} — ${fmtDateIS(issuedDate)}`
      : `Reikningur ${invoiceNumber} — ${fmtDateIS(issuedDate)}`;

    const { error: emailErr } = await resend.emails.send({
      from:        process.env.INVOICE_FROM_EMAIL,
      to:          toEmail,
      cc:          ccEmails.length ? ccEmails : undefined,
      replyTo:     p.issuer_email,
      subject,
      html:        buildEmailHTML({ invoiceNumber, issuer: p, client, totalAmount, dueDate, isDraft }),
      attachments: [{ filename: `${invoiceNumber}.pdf`, content: pdfBuffer.toString('base64') }],
    });

    if (emailErr) {
      if (invoiceId) {
        await sb.from('invoices').update({ status: 'failed', error_message: emailErr.message }).eq('id', invoiceId);
      }
      throw new Error('Email failed: ' + emailErr.message);
    }

    // Mark as sent + mark entries as invoiced (real invoices only)
    if (invoiceId) {
      await sb.from('invoices').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', invoiceId);

      if (!isDraft) {
        await sb.from('entries')
          .update({ invoice_id: invoiceId, invoiced_at: new Date().toISOString() })
          .in('id', entries.map(e => e.id));
      }
    }
  }

  return { invoiceNumber, signedUrl, totalAmount, sent: sendEmail };
}

exports.generateInvoice = generateInvoice;

// ── PDF generation ─────────────────────────────────────────────
async function htmlToPDF(html) {
  const browser = await puppeteer.launch({
    args:            chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath:  process.env.CHROME_EXECUTABLE_PATH ||
                     await chromium.executablePath('/var/task/node_modules/@sparticuz/chromium/bin'),
    headless:        chromium.headless,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format: 'A4', printBackground: true,
      margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' },
    });
  } finally {
    await browser.close();
  }
}

// ── Invoice HTML ───────────────────────────────────────────────
function buildInvoiceHTML({ invoiceNumber, issuedDate, dueDate, finalDate,
  issuer, client, entries, totalMinutes, totalAmount,
  bankAccount, bankUtibú, bankHb, bankReikningur, isDraft }) {

  const vskLabel  = issuer.issuer_vsk ? `vsknr: ${esc(issuer.issuer_vsk)}` : 'vsknr:';
  const lineItems = entries.map((e, i) => {
    const hrs    = e.minutes / 60;
    const amount = Math.round(hrs * client.hourly_rate);
    return `<tr>
      <td>${i + 1}. 2</td>
      <td>${esc(e.name)} ${fmtTime(e.time_from)} - ${fmtTime(e.time_until)} ${fmtDec(hrs)} klst</td>
      <td>${fmtDec(hrs)} klst</td>
      <td>${fmtISK(client.hourly_rate)}</td>
      <td>0%</td>
      <td>${fmtISK(amount)}</td>
      <td>${fmtISK(amount)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="is"><head><meta charset="UTF-8"/>
<style>
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:Arial,sans-serif; font-size:10pt; color:#222; background:#fff; }
${isDraft ? `
body::before { content:'DRAFT'; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%) rotate(-45deg);
  font-size:120pt; font-weight:900; color:rgba(200,0,0,0.08); z-index:0; pointer-events:none; }
` : ''}
.issuer { text-align:center; margin-bottom:1.5rem; font-size:9pt; position:relative; z-index:1; }
.title-block { text-align:right; margin-bottom:1rem; }
.title-block h1 { font-size:14pt; letter-spacing:0.1em; }
.title-block .inv-num { font-size:9pt; color:#444; }
table.info { width:100%; border-collapse:collapse; margin-bottom:1.5rem; }
table.info td { border:1px solid #ccc; padding:6px 8px; font-size:9pt; }
.label { font-weight:bold; font-size:8pt; text-transform:uppercase; }
.total { font-weight:bold; font-size:12pt; }
.currency { font-size:8pt; color:#555; }
table.lines { width:100%; border-collapse:collapse; margin-bottom:1.5rem; }
table.lines th { font-size:8pt; border-bottom:2px solid #333; padding:4px 6px; text-align:left; }
table.lines td { font-size:9pt; border:1px solid #ddd; padding:5px 6px; }
table.lines tr:nth-child(even) td { background:#f9f9f9; }
.footnote { font-size:8pt; color:#555; margin-bottom:1.5rem; }
table.tax { width:60%; margin-left:auto; border-collapse:collapse; margin-bottom:1.5rem; }
table.tax td { font-size:9pt; padding:4px 8px; }
table.tax .total-row td { font-weight:bold; border-top:2px solid #333; }
.payment-title { font-weight:bold; font-size:9pt; margin-bottom:0.5rem; }
table.bank { border-collapse:collapse; font-size:9pt; }
table.bank th { font-weight:bold; font-size:8pt; padding:4px 10px 4px 0; }
table.bank td { padding:4px 10px 4px 0; }
.footer { text-align:center; font-size:7.5pt; color:#666; margin-top:2rem; border-top:1px solid #ddd; padding-top:0.5rem; }
</style></head><body>
<div class="issuer">
  ${esc(issuer.issuer_name)} | ${esc(issuer.issuer_kennitala)}<br>
  ${esc(issuer.issuer_address)}${issuer.issuer_city ? ' | ' + esc(issuer.issuer_city) : ''}<br>
  ${esc(issuer.issuer_email)} | ${vskLabel}
</div>
<div class="title-block">
  <h1>REIKNINGUR${isDraft ? ' — DRAFT' : ''}</h1>
  <div class="inv-num">Reikn.nr. ${esc(invoiceNumber)}</div>
</div>
<table class="info">
  <tr>
    <td rowspan="2" style="vertical-align:top;width:45%">
      <div class="label">Greiðandi</div>
      <div style="margin-top:4px">
        <strong>${esc(client.name)}</strong><br>
        ${client.address ? esc(client.address) + '<br>' : ''}
        ${client.city    ? esc(client.city)    + '<br>' : ''}
        ${client.kennitala ? esc(client.kennitala) + '<br>' : ''}
        ${esc(client.email)}
      </div>
    </td>
    <td style="width:18%"><div class="label">Gjalddagi</div><div>${fmtDateIS(dueDate)}</div></td>
    <td style="width:18%"><div class="label">Útgáfudagur</div><div>${fmtDateIS(issuedDate)}</div></td>
    <td style="width:19%"><div class="label">Eindagi</div><div>${fmtDateIS(finalDate)}</div></td>
  </tr>
  <tr>
    <td colspan="2"><div class="label">Til greiðslu</div></td>
    <td class="total">${fmtISK(totalAmount)}</td>
  </tr>
  <tr><td colspan="4" class="currency">Gjaldmiðill á reikningi: ISK</td></tr>
</table>
<table class="lines">
  <thead><tr>
    <th>Vörunr.</th><th>Lýsing</th><th>Magn</th>
    <th>Einingarverð*</th><th>Vsk.</th><th>Upphæð án/vsk</th><th>Upphæð m/vsk</th>
  </tr></thead>
  <tbody>${lineItems}</tbody>
</table>
<p class="footnote">* Einingarverð er án VSK</p>
<table class="tax">
  <tr><td><strong>Skattaupplýsingar:</strong></td><td><strong>Upphæð:</strong></td><td><strong>Skattur:</strong></td><td></td><td></td></tr>
  <tr>
    <td>Z(0%)</td><td>${fmtISK(totalAmount)}</td><td>0</td>
    <td style="padding-left:2rem">Samtals:</td><td style="text-align:right">${fmtISKDec(totalAmount)}</td>
  </tr>
  <tr><td colspan="3"></td><td style="padding-left:2rem">Samtals vsk.:</td><td style="text-align:right">0,00</td></tr>
  <tr class="total-row">
    <td colspan="3"></td>
    <td style="padding-left:2rem">Heildarupphæð:</td>
    <td style="text-align:right">${fmtISK(totalAmount)} ISK</td>
  </tr>
</table>
<div class="payment-title">Greiðsluaðferð: Millifærið á reikning</div>
<table class="bank">
  <thead><tr><th>Móttakandi greiðslu</th><th>Tilvísun</th><th>Útibú</th><th>Hb</th><th>Reikn.nr.</th></tr></thead>
  <tbody><tr>
    <td>${esc(bankAccount)}</td><td>${esc(invoiceNumber)}</td>
    <td>${esc(bankUtibú)}</td><td>${esc(bankHb)}</td><td>${esc(bankReikningur)}</td>
  </tr></tbody>
</table>
<div class="footer">Reikningur útgefinn af reikningakerfi Konto skv. reglugerð nr. 505/2013.</div>
</body></html>`;
}

// ── Email HTML ─────────────────────────────────────────────────
function buildEmailHTML({ invoiceNumber, issuer, client, totalAmount, dueDate, isDraft }) {
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:560px;margin:0 auto">
    ${isDraft ? `<p style="background:#fff3cd;padding:0.75rem;border-radius:6px;margin-bottom:1rem;font-weight:bold">⚠️ This is a DRAFT invoice for your review. It has not been sent to the client.</p>` : ''}
    <p>Sæl/Sæll,</p>
    <p style="margin-top:1rem">Meðfylgjandi er reikningur <strong>${esc(invoiceNumber)}</strong> að upphæð <strong>${fmtISK(totalAmount)} ISK</strong>.</p>
    <p style="margin-top:0.5rem">Gjalddagi: ${fmtDateIS(dueDate)}</p>
    <p style="margin-top:1.5rem">Kveðja,<br>${esc(issuer.issuer_name)}</p>
    <p style="margin-top:0.5rem;font-size:12px;color:#666">${esc(issuer.issuer_email)}</p>
  </div>`;
}

// ── Date helpers ───────────────────────────────────────────────
function getCurrentCycleDates(cycleStartDay = 21) {
  const now = new Date();
  const day = now.getDate();
  const y   = now.getFullYear();
  const m   = now.getMonth();

  // Determine which cycle we're currently in
  let cycleStartDate, cycleEndDate;
  if (day >= cycleStartDay) {
    cycleStartDate = new Date(y, m, cycleStartDay);
    cycleEndDate   = new Date(y, m + 1, cycleStartDay - 1);
  } else {
    cycleStartDate = new Date(y, m - 1, cycleStartDay);
    cycleEndDate   = new Date(y, m, cycleStartDay - 1);
  }

  // Invoice dates: issued 25th, due last of month, final 1st of next
  const issuedDate = new Date(y, m, 25);
  const dueDate    = new Date(y, m + 1, 0); // last day of current month
  const finalDate  = new Date(y, m + 1, 1);

  return {
    cycleStart:  iso(cycleStartDate),
    cycleEnd:    iso(cycleEndDate),
    issuedDate:  iso(issuedDate),
    dueDate:     iso(dueDate),
    finalDate:   iso(finalDate),
  };
}

function iso(d) {
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
function fmtDec(n)    { return n.toLocaleString('is-IS', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function esc(s)       { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function safeJSON(s)  { try { return JSON.parse(s); } catch { return {}; } }
function respond(code, body) { return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
