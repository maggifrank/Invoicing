-- Schedules send-staging and send-invoices via pg_cron + pg_net instead of
-- relying on Netlify's own scheduler, which was found to still accept
-- direct HTTP requests in practice. Each cron job attaches a shared secret
-- (stored in Vault, referenced here by name only — never by value) as a
-- header, which the Netlify function checks before doing any work.
--
-- Prerequisite (run once, not part of this migration):
--   select vault.create_secret('<value>', 'scheduled_functions_secret', '...');
--
-- This file targets the test/dev project's branch-deploy URL. Production
-- gets an equivalent migration once this is validated on test.

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
    url     := 'https://test--enchanting-sfogliatella-b979c6.netlify.app/.netlify/functions/send-staging',
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
    url     := 'https://test--enchanting-sfogliatella-b979c6.netlify.app/.netlify/functions/send-invoices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-scheduled-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'scheduled_functions_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) as request_id;
  $$
);
