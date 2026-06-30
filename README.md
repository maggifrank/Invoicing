# Reikn.log

Invoice management app for generating and sending Icelandic-compliant PDF invoices. Automatically sends a draft for review on the 22nd and the real invoice to clients on the 25th. Part of a two-app system — time and km logging lives in a separate repo (`logger`) that shares the same Supabase project.

---

## What it does

- **Dashboard** — current cycle hours, km, and projected invoice amount per client, with countdown to the 22nd and 25th
- **Clients** — add, edit, archive, and delete (unused) clients with per-client hourly rate, km rate, invoice prefix, and bank detail overrides. Archived clients hidden by default
- **Invoices** — full history of all drafts, real invoices, and credit invoices, each showing the point-in-time amount frozen at generation. PDFs accessible via signed URLs
- **Settings** — issuer details, bank details, default rates, VSK rate, payment cycle, preview email, copy-to-self, and user invites
- **Manual controls** per client on dashboard:
  - 👁 Preview — generate PDF, view in-browser (creates a frozen draft row)
  - ✉ Send draft to me — generate DRAFT PDF and email to your preview address
  - ⚡ Send invoice — send real invoice to client, lock entries
- **Per-invoice controls** on the invoices tab:
  - ✓ Mark as paid / Undo paid — track payment status on sent invoices, regenerates the PDF with a green "GREITT" stamp
  - ⟲ Issue credit invoice — cancel a sent invoice and unlock its entries for correction, regenerates the original's PDF with a red "ÓGILT" stamp
- **Automatic monthly sends:**
  - 22nd at 09:00 UTC — DRAFT invoice emailed to your preview address. If any client has no logged work that cycle, a single summary email lists them so you have 3 days to fix it before the 25th
  - 25th at 09:00 UTC — real invoice sent to client
- Each draft generation creates a new immutable row with the frozen amount at that point in time
- Drafts older than 14 days are cleaned up automatically on next generation
- When a real invoice is sent, all drafts for that cycle are deleted
- Invoice format complies with Icelandic law (reglugerð nr. 505/2013)
- VSK (VAT) support — set rate in Settings. Currently 0% (not registered). Set to 24 when registered with Skatturinn
- Hours and km on invoice line items display with 2 decimal places (e.g. 15 minutes = 0.25 klst)
- Invoice dates depend on context — see "Invoice dates" below
- Invite new users directly from Settings — no need to go through the Supabase dashboard
- After sending, `invoice_id` and `invoiced_at` are written back to both `entries` and `km_entries` in the logger app — entries become locked

---

## Project structure

```
invoices/
  index.html                        — app shell
  styles/
    main.css                        — shared design system + invoice styles
  src/
    supabase.js                     — Supabase client, fill in your keys here
    auth.js                         — auth state, login/forgot password/invite UI
    router.js                       — path-based SPA router
    utils.js                        — shared pure helpers
    main.js                         — bootstrapper, routing, global actions
    components/
      toast.js                      — auto-dismisses after 3s, click to dismiss
      spinner.js
    pages/
      dashboard.js                  — current cycle overview per client (/)
      clients.js                    — client management (/clients)
      invoices.js                   — invoice history, mark paid, credit invoices (/invoices)
      settings.js                   — issuer details, bank, VSK, notifications, invite user (/settings)
  netlify/
    functions/
      generate-invoice.js           — core: PDF via PDFShift, storage, email, entry locking
      issue-credit-invoice.js       — generates a credit invoice, cancels + restamps original, unlocks entries
      restamp-invoice-pdf.js        — regenerates an existing invoice PDF with GREITT/ÓGILT stamp in place
      invite-user.js                — sends a Supabase invite email via the Admin API
      send-staging.js               — scheduled 22nd: draft to preview_email, plus no-work summary
      send-invoices.js              — scheduled 25th: real invoice to client
  netlify.toml                      — SPA redirect, dev port 8889, secrets scan omit
  package.json                      — @supabase/supabase-js, resend
  supabase/
    migrations/
      002_invoices.sql              — clients, invoices, invoice_entries, storage, RLS, counter fn
```

---

## Architecture

Shares the same Supabase project as the logger app. This repo owns the invoice schema. The logger repo creates `profiles`, `entries`, and `km_entries` — its migrations must run first.

```
logger.talva.is    →   dev / prod Supabase project   ←   invoicing.talva.is
owns: profiles,               (shared DB)                  owns: clients, invoices,
      entries, km_entries                                   invoice_entries
```

