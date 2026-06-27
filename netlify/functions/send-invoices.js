/**
 * send-invoices.js
 * Scheduled: 09:00 UTC on the 25th of every month
 * Sends real invoices to clients and marks entries as invoiced.
 */

const { createClient }    = require('@supabase/supabase-js');
const { generateInvoice } = require('./generate-invoice');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Netlify scheduled function config
module.exports.config = {
  schedule: '0 9 25 * *',
};

exports.handler = async () => {
  console.log('[send-invoices] Starting');

  const { data: clients, error } = await sb
    .from('clients')
    .select('id, user_id, name')
    .eq('archived', false);

  if (error) {
    console.error('[send-invoices] Failed to fetch clients:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch clients' }) };
  }

  let sent = 0, skipped = 0, failed = 0;

  for (const client of clients) {
    try {
      await generateInvoice({
        clientId:  client.id,
        userId:    client.user_id,
        isDraft:   false,
        sendEmail: true,
      });
      console.log(`[send-invoices] ✓ Invoice sent for ${client.name}`);
      sent++;
    } catch (err) {
      // "already exists" and "no entries" are expected — not failures
      if (err.message.includes('already exists') || err.message.includes('No entries')) {
        console.log(`[send-invoices] Skipped ${client.name}: ${err.message}`);
        skipped++;
      } else {
        console.error(`[send-invoices] ✗ ${client.name}:`, err.message);
        failed++;
      }
    }
  }

  const summary = { sent, skipped, failed };
  console.log('[send-invoices] Done', summary);
  return { statusCode: 200, body: JSON.stringify(summary) };
};
