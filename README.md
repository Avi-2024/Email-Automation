# Zero-server-cost bulk marketing email automation

Cloudflare Workers (scheduled execution) + Cloudflare D1 (campaign queue) + Brevo marketing campaigns (personalized email delivery). Designed for **up to 300 recipients/day on the verified Brevo Free plan**, not 500/day. No VPS, always-on PC or paid automation service is required within the providers' free-tier limits.

**Scope:** consent-based marketing. Unsubscribe, complaint/bounce suppression and recipient campaign reporting are managed by Brevo. This is not a cold-email tool. **No messages are actually sent until you configure the credentials and turn off DRY_RUN.** Code and tests can be run locally without a Brevo account.

## Features
- Schedules campaigns at explicit time zone offsets. Cron checks every 10 minutes (UTC).
- Personalized messages via Brevo contact attribute `{{ contact.FNAME }}`.
- One campaign per calendar day in Asia/Kolkata (D1 UNIQUE constraint), preventing inadvertent daily overages.
- Server-side administrative Bearer token; never include token in a browser bundle.
- Appends Brevo's native unsubscribe link to each campaign: `{{ unsubscribe }}`.
- CSV import with affirmative opt-in and consent-source evidence. Existing contacts are **skipped**, not re-opted in.
- Safer handling of remote API uncertainty: after a create/send attempt, failures become `needs_review` rather than blind re-sends. Review the Brevo dashboard before taking action.
- Status listing and lookup of Brevo status by campaign ID.
- Dry run by default; logs no recipient email contents in scheduled execution.


## Mailroom admin dashboard (included)

The same Worker now serves a responsive admin dashboard from the `public/` folder; no second hosting service is necessary. It integrates with the existing Brevo and D1 resources rather than storing customer lists or credentials in the browser.

**After deploying:** Open your existing Worker URL **without** `/health`, then paste the `ADMIN_TOKEN` you set with `wrangler secret put`. The token is stored only in memory for the current tab; refreshing signs you out. The dashboard supports an overview, campaign list and filters, HTML email composer with sandboxed preview, time zone-aware scheduling, Brevo-backed contact browsing and permission-verified CSV imports, read-only sending settings, and manual checks. The admin API always checks the Bearer token.

Deploy from your local project directory after backing up your edits:

```powershell
npm install
npm test
node .\node_modules\wrangler\bin\wrangler.js deploy
```

The checked-in `wrangler.toml` contains the configured D1 database **ID**, which is not an API credential. **Never commit** `.dev.vars`, `.env`, any admin token, Brevo API key, or personal contact CSV file. Your existing Cloudflare Worker secrets remain remotely configured across standard deployments; verify them using `wrangler secret list` before activating live sending.

### Dashboard limitations and safety

- **DRY_RUN=true is the default**; it never sends marketing emails. Review the Brevo test recipient list before turning it off.
- The dashboard does **not** include a false claim of open, click, or delivered counts: those live in Brevo reporting. Submitted means only that Brevo accepted the API request.
- CSV imports are limited to 300 rows per import, 10 contacts per API call, and require opt-in consent and a consent source. Existing contacts are deliberately skipped instead of resubscribed. Large imports should be handled in smaller batches.
- The campaign API intentionally supports one campaign per IST day. It is not a drip campaign and cannot edit or delete queued campaigns through the UI.
- The page URL and static dashboard resources are public. The customer data and actions require your ADMIN_TOKEN. Do not expose that token to untrusted users or extensions. If you need multi-user roles, audit logs, or passkey sign-in, implement proper identity-based authentication rather than distributing the shared token.
- For local UI preview, run `npm run dev` with appropriate local D1 bindings, or serve `public/` directly for a static login-screen preview. Live API calls require a deployed Worker and configured secrets.

