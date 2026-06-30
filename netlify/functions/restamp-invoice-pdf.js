/**
 * restamp-invoice-pdf.js
 *
 * Regenerates an existing invoice's PDF with a visual stamp reflecting
 * its current status:
 *   - paid_at set        → "GREITT" stamp (green)
 *   - status = cancelled → "ÓGILT" stamp (red)
 *   - neither            → no stamp, plain reissue (used by "Undo paid")
 *
 * The new PDF replaces the file at the invoice's existing pdf_path so
 * the same signed URL keeps working, and is rebuilt from the invoice's
 * own snapshot data (no live entries are touched).
 *
 * Called automatically by:
 *   - mark-paid / undo-paid actions in the invoices app
 *   - issue-credit-invoice.js, right after marking the original cancelled
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   PDFSHIFT_API_KEY
 */

const { createClient }              = require('@supabase/supabase-js');
const { htmlToPDF, buildInvoiceHTML } = require('./generate-invoice');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  const { invoiceId, userId } = safeJSON(event.body);
  if (!invoiceId || !userId) return respond(400, { error: 'invoiceId and userId required' });

  try {
    const result = await restampInvoicePDF({ invoiceId, userId });
    return respond(200, result);
  } catch (err) {
    console.error('[restamp-invoice-pdf]', err);
    return respond(500, { error: err.message });
  }
};

async function restampInvoicePDF({ invoiceId, userId }) {
  // ── 1. Load the invoice row (it has its own immutable snapshot data) ──
  const { data: inv, error: invErr } = await sb
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('user_id', userId)
    .single();

  if (invErr || !inv) throw new Error('Invoice not found');
  if (!inv.pdf_path)  throw new Error('Invoice has no existing PDF to restamp');

  // ── 2. Load line items from the snapshot table ──
  const { data: lineItems } = await sb
    .from('invoice_entries')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('line_number', { ascending: true });

  const entries = (lineItems ?? []).filter(li => li.time_from);

  // km line items have no snapshot — best effort, reconstruct nothing extra here.
  // The original generation already baked km lines into the PDF; restamping only
  // changes the watermark layer, so we rebuild from the same entries snapshot
  // available and accept that already-locked km lines came from km_entries at
  // generation time and are not re-fetched here (they don't change after locking).
  const { data: kmEntries } = await sb
    .from('km_entries')
    .select('*')
    .eq('invoice_id', invoiceId);

  const kmRate = inv.client_id
    ? (await sb.from('clients').select('km_rate').eq('id', inv.client_id).single()).data?.km_rate
    : null;

  const { data: profileRow } = await sb.from('profiles').select('default_km_rate').eq('id', userId).single();
  const effectiveKmRate = kmRate || profileRow?.default_km_rate || 0;

  // ── 3. Determine stamp ──
  let stamp = null;
  if (inv.status === 'cancelled') stamp = 'cancelled';
  else if (inv.paid_at)           stamp = 'paid';

  // ── 4. Rebuild the PDF using the invoice's own frozen snapshot data ──
  const pdfHtml = buildInvoiceHTML({
    invoiceNumber: inv.invoice_number,
    issuedDate:    inv.issued_date,
    dueDate:       inv.due_date,
    finalDate:     inv.final_date,
    issuer: {
      issuer_name:      inv.issuer_name,
      issuer_kennitala: inv.issuer_kennitala,
      issuer_address:   inv.issuer_address,
      issuer_city:      inv.issuer_city,
      issuer_email:     inv.issuer_email,
      issuer_vsk:       inv.issuer_vsk,
    },
    client: {
      name:       inv.client_name,
      address:    inv.client_address,
      city:       inv.client_city,
      kennitala:  inv.client_kennitala,
      email:      inv.client_email,
      hourly_rate: inv.hourly_rate,
    },
    entries,
    kmEntries: (kmEntries ?? []).map(e => ({
      from_location: e.from_location,
      to_location:   e.to_location,
      is_round_trip: e.is_round_trip,
      kilometres:    e.kilometres,
    })),
    kmRate: effectiveKmRate,
    totalMinutes: inv.total_minutes,
    subtotal:     Math.abs(inv.total_amount) - Math.abs(inv.vsk_amount),
    vskRate:      inv.vsk_rate,
    vskAmount:    inv.vsk_amount,
    totalAmount:  inv.total_amount,
    bankAccount:     inv.bank_account,
    bankUtibú:       inv.bank_utibú,
    bankHb:          inv.bank_hb,
    bankReikningur:  inv.bank_reikningur,
    isDraft: inv.is_draft,
    stamp,
  });

  const pdfBuffer = await htmlToPDF(pdfHtml);

  // ── 5. Overwrite the existing PDF at the same path ──
  const { error: uploadErr } = await sb.storage
    .from('invoices')
    .upload(inv.pdf_path, pdfBuffer, { contentType: 'application/pdf', upsert: true });

  if (uploadErr) throw new Error('PDF re-upload failed: ' + uploadErr.message);

  return { message: 'PDF restamped', stamp };
}

exports.restampInvoicePDF = restampInvoicePDF;
function safeJSON(s) { try { return JSON.parse(s); } catch { return {}; } }
function respond(code, body) { return { statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
