/**
 * invite-user.js
 * Sends a Supabase invite email to a new user.
 * Uses the service role key — server-side only.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   SITE_URL   — the invoices app URL e.g. https://invoicing.franklin.is
 */

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  const { email } = JSON.parse(event.body ?? '{}');
  if (!email) return respond(400, { error: 'Email is required' });

  const redirectTo = process.env.SITE_URL || 'http://localhost:8889';

  const { data, error } = await sb.auth.admin.inviteUserByEmail(email, { redirectTo });

  if (error) return respond(400, { error: error.message });

  return respond(200, { message: `Invite sent to ${email}` });
};

function respond(code, body) {
  return {
    statusCode: code,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
