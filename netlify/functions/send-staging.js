/**
 * send-staging.js
 * Scheduled: 09:00 UTC on the 22nd of every month
 * Sends DRAFT invoices to each user's preview_email for review.
 * Also sends a single summary email per user listing clients with
 * no logged work this cycle.
 */

const { createClient }    = require('@supabase/supabase-js');
const { Resend }          = require('resend');
const { generateInvoice } = require('./generate-invoice');

const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

module.exports.config = {
  schedule: '0 9 22 * *',
};

exports.handler = async () => {
  console.log('[send-staging] Starting');

  const { data: clients, error } = await sb
    .from('clients')
    .select('id, user_id, name')
    .eq('archived', false);

  if (error) {
    console.error('[send-staging] Failed to fetch clients:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch clients' }) };
  }

  let sent = 0, skipped = 0, failed = 0;
  const noWorkByUser = {}; // userId -> [client names]

  for (const client of clients) {
    // Fetch preview email from profile
    const { data: profile } = await sb
      .from('profiles')
      .select('preview_email')
      .eq('id', client.user_id)
      .single();

    const previewEmail = profile?.preview_email;
    if (!previewEmail) {
      console.log(`[send-staging] No preview email for ${client.name} — skipping`);
      skipped++;
      continue;
    }

    try {
      await generateInvoice({
        clientId:  client.id,
        userId:    client.user_id,
        isDraft:   true,
        sendEmail: true,
      });
      console.log(`[send-staging] ✓ Draft sent for ${client.name}`);
      sent++;
    } catch (err) {
      if (err.message.includes('No entries')) {
        console.log(`[send-staging] Skipped ${client.name}: ${err.message}`);
        skipped++;
        if (!noWorkByUser[client.user_id]) noWorkByUser[client.user_id] = { previewEmail, clients: [] };
        noWorkByUser[client.user_id].clients.push(client.name);
      } else {
        console.error(`[send-staging] ✗ ${client.name}:`, err.message);
        failed++;
      }
    }
  }

  // Send one "no work" summary email per user
  for (const userId of Object.keys(noWorkByUser)) {
    const { previewEmail, clients: clientNames } = noWorkByUser[userId];
    try {
      await sendNoWorkSummary(previewEmail, clientNames);
      console.log(`[send-staging] No-work summary sent to ${previewEmail}`);
    } catch (err) {
      console.error(`[send-staging] Failed to send no-work summary to ${previewEmail}:`, err.message);
    }
  }

  const summary = { sent, skipped, failed };
  console.log('[send-staging] Done', summary);
  return { statusCode: 200, body: JSON.stringify(summary) };
};

async function sendNoWorkSummary(toEmail, clientNames) {
  const lines = clientNames
    .map(name => `Enginn skráð vinna fyrir ${name} á þessu tímabili.`)
    .join('<br>');

  await resend.emails.send({
    from:    process.env.INVOICE_FROM_EMAIL,
    to:      toEmail,
    subject: 'Engin skráð vinna — staða reikninga',
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:560px;margin:0 auto">
      <p>${lines}</p>
    </div>`,
  });
}