## Requirements
- **Node.js 22+** (Node.js 24 LTS recommended), npm, a free Cloudflare account, and a Brevo account with an approved sender. The current Wrangler CLI will reject Node.js 20.
- A sending domain you control, with DKIM/DMARC and SPF set according to Brevo's wizard. Domain purchase may cost money if you do not already own one.
- A Brevo contacts list (list ID), valid sender, and `FNAME`/`LNAME` contact attributes (create them in Brevo first if absent).
- All contacts must explicitly opt in. Only import consented customers. Honor unsubscribes, complaints, local privacy and marketing rules.

## Windows PowerShell quick start / troubleshooting

If the test command printed `Could not find ...tests\*.test.mjs`, your copy had a Unix-oriented wildcard in `package.json`. The corrected, portable test command is `node --test tests/core.test.mjs` (included in this archive). In a copy of the old folder you can apply the same fix without downloading again:

```powershell
npm pkg set "scripts.test=node --test tests/core.test.mjs"
npm test
```

If Wrangler reports `requires at least Node.js v22.0.0 ... you are using v20`, install **Node.js 24 LTS or newer** from https://nodejs.org/en/download . Close and reopen PowerShell (and VS Code if its terminal has the old PATH), then run:

```powershell
node -v
npm -v
npm install
npm test
npx wrangler login
npx wrangler d1 create email_automation
```

If `node -v` still shows v20, run `where.exe node` to look for conflicting installations. The test fix does not require upgrading Node, but Wrangler does.

## 1. Prepare Brevo
1. Sign up at https://www.brevo.com/ . Verify your sending domain and sender in Brevo.
2. Create contact attributes `FNAME` (text) and `LNAME` (text) if they don't already exist.
3. Create a list under Contacts -> Lists and copy the numeric list ID.
4. Create an API key under SMTP & API -> API keys. Store it securely and never commit it.
5. In Brevo Campaign Settings, configure physical sender details, reply address, and any required business disclosures.
6. Brevo Free supports 300 outgoing emails/day. A campaign with more recipients **requires manual requeue of remaining recipients**; this project rejects lists larger than the configured 300-person maximum to prevent partial sends.

## 2. Set up Cloudflare Worker and D1

```bash
npm install
npx wrangler login
npx wrangler d1 create email_automation
```

Copy the `database_id` printed by Cloudflare into `wrangler.toml` (replace `REPLACE_WITH_D1_DATABASE_ID`). Then:

```bash
npx wrangler d1 execute email_automation --remote --file=./schema.sql
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put BREVO_LIST_ID
npx wrangler secret put SENDER_EMAIL
npx wrangler secret put SENDER_NAME
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

Use a long random ADMIN_TOKEN (e.g. `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`). Set `SENDER_EMAIL` to an email Brevo has verified. `REPLY_TO_EMAIL` is optional (`npx wrangler secret put REPLY_TO_EMAIL`). No provider secrets are placed in Git or `wrangler.toml`.

**Cloudflare secret deployments:** The Worker must exist before adding secrets on some Wrangler versions. If `secret put` asks to create the Worker, accept, or deploy once first with `DRY_RUN = "true"`, then add the secrets.

Cloudflare is configured with a 10-minute UTC cron. The selected `scheduledAt` time controls actual eligibility. Real execution can be delayed; delivery time is approximate rather than guaranteed to the minute. `2026-10-16T09:00:00+05:30` means 09:00 IST.

## 3. Import customers (local CLI, no hosted server)

Save an opt-in contacts CSV with headings:

```csv
email,first_name,last_name,consent,consent_source
alice@example.com,Alice,Sharma,yes,2026-10-01 website signup confirmed
```

The first command validates CSV without contacting the provider; the second **actually imports contacts**. Run it on your own computer. Windows PowerShell examples:

```powershell
$env:BREVO_API_KEY="your_actual_api_key"
$env:BREVO_LIST_ID="your_numeric_list_id"
npm run import:contacts -- examples/contacts.csv
npm run import:contacts -- examples/contacts.csv --send
```

Bash/Linux/macOS:

```bash
export BREVO_API_KEY='your_actual_api_key'
export BREVO_LIST_ID='your_numeric_list_id'
npm run import:contacts -- examples/contacts.csv
npm run import:contacts -- examples/contacts.csv --send
```

Existing emails are intentionally skipped instead of overriding earlier unsubscribe/suppression choices. For deliberate resubscription, use Brevo's normal consent and resubscription flow. No unsubscribe or complaint suppression is stored separately in D1.

## 4. Schedule a personalized marketing email

Use your deployed workers.dev URL, e.g. `https://zero-cost-bulk-mailer.<your-subdomain>.workers.dev` (replace with the URL displayed by `wrangler deploy`). Do not expose your ADMIN_TOKEN in frontend JS.

