-- ════════════════════════════════════════════════════════════
-- 002_invoices.sql
-- Invoice system tables: clients, invoices, invoice_entries
-- Shared Supabase project — used by the invoices app, not timelog.
-- Run AFTER 001_timelog.sql.
-- ════════════════════════════════════════════════════════════


-- ── Extend profiles with issuer details ──────────────────────
alter table profiles
  add column if not exists issuer_name        text,
  add column if not exists issuer_kennitala   text,
  add column if not exists issuer_address     text,
  add column if not exists issuer_city        text,
  add column if not exists issuer_email       text,
  add column if not exists issuer_vsk         text,
  add column if not exists bank_account       text,
  add column if not exists bank_utibú         text,
  add column if not exists bank_hb            text,
  add column if not exists bank_reikningur    text,
  add column if not exists default_rate       integer,
  add column if not exists invoice_prefix     text
;


-- ── Clients ──────────────────────────────────────────────────
create table clients (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  name             text not null,
  address          text,
  city             text,
  kennitala        text,
  email            text not null,
  invoice_prefix   text not null,
  invoice_counter  integer not null default 1000,
  hourly_rate      integer not null,
  bank_account     text,
  bank_utibú       text,
  bank_hb          text,
  bank_reikningur  text,
  archived         boolean not null default false,
  created_at       timestamptz default now()
);

create index clients_user on clients (user_id);

alter table clients enable row level security;

create policy "Users can read own clients"
  on clients for select using (auth.uid() = user_id);

create policy "Users can insert own clients"
  on clients for insert with check (auth.uid() = user_id);

create policy "Users can update own clients"
  on clients for update using (auth.uid() = user_id);

-- No delete policy — use archived flag instead, except for unused clients
create policy "Users can delete own clients"
  on clients for delete using (auth.uid() = user_id);


-- ── Invoices ─────────────────────────────────────────────────
-- Append-only for legal compliance (reglugerð nr. 505/2013, 7-year retention)
create table invoices (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id),
  client_id         uuid not null references clients(id),
  invoice_number    text not null,
  cycle_start       date not null,
  cycle_end         date not null,
  issued_date       date not null,
  due_date          date not null,
  final_date        date not null,
  hourly_rate       integer not null,
  total_minutes     integer not null,
  total_amount      integer not null,
  vsk_rate          integer not null default 0,
  vsk_amount        integer not null default 0,

  -- Immutable snapshots at time of generation
  issuer_name       text not null,
  issuer_kennitala  text not null,
  issuer_address    text not null,
  issuer_city       text not null,
  issuer_email      text not null,
  issuer_vsk        text,
  bank_account      text not null,
  bank_utibú        text not null,
  bank_hb           text not null,
  bank_reikningur   text not null,
  client_name       text not null,
  client_address    text,
  client_city       text,
  client_kennitala  text,
  client_email      text not null,

  pdf_path          text,
  is_draft          boolean not null default false,
  status            text not null default 'pending'
                    check (status in ('pending', 'sent', 'failed')),
  sent_at           timestamptz,
  error_message     text,

  -- Drafts always insert (each is a point-in-time snapshot)
  -- Real invoices are protected by application-level duplicate check

  created_at        timestamptz default now()
);

create index invoices_user   on invoices (user_id, created_at desc);
create index invoices_client on invoices (client_id);
create index invoices_status on invoices (status);

alter table invoices enable row level security;

create policy "Users can read own invoices"
  on invoices for select using (auth.uid() = user_id);

create policy "Users can insert own invoices"
  on invoices for insert with check (auth.uid() = user_id);

create policy "Users can update own invoices"
  on invoices for update using (auth.uid() = user_id);

-- No delete policy


-- ── Invoice entries (immutable snapshot) ─────────────────────
create table invoice_entries (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references invoices(id),
  entry_id         uuid not null references entries(id),
  name             text not null,
  date             date not null,
  time_from        time not null,
  time_until       time not null,
  minutes          integer not null,
  crosses_midnight boolean not null default false,
  line_number      integer not null,
  line_amount      integer not null
);

create index invoice_entries_invoice on invoice_entries (invoice_id, line_number);

alter table invoice_entries enable row level security;

create policy "Users can read own invoice entries"
  on invoice_entries for select
  using (exists (
    select 1 from invoices i
    where i.id = invoice_entries.invoice_id and i.user_id = auth.uid()
  ));

create policy "Users can insert own invoice entries"
  on invoice_entries for insert
  with check (exists (
    select 1 from invoices i
    where i.id = invoice_entries.invoice_id and i.user_id = auth.uid()
  ));

create policy "Users can delete own draft invoice entries"
  on invoice_entries for delete
  using (exists (
    select 1 from invoices i
    where i.id = invoice_entries.invoice_id
    and i.user_id = auth.uid()
    and i.is_draft = true
  ));


-- ── Wire up foreign key from entries → invoices ──────────────
alter table entries
  add constraint entries_invoice_fk
  foreign key (invoice_id) references invoices(id);


-- ── Storage: private PDF bucket ──────────────────────────────
insert into storage.buckets (id, name, public)
  values ('invoices', 'invoices', false)
  on conflict (id) do nothing;

create policy "Users can upload own invoice PDFs"
  on storage.objects for insert
  with check (
    bucket_id = 'invoices'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can read own invoice PDFs"
  on storage.objects for select
  using (
    bucket_id = 'invoices'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- No delete policy on storage


-- ── Atomic invoice counter ───────────────────────────────────
create or replace function increment_client_invoice_counter(p_client_id uuid)
returns integer language plpgsql security definer as $$
declare v_counter integer;
begin
  update clients
    set invoice_counter = invoice_counter + 1
  where id = p_client_id
  returning invoice_counter into v_counter;
  return v_counter;
end;
$$;