`generate-invoice.js` is the single source of truth for normal invoice logic. The scheduled functions, manual dashboard actions, and preview all call it with different parameters. `issue-credit-invoice.js` is a separate function dedicated to the credit/correction flow.

**Draft behaviour:** Every preview or send-draft call inserts a new immutable row with the frozen `total_amount`. Drafts never overwrite each other. The invoices tab shows all drafts with their point-in-time amounts.

**Real invoice behaviour:** A duplicate check runs in code before inserting — only one real invoice per client per cycle can ever exist (excluding credit invoices, which are a separate row type).

**Credit invoice behaviour:** Real invoices are never deleted or edited — Icelandic law requires a full audit trail. Instead, a credit invoice (kreditreikningur) is issued as a new row referencing the original via `credit_for_invoice_id`, with negative amounts that cancel the original in full. The entries originally locked by that invoice are unlocked so they can be corrected and re-invoiced as a fresh transaction.

---

## Security

- The service role key lives only in Netlify environment variables — never in client-side code
- The anon key in `src/supabase.js` is safe for browser use — RLS enforces per-user isolation
- All user data is HTML-escaped before entering the PDF template
- PDFs stored in a private Supabase Storage bucket, served via signed URLs (10 min)
- `invoices` and real `invoice_entries` have no delete RLS — required by Icelandic law (7-year retention)
- Draft `invoice_entries` can be deleted to allow entry deletion before invoicing
- Cloudflare IP geoblocking on `talva.is` restricts access to Icelandic IPs
- Public signups disabled — accounts created via the in-app invite flow (Settings → Invite user) or manually in Supabase dashboard
- The invite function uses the service role key server-side only — the redirect URL is controlled by the `SITE_URL` environment variable, not client input

---

## Setup

### 1. Run migrations in order in each Supabase project

```
logger/supabase/migrations/001_timelog.sql        — profiles + entries + RLS + trigger
invoices/supabase/migrations/002_invoices.sql     — this repo
logger/supabase/migrations/003_entries_client.sql — adds client_id FK to entries
logger/supabase/migrations/004_km_entries.sql     — km_entries + km_rate columns
```

If you already had `002_invoices.sql` applied before paid tracking and credit invoices were added, also run:

```sql
alter table profiles add column if not exists vsk_rate numeric(5,2) not null default 0;
alter table profiles add column if not exists default_km_rate integer;
alter table clients  add column if not exists km_rate integer;
alter table invoices add column if not exists paid_at timestamptz;
alter table invoices add column if not exists is_credit boolean not null default false;
alter table invoices add column if not exists credit_for_invoice_id uuid references invoices(id);

-- Convert status from text+check to a proper enum (run the drop BEFORE creating the type)
alter table invoices drop constraint if exists invoices_status_check;
create type invoice_status as enum ('pending', 'sent', 'failed', 'cancelled');
alter table invoices alter column status drop default;
alter table invoices alter column status type invoice_status using status::invoice_status;
alter table invoices alter column status set default 'pending';
```

**Disable public signups:** Authentication → Settings → disable "Enable Signups". Use the in-app invite flow instead.

**Set Auth URLs:** Authentication → URL Configuration → add all your site URLs as redirect URLs, including the production domain, test Netlify URL, and `http://localhost:8889`.

### 2. Configure Supabase credentials

Open `src/supabase.js`:

```js
const ENV_CONFIG = {
  dev: {
    url:          'YOUR_DEV_SUPABASE_URL',
    anonKey:      'YOUR_DEV_SUPABASE_ANON_KEY',
    companionUrl: 'http://localhost:8888',
  },
  test: {
    url:          'YOUR_DEV_SUPABASE_URL',
    anonKey:      'YOUR_DEV_SUPABASE_ANON_KEY',
    companionUrl: 'https://test--timaskraning.netlify.app',
  },
  prod: {
    url:          'YOUR_PROD_SUPABASE_URL',
    anonKey:      'YOUR_PROD_SUPABASE_ANON_KEY',
    companionUrl: 'https://logger.talva.is',
  },
};

const TEST_HOST = 'test--enchanting-sfogliatella-b979c6.netlify.app';
```

`companionUrl` is the Logger app URL for the cross-app nav link in the bottom bar, resolved per environment.

### 3. Set Netlify environment variables

Set these in the Netlify dashboard per deploy context (test/prod):

```
SUPABASE_URL           — Supabase project URL
SUPABASE_SERVICE_KEY   — service role key (secret, server-side only)
RESEND_API_KEY         — Resend API key
INVOICE_FROM_EMAIL     — e.g. invoices@talva.is
PDFSHIFT_API_KEY       — PDFShift API key (pdfshift.io)
SITE_URL               — this app's own URL, used as the invite redirect target
```