### PowerShell

```powershell
$base='https://zero-cost-bulk-mailer.YOUR_SUBDOMAIN.workers.dev'
$token='PASTE_YOUR_ADMIN_TOKEN_HERE'
$headers=@{Authorization="Bearer $token"}
Invoke-RestMethod -Uri "$base/admin/campaigns" -Method Post -Headers $headers -ContentType 'application/json' -InFile 'examples/campaign.json'
Invoke-RestMethod -Uri "$base/admin/campaigns" -Method Get -Headers $headers
```

### Bash

```bash
BASE='https://zero-cost-bulk-mailer.YOUR_SUBDOMAIN.workers.dev'
TOKEN='PASTE_YOUR_ADMIN_TOKEN_HERE'
curl -sS -X POST "$BASE/admin/campaigns" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary @examples/campaign.json
curl -sS "$BASE/admin/campaigns" -H "Authorization: Bearer $TOKEN"
```

Example `examples/campaign.json` has subject, HTML, and date. Edit its schedule to a future time before use. Personalization is provided by Brevo contact fields, e.g. `Hello {{ contact.FNAME }}`. HTML is trusted administrator-generated content, not raw HTML from contacts.

## 5. Test without sending

`wrangler.toml` ships with `DRY_RUN = "true"`. Due campaigns are listed but not sent to Brevo. Preview due campaigns with:

```bash
curl -sS -X POST "$BASE/admin/run" -H "Authorization: Bearer $TOKEN"
```

To enable real sending, change to `DRY_RUN = "false"` in `wrangler.toml` and run `npx wrangler deploy`. **Changing DRY_RUN before the campaign is due can send it automatically.** Use a small, explicitly consented test list (ideally your own address) and inspect its actual received email before importing customer lists.

### Review send status

`GET /admin/campaigns` shows `queued`, `working`, `prepared`, `submitted`, `blocked`, or `needs_review`.

`GET /admin/campaigns/<UUID>/brevo` queries the remote campaign status if an ID is known. A submitted campaign means accepted/scheduled by Brevo, **not** that every inbox received it.

If status becomes `needs_review`, inspect Brevo campaign status and report manually. The Worker **will not** retry potentially non-idempotent create/send requests and does not expose a one-click resend. For a confirmed non-send, operator can schedule a new campaign on an unused day.

`blocked` means your Brevo list was empty or beyond the configured recipient count. Fix the list and create a new campaign on an unused day; this deliberately does not rewrite old scheduled jobs or opt-out history. Deleting a blocked campaign from D1 and rescheduling on the same day is an advanced manual recovery step; inspect state before doing so.

## Architecture

```text
Opt-in CSV --local Node CLI--> Brevo Contacts + native suppression lists
Admin (terminal) --Bearer token--> Cloudflare Worker --> D1 Campaign Queue
Cloudflare Cron (every 10 minutes UTC) --> Worker --> Brevo Marketing Campaign API
Brevo --> contacts (FNAME personalization) + unsubscribe handling + delivery reports
```

Daily campaign recipients refer to one preconfigured Brevo list. The Worker intentionally accepts just **one** campaign on an IST calendar day to avoid multiple campaigns consuming the same 300 free sends. **Avoid manual Brevo sends from the same account on campaign days**; the account-wide quota is shared and external sends cannot be reserved by this application.

