# Reikn.log

Invoice management app for generating and sending Icelandic-compliant PDF invoices. Automatically sends a draft for review on the 22nd and the real invoice to clients on the 25th. Part of a two-app system — time logging lives in a separate repo (`timelog`) that shares the same Supabase project.

---

## What it does

- **Dashboard** — current cycle hours and projected invoice amount per client, with countdown to the 22nd and 25th
- **Clients** — add, edit, archive, and delete (unused) clients with per-client rates, prefix, and bank detail overrides. Archived clients hidden by default with a toggle to reveal them
- **Invoices** — full history of all drafts and real invoices, each showing the point-in-time amount frozen at generation. PDFs accessible via signed URLs
- **Settings** — issuer details, bank details, default rate, payment cycle, preview email, copy-to-self
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
- After sending, `invoice_id` and `invoiced_at` are written back to entries in the timelog app — entries become locked

---

## Project structure

```
invoices/
  index.html                        — app shell
  styles/
    main.css                        — shared design system (same as timelog) + invoice styles
  src/
    supabase.js                     — Supabase client, fill in your keys here
    auth.js                         — auth state and UI
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
      settings.js                   — issuer details, bank, notifications (/settings)
  netlify/
    functions/
      generate-invoice.js           — core: PDF via PDFShift, Supabase storage, Resend email
      send-staging.js               — scheduled 22nd: draft to preview_email
      send-invoices.js              — scheduled 25th: real invoice to client
  netlify.toml                      — SPA redirect, dev port 8889, secrets scan omit
  package.json                      — @supabase/supabase-js, resend (no puppeteer)
  supabase/
    migrations/
      002_invoices.sql              — clients, invoices, invoice_entries, storage, RLS, counter fn
```

---

## Architecture

Shares the same Supabase project as the timelog app. This repo owns the invoice schema. The timelog repo creates `profiles` and `entries` — its migrations must run first.

```
timelog.franklin.is   →   dev / prod Supabase project   ←   invoices.franklin.is
owns: profiles, entries          (shared DB)                  owns: clients, invoices, invoice_entries
```

`generate-invoice.js` is the single source of truth for all invoice logic. The scheduled functions, manual dashboard actions, and preview all call it with different parameters (`isDraft`, `sendEmail`).

**Draft behaviour:** Every preview or send-draft call inserts a new row with the frozen `total_amount` and a unique timestamped PDF path. Drafts never overwrite each other. The invoices tab shows all drafts with their point-in-time amounts so you can see how the invoice evolved.

**Real invoice behaviour:** A duplicate check runs in code before inserting — only one real invoice per client per cycle can ever exist.

---

## Security

- `SUPABASE_SERVICE_KEY` lives only in Netlify environment variables — never in client-side code
- The anon key in `src/supabase.js` is safe for browser use — RLS enforces per-user isolation
- All user data is HTML-escaped before entering the PDF template
- PDFs stored in a private Supabase Storage bucket, served via signed URLs only (10 min)
- `invoices` and `invoice_entries` (real) have no delete RLS — required by Icelandic law (7-year retention)
- Draft `invoice_entries` can be deleted by the user to allow entry deletion before invoicing
- Cloudflare IP geoblocking on `franklin.is` restricts access to Icelandic IPs
- Public signups disabled — accounts created manually in Supabase dashboard

---

## Setup

### 1. Run migrations in order in each Supabase project

```
timelog/supabase/migrations/001_timelog.sql        — profiles + entries + RLS + trigger
invoices/supabase/migrations/002_invoices.sql      — this repo
timelog/supabase/migrations/003_entries_client.sql — adds client_id FK to entries
```

**Disable public signups:** Authentication → Settings → disable "Enable Signups".

**Set Auth URLs:** Authentication → URL Configuration:
- Site URL: your production domain
- Redirect URLs: add test Netlify URL and `http://localhost:8889`

### 2. Configure Supabase credentials

Open `src/supabase.js` — use the same project URLs and anon keys as the timelog app:

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

const TEST_HOST = 'test--enchanting-sfogliatella-b979c6.netlify.app'; // ← your test subdomain
```

### 3. Set Netlify environment variables

In the Netlify dashboard for this site (both test and prod contexts):

```
SUPABASE_URL           — Supabase project URL
SUPABASE_SERVICE_KEY   — service role key (secret, bypasses RLS, server-side only)
RESEND_API_KEY         — Resend API key
INVOICE_FROM_EMAIL     — sending address e.g. invoices@franklin.is
PDFSHIFT_API_KEY       — PDFShift API key (pdfshift.io)
```

For test vs prod contexts, set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` per deploy context in Netlify's environment variable settings.

