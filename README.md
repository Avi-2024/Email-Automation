# Mailroom — Email Marketing Operations

One Cloudflare Worker URL for an authenticated admin dashboard, consent-based subscribers, Brevo email campaigns, scheduled automation, and campaign reports. No separate VPS or frontend hosting required. The starter targets **Brevo Free (up to 300 provider email sends per day)** and Cloudflare free-tier capacity; neither is guaranteed to remain free or unlimited.

**Live URL (your existing deployment):** `https://zero-cost-bulk-mailer.royalitservice-mailer.workers.dev`

## Features included

| Area | Available in Mailroom |
| --- | --- |
| Dashboard | Campaign totals, scheduled/sent status, contacts, sending mode |
| Campaign manager | Multiple campaigns on the same IST day, create, edit and delete queued future campaigns; recover blocked unsent campaigns by rescheduling |
| Marketing composer | HTML editor, personalized `{{ contact.FNAME }}`, preheader/preview text, sandboxed preview, starter template and UTM link builder |
| Safe test send | Explicit one-recipient Brevo marketing test API (up to **3 tests per IST day** inside Mailroom, independent of the account's provider test limit); deletes temporary draft on best effort |
| Contacts | Opt-in CSV upload, add, list, edit names, remove from current list only, view recent contact-level Brevo campaign engagement |
| Analytics | In-app campaign reports: attempted sends, delivered, opens (approximate), unique clicks, hard/soft bounces, unsubscribes, complaints, linked URL click counts |
| Summary & export | Most recent 5 Brevo-backed campaigns, **clearly labeled partial**, CSV export of the displayed sample; detailed report on any currently listed campaign with a Brevo ID |
| Scheduling | Cloudflare Cron every 10 minutes, time displayed IST, dry-run guard, atomic D1 daily send quota, no blind retries after ambiguous provider operations |
| Security | Secret API credentials only in Cloudflare Workers, `ADMIN_TOKEN` in session memory only; no client-side Brevo API access, restrictive CSP, no public admin reads |

**Important limitations:** Mailroom's 300-cap is an **internal attempt reservation**, not a real-time measurement of Brevo's account-wide remaining credits. Emails sent outside Mailroom, recipient changes between queueing and sending, and Brevo's own quota reset clock can make provider balances differ. The sender must review provider limits when using any other sending channel. Reports require Brevo tracking to be enabled/available; privacy features and image blockers make opens approximate. Google Analytics conversions, revenue attribution, geographic analytics, inbox placement, and CRM automation are **not** built or inferred. To measure purchases/leads, instrument the destination website and connect its analytics in a separate phase. Consent sources are checked on import, but a dedicated tamper-evident consent audit journal is not yet implemented.

## Critical migration for EXISTING installations (safe maintenance procedure)

Your existing production D1 `campaigns` table has `day_ist TEXT NOT NULL UNIQUE`. Updating JavaScript alone cannot remove this SQLite constraint. **You must run the one-time migration before enabling live sending in the upgraded Worker.** It reconstructs the table with all existing campaign rows, IDs, statuses, timestamps, Brevo IDs, and HTML preserved. It adds quota tracking and preview fields. Campaigns in older `submitted`, `working`, `prepared`, or `needs_review` states conservatively consume all 300 internal attempt slots **for their scheduled IST day**, because actual historical recipient counts are unknown. Existing queued campaigns do not have an estimate until rescheduled; the runtime still checks the actual list count and enforces the quota.

In **PowerShell, inside the GitHub project root**, using the same Cloudflare account as the Worker:

```powershell
# 1. Get latest source, run tests
git pull origin main
npm install
npm test

# 2. Back up your existing D1 database before changing its schema
node .\node_modules\wrangler\bin\wrangler.js d1 export email_automation --remote --output=./mailroom-d1-backup.sql

# 3. SAFE FIRST: deploy updated Worker with committed DRY_RUN=true.
# This pauses live sending; contact/campaign endpoints may briefly return errors
# until step 4's database migration completes.
node .\node_modules\wrangler\bin\wrangler.js deploy

# 4. RUN ONCE ONLY: remove old one-campaign-per-day constraint and add quota ledger
node .\node_modules\wrangler\bin\wrangler.js d1 execute email_automation --remote --file=./migrations/002_multi_campaign_quota.sql

# 5. Verify campaigns and quotas survived
node .\node_modules\wrangler\bin\wrangler.js d1 execute email_automation --remote --command "SELECT COUNT(*) AS total FROM campaigns"
node .\node_modules\wrangler\bin\wrangler.js d1 execute email_automation --remote --command "SELECT day_ist,attempted FROM daily_send_usage ORDER BY day_ist DESC LIMIT 5"

# 6. Refresh dashboard, ensure SAFE MODE and test UI/reports before live sending
```

**Do not run the migration twice.** A sentinel (`mailroom_schema_migration_002`) deliberately makes the second attempt fail instead of silently losing new columns. Do not run `schema.sql` over an existing production table to attempt a migration; the correct file is `migrations/002_multi_campaign_quota.sql`. Do not run campaign sends while a D1 migration is being applied. This procedure deploys SAFE MODE first, accepting temporary dashboard errors to avoid an accidental live send during a schema rebuild. If the migration reports an error, **leave the upgraded Worker in SAFE MODE** and inspect/restore the DB before using the dashboard. In case an interrupted SQL operation needs recovery, use Cloudflare D1 Time Travel/restore before retrying and verify restored campaign counts. If you cannot perform the migration safely, stay on the currently deployed version.

**Deployment defaults to `DRY_RUN = "true"`** in committed `wrangler.toml`. Your currently deployed Worker may have `LIVE SENDING` enabled through a local edit. Deploying this repository config sets it back to **SAFE MODE**. Keep it safe while verifying reports, contacts and quota. When ready for actual sending, verify that the list contains only intended opted-in recipients, review any past-due queued campaigns, then explicitly switch `DRY_RUN` to `"false"` in your local `wrangler.toml` and redeploy. **Past-due campaigns can send automatically on the next cron run.** Never commit real API keys or admin tokens.

For new installations only:

```powershell
node .\node_modules\wrangler\bin\wrangler.js d1 execute email_automation --remote --file=./schema.sql
```

## Worker configuration

Five Cloudflare Worker secrets (set once, **never add values to GitHub**):

```powershell
node .\node_modules\wrangler\bin\wrangler.js secret put ADMIN_TOKEN
node .\node_modules\wrangler\bin\wrangler.js secret put BREVO_API_KEY
node .\node_modules\wrangler\bin\wrangler.js secret put BREVO_LIST_ID
node .\node_modules\wrangler\bin\wrangler.js secret put SENDER_EMAIL
node .\node_modules\wrangler\bin\wrangler.js secret put SENDER_NAME
node .\node_modules\wrangler\bin\wrangler.js secret list
```

`BREVO_LIST_ID` must be **the numeric Brevo Contacts list ID**, not a Brevo or SMTP API key. `BREVO_API_KEY` is a Brevo **API v3 key**, not SMTP credentials. The list must belong to the same Brevo account. Sender email must be verified with suitable authentication (SPF/DKIM/DMARC as directed by Brevo); publisher address/privacy disclosures and native unsubscribe link are required for legitimate consent-based marketing. The Worker keeps the Brevo API key server-side.

Configuration: `MAX_DAILY_RECIPIENTS="300"` is verified by application logic to be at most 300; `DRY_RUN="true"` prevents automated campaign submissions. Test sends are a separate explicitly requested path and **will send a real test email even in dry-run**.

## Daily budget explained

1. On schedule, the Worker reads the current selected Brevo list count. Estimated budget = already attempted through this Worker on that IST day + queued estimates + new campaign estimate. Requests exceeding 300 are rejected; an empty list is rejected.
2. On the due-date cron, it reads the **current** list count again, then atomically increments `daily_send_usage.attempted` only if the total stays within 300. Two concurrent cron executions cannot double-spend the same allowance.
3. The quota reservation persists if Brevo's external campaign creation/send might have succeeded, even on timeout. This sacrifices some unused capacity but prevents silent duplicate or over-budget sends. `needs_review` campaigns are **never** auto-retried after an external mutation attempt.
4. If a queued campaign no longer fits the daily allowance at send time, it becomes `blocked`. Edit it and reschedule to a future day. Sending from other applications connected to the same Brevo account isn't included in this app's attempt ledger.
5. Brevo's free plan account-wide daily balance and clock always govern actual delivery. The UI **does not** claim live provider balance. Other Brevo test sends can also consume provider credits.

## Marketing reporting, without visiting Brevo

Login at your existing Worker URL, go to **Analytics** and select **View report** for a campaign. The Worker uses only:
- `GET /v3/emailCampaigns/{id}?statistics=globalStats&excludeHtmlContent=true`
- `GET /v3/emailCampaigns/{id}?statistics=linksStats&excludeHtmlContent=true`

It returns a minimal safe subset of metrics and link click counts. No provider HTML, admin token or provider API key is returned. The summary checks only the most recent five campaigns with a known Brevo ID and is labeled as a sample rather than all-time analytics. A campaign with `queued` status has no performance stats yet. A campaign with `submitted` status means the submission was accepted; actual delivery is recorded by Brevo after processing. To see recent activity for a specific subscriber in the selected list, open **Contacts → Activity**, backed by Brevo's contact campaignStats, and filtered to campaigns created in Mailroom. Availability and lookback depend on Brevo's API/account and data processing.

Link and open tracking must be enabled/available for the Brevo account. For visits on **your own website**, use the **UTM link builder** in the composer and install an analytics solution on the target site; Mailroom currently displays click counts, **not** website sessions, purchases or ROI.

### Contact consent policy

Import only people who explicitly agreed to receive *your specific marketing messages* and can withdraw permission. A Gmail address book or address list is **not** equivalent to marketing consent. The CSV requires `email,first_name,last_name,consent,consent_source` and `consent=yes`. Existing contacts are skipped—not re-subscribed—and deletion removes membership in the selected list only, preserving other lists and suppression records. The user is responsible for preserving signed/source evidence outside Mailroom until a dedicated consent ledger is implemented.

## API routes (Bearer ADMIN_TOKEN unless otherwise noted)

| Path | Method | Purpose |
| --- | --- | --- |
| `/health` | GET (public) | Worker health and safe mode |
| `/admin/config` | GET | Read-only sender/list/safe mode info |
| `/admin/campaigns` | GET, POST | List and schedule campaigns |
| `/admin/campaigns/{id}` | GET, PUT, DELETE | Detail; guarded edit/delete of future queued or blocked unsent campaigns |
| `/admin/campaigns/{id}/report` | GET | Full mapped Brevo campaign stats and tracked links |
| `/admin/reports/summary` | GET | Limited last-five-campaign aggregate |
| `/admin/quota?day=YYYY-MM-DD` | GET | IST daily attempted/queued estimates (external sends excluded) |
| `/admin/run` | POST | Check due jobs (may send in live mode) |
| `/admin/test-send` | POST | Explicit test email to one controlled address; limited to 3/day |
| `/admin/contacts` | GET, POST | Paginated list and consent-checked import |
| `/admin/contacts/{email}` | PUT, DELETE | Edit names / remove from current list only |
| `/admin/contacts/{email}/activity` | GET | Available Brevo per-contact campaign engagement |
| `/admin/campaigns/{id}/brevo` | GET | Raw subset of provider campaign status (legacy route) |

## Tests

Run `npm test` on Node.js 22+; GitHub Actions also runs tests for every PR and push to `main`. Tests use fake D1/Brevo responses and **do not** send email or change live Cloudflare. One-time migration is additionally validated with SQLite locally before pull requests are merged; Brevo integration and live provider reporting need smoke testing on the authorized real account after deployment.

## Primary API documentation

- [Brevo campaign report](https://developers.brevo.com/reference/get-email-campaign)
- [Brevo contact engagement](https://developers.brevo.com/reference/get-contact-stats)
- [Brevo send test email](https://developers.brevo.com/reference/send-test-email)
- [Brevo create campaign](https://developers.brevo.com/reference/create-email-campaign)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

## D1-only CRM Prospects — new feature

After a remote D1 backup, run `node .\node_modules\wrangler\bin\wrangler.js d1 execute email_automation --remote --file=./migrations/003_prospects_crm.sql` **before** deploying this code with `node .\node_modules\wrangler\bin\wrangler.js deploy`. This migration is additive and idempotent; it creates only a `prospects` table and its index and does not alter campaigns or the Brevo audience. The committed `wrangler.toml` still defaults to `DRY_RUN="true"`. Check for past-due queued campaigns before ever enabling live sending.

The new **Prospects** sidebar page is an independent CRM. Import CSV requires only the `email` column; `first_name`, `last_name`, and `company` are optional. Other columns are ignored. It accepts 1–1,000 rows per CSV file and sends batches of 50 to the authenticated D1-only API; existing emails are skipped. Prospects may be searched, added, edited, assigned `new`, `contacted`, `replied`, `qualified`, `closed`, or `do_not_contact` statuses, and deleted. They are **never added to Brevo, emailed by cron, or counted against campaign limits**. Importing does not infer marketing consent. Honor opt-outs and do not use bounced leads for renewed outreach.

The **Subscribers** page still uses Brevo and keeps its separate evidence-based opt-in import requiring `email,first_name,last_name,consent,consent_source`, plus explicit consent validation. There is intentionally no automated CRM-to-marketing promotion. Prospect endpoints (ADMIN_TOKEN protected): `GET /admin/prospects`, `POST /admin/prospects`, `POST /admin/prospects/import`, `PUT /admin/prospects/{email}`, and `DELETE /admin/prospects/{email}`.