## Known limitations and production notes

1. 100–300/day is viable within the *published* Brevo free tier. At 500/day (roughly 15,000/month), Brevo Free is not sufficient. Upgrade your email delivery tier, or implement a separate properly permissioned multi-provider workflow with unified suppression and compliance. The *execution* architecture still has zero server rental.
2. The list size is checked immediately before campaign creation by reading Brevo's contact-list `count`; it is a conservative preflight guard, **not** a reservation. If another operator adds contacts or sends campaigns concurrently, quota or recipient number may differ. For strict high-stakes delivery, pause list changes during send or build Brevo snapshot/segment controls.
3. Scheduling is approximate because Cloudflare Cron checks every 10 minutes (all UTC). It is not a per-recipient drip scheduler.
4. `needs_review` represents an uncertain outcome. Blind retries could duplicate sends. Automating recovery requires a more elaborate reconciler and webhooks. You should check Brevo's dashboard before rescheduling.
5. Do not use Brevo transactional email endpoints for bulk marketing. This project uses the **marketing campaign** API so recipients can unsubscribe and Brevo can suppress future marketing sends.
6. Always send from an authenticated domain, publish a privacy policy, and provide legally required sender identification and company mailing address in your campaign. The sample HTML footer is a functional unsubscribe placeholder, not a substitute for your required disclosures.
7. The administrative token is a bearer secret; call management endpoints only from a private terminal or trusted backend. Rotate secrets if exposed. D1 stores campaign HTML; avoid placing sensitive customer data in message content. Use separate workspaces/API keys for staging and production.
8. The free tiers, sender approval, email deliverability and policies can change. Recheck quota dashboards before scaling.
9. The code deliberately does not automatically generate and send marketing copy. The administrator schedules approved campaign content.

## Tests

```bash
npm test
```

Tests use only Node's built-in test runner. Integration testing with real Cloudflare and Brevo needs credentials and an account; nothing is deployed from this downloadable example.

## Official docs
- https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan
- https://developers.brevo.com/reference/create-email-campaign
- https://developers.brevo.com/reference/send-email-campaign-now
- https://developers.brevo.com/docs/synchronise-contact-lists
- https://help.brevo.com/hc/en-us/articles/209553645-Insert-a-custom-unsubscribe-link-in-your-emails
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/


## Troubleshooting contact page (Brevo)

Contacts need only `BREVO_API_KEY` and numeric `BREVO_LIST_ID`. An authenticated `GET /admin/config` shows `contactsReady` and `contactConfigMissing` without exposing key values.

| API code | Cause | Action |
| --- | --- | --- |
| `CONTACT_CONFIG_MISSING` (503) | Key or list ID absent | Configure named Wrangler secrets |
| `BREVO_AUTH_FAILED` (502) | Brevo 401/403 | Verify API key and permissions |
| `BREVO_LIST_NOT_FOUND` (502) | Brevo 404 | Verify list ID |
| `BREVO_RATE_LIMIT` (503) | Brevo 429 | Retry later |
| `BREVO_CONTACTS_UNAVAILABLE` (502) | Provider/network failure | Check Brevo/Worker logs |

A sandboxed email preview permits inline CSS but not executable inline scripts. The contacts indicator uses native `<progress>`. Keep `DRY_RUN=true` during testing.


## Contact and campaign CRUD

The Mailroom Contacts page can add a consented contact, edit its first/last name, or remove it **from the configured Brevo list only**. Contact removal does not globally delete addresses or bypass provider suppression. Existing opted-out contacts are not automatically re-subscribed. The Campaigns page can edit/delete a campaign only while it is queued and scheduled more than one minute ahead. Submitted/working campaigns cannot be modified through these endpoints. ADMIN_TOKEN is required for all CRUD routes. DRY_RUN remains true by default.