Also create a local `.env` file (gitignored) in the invoices folder for local function testing.

### 4. Verify sending domain in Resend

resend.com → Domains → Add → `talva.is`. Add DKIM and SPF DNS records.

### 5. Fill in issuer details

Log in → Settings → fill in your name, kennitala, address, email, bank details, and VSK rate (0 if not registered). The dashboard warns you until these are complete.

### 6. Invite additional users

Settings → Invite user → enter their email → Send invite. They receive a Supabase invite email; clicking it currently signs them straight in via the Logger app (the companion redirect). They can set or change their password any time via Forgot password on the login screen.

### 7. Local development

```powershell
npm install
netlify dev
```

Opens on `http://localhost:8889`. Use the deployed test logger site pointing at the same dev Supabase project when running invoices locally to avoid Netlify Dev port conflicts.

Test scheduled functions via CLI:
```powershell
netlify functions:invoke send-staging --port 8889
netlify functions:invoke send-invoices --port 8889
```

---

## Invoice flow

### Automatic
| Date | What happens |
|---|---|
| 22nd at 09:00 UTC | DRAFT PDF per client, watermarked, emailed to `preview_email`. If any client has zero logged entries for the cycle, one summary email is sent listing them (`Enginn skráð vinna fyrir [client] á þessu tímabili.`) — gives 3 days to fix before the 25th |
| 25th at 09:00 UTC | Real PDF per client, emailed to client, entries locked. Clients with no entries are silently skipped, no email sent |

### Manual (dashboard)
| Action | What happens |
|---|---|
| 👁 Preview | PDF generated, shown in modal, new frozen draft row inserted |
| ✉ Send draft to me | DRAFT PDF emailed to `preview_email`, new frozen draft row inserted |
| ⚡ Send invoice | Real PDF sent to client, entries locked, old drafts deleted |

### Manual (invoices tab)
| Action | What happens |
|---|---|
| ✓ Mark as paid | Sets `paid_at`, badge turns green, PDF regenerated in place with a green "GREITT" stamp |
| Undo paid | Clears `paid_at`, PDF regenerated in place with the stamp removed |
| ⟲ Issue credit invoice | Generates and sends a `KREDITREIKNINGUR` cancelling the invoice in full, marks the original `cancelled`, regenerates its PDF in place with a red "ÓGILT" stamp, unlocks its entries |

### Invoice dates
Dates depend on how the invoice was generated:

| Context | Útgáfudagur / Gjalddagi | Eindagi |
|---|---|---|
| Scheduled 22nd/25th runs | 25th of the month | 1st of the following month |
| Manual Preview / Send draft / Send invoice | Today's date | Today + 7 days |
| Credit invoice | Today's date | Today + 7 days |

The 22nd draft preview uses the scheduled date scheme so it accurately previews what the 25th invoice will show.

### Draft lifecycle
- Each preview or send-draft creates a new immutable row with frozen `total_amount`
- The amount shown in the invoices tab is always the amount from when that draft was generated
- Drafts auto-delete after 14 days
- When a real invoice is sent, all drafts for that cycle are deleted

---

## Correcting a mistake on a sent invoice

Real invoices can never be edited or deleted — only cancelled via a credit invoice, which is the legally correct way to handle this in Iceland.