Also create a local `.env` file (gitignored) in the invoices folder with the same keys pointing at your dev Supabase project for local function testing.

### 4. Verify sending domain in Resend

resend.com → Domains → Add → `franklin.is`. Add the DKIM and SPF DNS records. Required for deliverability — invoices sent to spam are not legally delivered.

### 5. Fill in issuer details

Log in → Settings → fill in your name, kennitala, address, email, and bank details. The dashboard warns you until these are complete and blocks invoice generation.

### 6. Local development

```powershell
npm install
netlify dev
```

Opens on `http://localhost:8889`. Note: Netlify Dev uses an internal port that conflicts if the timelog instance is also running. Use the deployed test timelog site (`test--timaskraning.netlify.app`) pointing at the same dev Supabase project when running invoices locally.

PDF generation via PDFShift requires the `PDFSHIFT_API_KEY` env var — local function testing works once `.env` is set up.

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
| 👁 Preview | PDF generated, shown in modal via signed URL, new draft row inserted |
| ✉ Send draft to me | DRAFT PDF generated, emailed to `preview_email`, new draft row inserted |
| ⚡ Send invoice | Real PDF generated, sent to client, entries locked, old drafts deleted |

### Invoice dates
- **Útgáfudagur** (issue date): 25th of the month
- **Gjalddagi** (due date): 25th of the month (same as issued)
- **Eindagi** (final deadline): 1st of the following month

### Draft lifecycle
- Each preview or draft send creates a new immutable row
- Drafts auto-delete after 14 days (cleaned up on next generation)
- When a real invoice is sent, all drafts for that cycle are deleted
- The amount shown on each draft row in the invoices tab is frozen at generation time — it does not update if you add or remove time entries afterwards

---

## Invoice format (reglugerð nr. 505/2013)

- Issuer: name, kennitala, address, email, VSK number
- `REIKNINGUR` header with invoice number
- `GREIÐANDI` block: client name, address, kennitala, email
- Date block: Gjalddagi, Útgáfudagur, Eindagi, Til greiðslu
- Line items: Vörunr. `2` | description + time range + hours | Magn | Einingarverð | Vsk. 0% | Upphæð
- Tax summary: Z(0%), Samtals, Samtals vsk., Heildarupphæð
- Bank: Greiðsluaðferð: Millifærið á reikning + table
- Footer: `Reikningur útgefinn af reikningakerfi Franklin skv. reglugerð nr. 505/2013.`

Draft invoices add a large diagonal DRAFT watermark and `[DRAFT]` prefix in the email subject.

B2B compliance note: client consent to receive electronic invoices should be covered in your service agreement.

---

## Resetting test data

When clearing the test database before going to production:

```sql
-- Must run in this order due to foreign key constraints
update entries set invoice_id = null, invoiced_at = null;
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
- DELETE: only for draft invoices (`is_draft = true`) via invoice owner check
- No DELETE on real invoice entries (legal retention)

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
| `bank_account`, `bank_utibú`, `bank_hb`, `bank_reikningur` | text | Override issuer defaults |
| `archived` | boolean | Soft delete — hidden by default in UI |

### `invoices`
Each row is an immutable point-in-time snapshot. Drafts accumulate; real invoices are one per cycle per client.

| Column | Type | Notes |
|---|---|---|
| `invoice_number` | text | e.g. YRAB-1001 or YRAB-DRAFT |
| `cycle_start`, `cycle_end` | date | Billing period |
| `issued_date`, `due_date`, `final_date` | date | 25th / 25th / 1st of next |
| `total_amount` | integer | Frozen at generation — never updated |
| `is_draft` | boolean | True for all non-real invoices |
| `status` | text | pending / sent / failed |
| `pdf_path` | text | Unique timestamped path in Supabase Storage |
| `sent_at` | timestamptz | Set when email confirmed sent |
| Issuer/client snapshot columns | text | Immutable copy at generation time |

### `invoice_entries`
Immutable snapshot of entries included in each invoice. Decoupled from the live `entries` table. Draft `invoice_entries` can be deleted to allow entry deletion; real `invoice_entries` cannot.
