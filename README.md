# Reikn.log

Invoice management app for generating and sending Icelandic-compliant PDF invoices. Automatically sends a draft for review on the 22nd and the real invoice to clients on the 25th. Part of a two-app system — time and km logging lives in a separate repo (`logger`) that shares the same Supabase project.

---

## What it does

- **Dashboard** — current cycle hours, km, and projected invoice amount per client, with countdown to the 22nd and 25th
- **Clients** — add, edit, archive, and delete (unused) clients with per-client hourly rate, km rate, invoice prefix, and bank detail overrides. Archived clients hidden by default
- **Invoices** — full history of all drafts and real invoices, each showing the point-in-time amount frozen at generation. PDFs accessible via signed URLs
- **Settings** — issuer details, bank details, default rates, VSK rate, payment cycle, preview email, copy-to-self
- **Manual controls** per client on dashboard:
  - 👁 Preview — generate PDF, view in-browser (creates a frozen draft row)
  - ✉ Send draft to me — generate DRAFT PDF and email to your preview address
  - ⚡ Send invoice — send real invoice to client, lock entries
- **Automatic monthly sends:**
  - 22nd at 09:00 UTC — DRAFT invoice emailed to your preview address
  - 25th at 09:00 UTC — real invoice sent to client
- Each draft generation creates a new immutable row with the frozen amount at that point in time
- Drafts older than 14 days are cleaned up automatically on next generation
- When a real invoice is sent, all drafts for that cycle are deleted
- Invoice format complies with Icelandic law (reglugerð nr. 505/2013)
- VSK (VAT) support — set rate in Settings. Currently 0% (not registered). Set to 24 when registered with Skatturinn
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
    auth.js                         — auth state, login/forgot password UI
    router.js                       — path-based SPA router
    utils.js                        — shared pure helpers
    main.js                         — bootstrapper, routing, global actions
    components/
      toast.js                      — auto-dismisses after 3s, click to dismiss
      spinner.js
    pages/
      dashboard.js                  — current cycle overview per client (/)
      clients.js                    — client management (/clients)
      invoices.js                   — invoice history and PDF viewer (/invoices)
      settings.js                   — issuer details, bank, VSK, notifications (/settings)
  netlify/
    functions/
      generate-invoice.js           — core: PDF via PDFShift, storage, email, entry locking
      send-staging.js               — scheduled 22nd: draft to preview_email
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
logger.franklin.is    →   dev / prod Supabase project   ←   invoices.franklin.is
owns: profiles,                  (shared DB)                  owns: clients, invoices,
      entries, km_entries                                      invoice_entries
```

`generate-invoice.js` is the single source of truth for all invoice logic. The scheduled functions, manual dashboard actions, and preview all call it with different parameters.

**Draft behaviour:** Every preview or send-draft call inserts a new immutable row with the frozen `total_amount`. Drafts never overwrite each other. The invoices tab shows all drafts with their point-in-time amounts.

**Real invoice behaviour:** A duplicate check runs in code before inserting — only one real invoice per client per cycle can ever exist.

---

## Security

- `SUPABASE_SERVICE_KEY` lives only in Netlify environment variables — never in client-side code
- The anon key in `src/supabase.js` is safe for browser use — RLS enforces per-user isolation
- All user data is HTML-escaped before entering the PDF template
- PDFs stored in a private Supabase Storage bucket, served via signed URLs (10 min)
- `invoices` and real `invoice_entries` have no delete RLS — required by Icelandic law (7-year retention)
- Draft `invoice_entries` can be deleted to allow entry deletion before invoicing
- Cloudflare IP geoblocking on `franklin.is` restricts access to Icelandic IPs
- Public signups disabled — accounts created manually in Supabase dashboard

---

## Setup

### 1. Run migrations in order in each Supabase project

```
logger/supabase/migrations/001_timelog.sql        — profiles + entries + RLS + trigger
invoices/supabase/migrations/002_invoices.sql     — this repo
logger/supabase/migrations/003_entries_client.sql — adds client_id FK to entries
logger/supabase/migrations/004_km_entries.sql     — km_entries + km_rate columns
```

**Disable public signups:** Authentication → Settings → disable "Enable Signups".

**Set Auth URLs:** Authentication → URL Configuration → add all your site URLs as redirect URLs.

### 2. Configure Supabase credentials

Open `src/supabase.js`:

```js
const ENV_CONFIG = {
  dev: {
    url:     'YOUR_DEV_SUPABASE_URL',
    anonKey: 'YOUR_DEV_SUPABASE_ANON_KEY',
  },
  prod: {
    url:     'YOUR_PROD_SUPABASE_URL',
    anonKey: 'YOUR_PROD_SUPABASE_ANON_KEY',
  },
};

