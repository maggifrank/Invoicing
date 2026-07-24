-- Production equivalent of 003_scheduled_function_cron.sql. That migration
-- targeted the test/dev project's branch-deploy URL; this one targets
-- production and uses a separate Vault secret + Netlify env var value, so
-- test and production each have their own distinct shared secret.
--
-- Prerequisite (run once, not part of this migration, against the
-- production project specifically):
--   select vault.create_secret('<prod value>', 'scheduled_functions_secret', '...');
--
-- URL uses Netlify's raw subdomain (main--enchanting-sfogliatella-b979c6),
-- not invoicing.talva.is: talva.is sits behind Cloudflare with IP
-- geoblocking restricted to Iceland (see README Security section), and a
-- manual net.http_post test against the talva.is URL got a 404 while the
-- identical request against the raw Netlify subdomain succeeded — pg_net's
-- requests originate from Supabase's own infrastructure, not Iceland. Same
-- site, same functions, just bypassing the custom domain's Cloudflare layer.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- timeout_milliseconds is generous (30s) because these functions loop over
-- every client sequentially (PDF generation + email per client) — pg_net's
-- default timeout is short enough that a real run can exceed it even
-- though the Netlify function itself isn't cancelled by that timeout, it
-- just means net._http_response can't be trusted to reflect success/failure.
select cron.schedule(
  'send-staging-monthly',
  '0 9 22 * *',
  $$
  select net.http_post(
    url     := 'https://main--enchanting-sfogliatella-b979c6.netlify.app/.netlify/functions/send-staging',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-scheduled-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'scheduled_functions_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) as request_id;
  $$
);

select cron.schedule(
  'send-invoices-monthly',
  '0 9 25 * *',
  $$
  select net.http_post(
    url     := 'https://main--enchanting-sfogliatella-b979c6.netlify.app/.netlify/functions/send-invoices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-scheduled-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'scheduled_functions_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) as request_id;
  $$
);
