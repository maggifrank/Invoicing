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

module.exports = { verifyUser };
