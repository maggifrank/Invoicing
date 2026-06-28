/**
 * send-staging.js
 * Scheduled: 09:00 UTC on the 22nd of every month
 * Sends DRAFT invoices to each user's preview_email for review.
 */

const { createClient }    = require('@supabase/supabase-js');
const { generateInvoice } = require('./generate-invoice');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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
      console.error(`[send-staging] ✗ ${client.name}:`, err.message);
      failed++;
    }
  }

  const summary = { sent, skipped, failed };
  console.log('[send-staging] Done', summary);
  return { statusCode: 200, body: JSON.stringify(summary) };
};
