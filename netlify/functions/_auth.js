/**
 * _auth.js
 * Shared helper for the HTTP-facing functions. Verifies the Supabase
 * access token sent by the frontend and returns the authenticated user,
 * so handlers never have to trust a client-supplied userId.
 *
 * Prefixed with `_` so Netlify's functions bundler doesn't treat this
 * file as its own endpoint.
 */

async function verifyUser(sb, event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new Error('Unauthorized');

  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) throw new Error('Unauthorized');

  return data.user;
}

// send-invoices/send-staging are triggered by a pg_cron job (via pg_net)
// in Supabase rather than Netlify's own scheduler, since Netlify's
// schedule() wrapper was found to still accept direct HTTP requests in
// practice. The cron job attaches this shared secret as a header; a
// request without the matching secret is rejected outright.
function requireSchedulerSecret(event) {
  const provided = event.headers?.['x-scheduled-secret'] || event.headers?.['X-Scheduled-Secret'] || '';
  const expected = process.env.SCHEDULED_FUNCTIONS_SECRET || '';
  if (!expected || provided !== expected) throw new Error('Forbidden');
}

module.exports = { verifyUser, requireSchedulerSecret };