1. Open the invoices tab, find the sent invoice with the error
2. Tap **⟲ Issue credit invoice**
3. Confirm — this is irreversible
4. A `KREDITREIKNINGUR` is generated using the **next number in the normal client invoice sequence** (not a special suffix — it's indistinguishable from a regular invoice in numbering), with full line items matching the original and the total amount due referencing the cancelled invoice number, and emailed to the client
5. The original invoice's status is set to `cancelled` — shown with a grey badge and a struck-through amount, and the **Mark as paid** / **Issue credit invoice** buttons disappear from it
6. The original's PDF is regenerated in place with a red "ÓGILT" stamp so the downloadable document itself reflects its cancelled state, not just the app's UI
7. The time and km entries originally locked by that invoice are unlocked
8. Go to Logger, correct the entries (fix the time, client, rate — whatever was wrong)
9. Generate and send a fresh invoice for that cycle as normal

A credit invoice can only be issued once per original invoice — the button disappears once a credit exists. Credits cannot be issued for drafts or for other credit invoices.

---

## PDF status stamps

When the status of a sent invoice changes after it was first generated, the stored PDF is regenerated in place at the same `pdf_path` so the file itself — not just the app UI — reflects reality. This matters because invoices may be downloaded, forwarded, or archived outside the app.

| Status | Stamp |
|---|---|
| Marked as paid | Green diagonal "GREITT" |
| Undo paid | Stamp removed, plain reissue |
| Cancelled via credit invoice | Red diagonal "ÓGILT" |

This is handled by `restamp-invoice-pdf.js`, which rebuilds the PDF from the invoice row's own frozen snapshot data (issuer/client details, line items, totals) — no live entries are touched, and the existing signed URL keeps working since the file path doesn't change. If a restamp call fails, it's treated as non-fatal — the status itself still updates correctly, just without the visual stamp.

---

## VSK (VAT)

Configured in Settings → VSK rate (%).

- **0%** (default, not registered): invoices show `Z(0%)`, zero VAT
- **24%** (registered with Skatturinn): invoices show `S(24%)`, VAT calculated per line item and shown in tax summary

The VSK rate is frozen in the invoice row at generation time.

B2B compliance: client consent to receive electronic invoices should be covered in your service agreement.

---

## Invoice format (reglugerð nr. 505/2013)

- Issuer: name, kennitala, address, email, VSK number
- `REIKNINGUR` header with invoice number (or `KREDITREIKNINGUR` for credits)
- `GREIÐANDI` block: client details
- Date block: Gjalddagi, Útgáfudagur, Eindagi, Til greiðslu
- Line items:
  - Time entries: `Vörunr. 2` — description + time range + hours (2 decimal places)
  - KM entries: `Vörunr. 3` — from → to + km (2 decimal places)
- Tax summary with VSK rate and amounts
- Bank payment details
- Footer: `Reikningur útgefinn af reikningakerfinu Talva skv. reglugerð nr. 505/2013.`

---

## Resetting test data

```sql
update entries    set invoice_id = null, invoiced_at = null;
update km_entries set invoice_id = null, invoiced_at = null;
delete from invoice_entries;
delete from invoices;
update clients set invoice_counter = 1000;
```

---

## RLS policies

### `clients`
- SELECT, INSERT, UPDATE, DELETE: `auth.uid() = user_id`

### `invoices`
- SELECT, INSERT, UPDATE: `auth.uid() = user_id`
- No DELETE (7-year legal retention) — applies to real invoices and credit invoices alike

### `invoice_entries`
- SELECT, INSERT: via invoice owner check
- DELETE: only for draft invoices via invoice owner check
- No DELETE on real invoice entries

---

## Database schema (owned by this repo)

### `clients`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `user_id` | uuid | References `auth.users` |
| `name` | text | Company or person name |
| `address`, `city`, `kennitala` | text | Appear on invoice |
| `email` | text | Invoice recipient |
| `invoice_prefix` | text | e.g. YRAB |
| `invoice_counter` | integer | Incremented atomically on each real send |
| `hourly_rate` | integer | ISK per hour |
| `km_rate` | integer | ISK per km override (falls back to profile default) |
| `bank_account`, `bank_utibú`, `bank_hb`, `bank_reikningur` | text | Override issuer defaults |
| `archived` | boolean | Hidden by default in UI, toggle to show |

### `invoices`
Each row is an immutable point-in-time snapshot. Drafts accumulate; real invoices are one per cycle per client; credit invoices reference the original they cancel.

| Column | Type | Notes |
|---|---|---|
| `invoice_number` | text | e.g. YRAB-1001, YRAB-DRAFT, or YRAB-1007 (credit invoices use the next number in the normal sequence — no special suffix) |
| `cycle_start`, `cycle_end` | date | Billing period |
| `issued_date`, `due_date`, `final_date` | date | 25th / 25th / 1st of next |
| `total_amount` | integer | Frozen at generation — never updated. Negative for credit invoices |
| `vsk_rate` | numeric | Frozen at generation |
| `vsk_amount` | integer | Frozen at generation |
| `is_draft` | boolean | True for all non-real invoices |
| `is_credit` | boolean | True for credit invoices |
| `credit_for_invoice_id` | uuid | References the invoice this credit cancels |
| `status` | `invoice_status` enum | `pending` / `sent` / `failed` / `cancelled` — cancelled is set automatically when a credit invoice is issued against it |
| `paid_at` | timestamptz | Set when manually marked as paid |
| `pdf_path` | text | Unique timestamped path in Supabase Storage |
| Issuer/client snapshot columns | text | Immutable copy at generation time |

### `invoice_entries`
Immutable snapshot of time entries included in each invoice. Draft entries can be deleted to allow entry deletion; real entries cannot. Used when building a credit invoice's line items.