const TEST_HOST = 'test--enchanting-sfogliatella-b979c6.netlify.app';
```

### 3. Set Netlify environment variables

Set these in the Netlify dashboard per deploy context (test/prod):

```
SUPABASE_URL           — Supabase project URL
SUPABASE_SERVICE_KEY   — service role key (secret, server-side only)
RESEND_API_KEY         — Resend API key
INVOICE_FROM_EMAIL     — e.g. invoices@franklin.is
PDFSHIFT_API_KEY       — PDFShift API key (pdfshift.io)
```

Also create a local `.env` file (gitignored) in the invoices folder for local function testing.

### 4. Verify sending domain in Resend

resend.com → Domains → Add → `franklin.is`. Add DKIM and SPF DNS records.

### 5. Fill in issuer details

Log in → Settings → fill in your name, kennitala, address, email, bank details, and VSK rate (0 if not registered). The dashboard warns you until these are complete.

### 6. Local development

```powershell
npm install
netlify dev
```

Opens on `http://localhost:8889`. Use the deployed test logger site pointing at the same dev Supabase project when running invoices locally to avoid Netlify Dev port conflicts.

Test scheduled functions via CLI:
```powershell
netlify functions:invoke send-staging --port 8889
```

---

## Invoice flow

### Automatic
| Date | What happens |
|---|---|
| 22nd at 09:00 UTC | DRAFT PDF per client, watermarked, emailed to `preview_email` |
| 25th at 09:00 UTC | Real PDF per client, emailed to client, entries locked |

### Manual (dashboard)
| Action | What happens |
|---|---|
| 👁 Preview | PDF generated, shown in modal, new frozen draft row inserted |
| ✉ Send draft to me | DRAFT PDF emailed to `preview_email`, new frozen draft row inserted |
| ⚡ Send invoice | Real PDF sent to client, entries locked, old drafts deleted |

### Invoice dates
- **Útgáfudagur** (issue date): 25th of the month
- **Gjalddagi** (due date): 25th of the month
- **Eindagi** (final deadline): 1st of the following month

### Draft lifecycle
- Each preview or send-draft creates a new immutable row with frozen `total_amount`
- The amount shown in the invoices tab is always the amount from when that draft was generated
- Drafts auto-delete after 14 days
- When a real invoice is sent, all drafts for that cycle are deleted

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
- `REIKNINGUR` header with invoice number
- `GREIÐANDI` block: client details
- Date block: Gjalddagi, Útgáfudagur, Eindagi, Til greiðslu
- Line items:
  - Time entries: `Vörunr. 2` — description + time range + hours
  - KM entries: `Vörunr. 3` — from → to + km
- Tax summary with VSK rate and amounts
- Bank payment details
- Footer: `Reikningur útgefinn af reikningakerfi Franklin skv. reglugerð nr. 505/2013.`

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
- No DELETE (7-year legal retention)

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
Each row is an immutable point-in-time snapshot. Drafts accumulate; real invoices are one per cycle per client.

| Column | Type | Notes |
|---|---|---|
| `invoice_number` | text | e.g. YRAB-1001 or YRAB-DRAFT |
| `cycle_start`, `cycle_end` | date | Billing period |
| `issued_date`, `due_date`, `final_date` | date | 25th / 25th / 1st of next |
| `total_amount` | integer | Frozen at generation — never updated |
| `vsk_rate` | numeric | Frozen at generation |
| `vsk_amount` | integer | Frozen at generation |
| `is_draft` | boolean | True for all non-real invoices |
| `status` | text | pending / sent / failed |
| `pdf_path` | text | Unique timestamped path in Supabase Storage |
| Issuer/client snapshot columns | text | Immutable copy at generation time |

### `invoice_entries`
Immutable snapshot of time entries included in each invoice. Draft entries can be deleted to allow entry deletion; real entries cannot.
