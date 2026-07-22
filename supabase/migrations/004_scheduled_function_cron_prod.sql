-- Production equivalent of 003_scheduled_function_cron.sql. That migration
-- targeted the test/dev project's branch-deploy URL; this one targets
-- production and uses a separate Vault secret + Netlify env var value, so
-- test and production each have their own distinct shared secret.
--
-- Prerequisite (run once, not part of this migration, against the
-- production project specifically):
--   select vault.create_secret('<prod value>', 'scheduled_functions_secret', '...');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'send-staging-monthly',
  '0 9 22 * *',
  $$
  select net.http_post(
    url     := 'https://invoicing.talva.is/.netlify/functions/send-staging',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-scheduled-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'scheduled_functions_secret')
    ),
    body    := '{}'::jsonb
  ) as request_id;
  $$
);

select cron.schedule(
  'send-invoices-monthly',
  '0 9 25 * *',
  $$
  select net.http_post(
    url     := 'https://invoicing.talva.is/.netlify/functions/send-invoices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-scheduled-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'scheduled_functions_secret')
    ),
    body    := '{}'::jsonb
  ) as request_id;
  $$
);
