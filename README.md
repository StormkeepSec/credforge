# credforge

**Make achievement mean more.** credforge helps organizations create and award
[Open Badges 3.0](https://www.imsglobal.org/spec/ob/v3p0) digital badges.

> **Status:** early development. M0 (foundations), M1 (the credential engine in `packages/ob3`),
> M2 (accounts, organizations and issuers), M3 (achievements, awarding one badge, delivery and the
> public badge pages) and M4 (awarding many from a CSV file, revoking and reissuing, the
> verification tool, search and exports) are done. M5's hardening is done (API keys and API docs,
> rate limits, abuse reports, domain verification, security headers, the landing page, draft
> privacy policy and terms, encrypted nightly backups with a tested restore), an organization
> can erase a recipient's data on request, recipients can sign in to see all their badges in
> one place (**My badges**), and platform admins have content moderation (held content, a
> moderation queue, in-app reports); deploying to credforge.app is next. See the
> [design plan](docs/design-plan.md) for the architecture and the roadmap.

## Requirements

- **Node.js 24** (LTS)
- **pnpm 10**: enable it once with `corepack enable`, or install it with `npm install -g pnpm@10`
- **Docker** (Docker Desktop on Windows/macOS) for PostgreSQL, the integration tests and the
  production stack

## Develop

```bash
pnpm install
pnpm infra:up      # PostgreSQL + Mailpit in Docker
pnpm dev           # migrate, then run the server, worker and web app with reload
```

Open **http://localhost:5173** and create an account. Every email the app sends (confirmation
links, invitations, approval notices, award emails) lands in Mailpit at http://localhost:8025.

To see the whole loop: create an organization, set up its issuer profile, create an achievement
with a badge image, publish it, then use **Award a badge → Award it to myself**. The award email
arrives in Mailpit; its link opens the recipient's badge page, where the baked PNG, the JSON and the
printable certificate can be downloaded. A new organization waits for a platform admin's approval
(`SIGNUP_MODE=approval`), but it can already award badges to its own members' confirmed addresses.
Uploaded images are stored in `data/uploads/` (git-ignored).

Then the rest of M4:

- **Award a badge → Many people (CSV file):** upload a CSV (the screen has a template to download),
  check what each column holds and the validation report, then confirm. The worker signs and emails
  each badge; the page follows its progress and offers the results as a CSV. Up to 10,000 rows and
  5 MB; dates as `YYYY-MM-DD`. Until the organization is approved, only its members can be awarded.
- **Awarded badges:** search by name or email, filter by achievement, status, upload and date,
  export what matches (CSV, or JSON Lines with the signed credentials), and select badges to revoke.
  A badge's own screen shows its timeline (awarded → emailed → delivered → opened → revoked) and
  can **Reissue a corrected copy** or **Revoke** it. The worker re-signs the status list a few
  seconds after a revocation.
- **http://localhost:5173/verify:** check any Open Badges 3.0 credential by its address, its JSON
  or a baked badge image, optionally against an email address. The same checks are
  `POST /api/v1/verify`.

And M5:

- **API keys** (sidebar → API keys, owners and admins): create a key with only the permissions an
  integration needs; it is shown once. Send it as `Authorization: Bearer cf_…`. The interactive
  API documentation is at **http://localhost:5173/api/docs** (the OpenAPI 3.1 document at
  `/api/v1/openapi.json`).
- **Website verification** (Issuer profile): publish a DNS TXT record or a file on the issuer's
  website; public pages then say "Website verified" instead of "self-reported".
- **Public pages:** the landing page at `/`, `/privacy` and `/terms` (drafts for review), and
  the "Report a problem" form on badge, achievement and issuer pages.
- **Moderation** (sidebar → Moderation, platform admins; [docs/abuse-handling.md](docs/abuse-handling.md)):
  new images and public text of orgs nobody marked trusted wait for review, so public pages show
  a placeholder (or the version cleared last) and only the org's members can be awarded them; the
  queue shows them (images blurred until you ask) with reports from public pages, and offers
  clear, remove, unpublish, suspend, revoke every badge and disable an account. Approving an org on
  the Platform screen publishes the content it shows. In development everything waits too (the
  default `MODERATION_REVIEW=untrusted`): approve your org, or mark it trusted, on the Platform
  screen.
- **Erase this person's data** (a badge's screen, owners and admins): for a request to delete a
  recipient's data. It first lists what it covers (every badge awarded to that address, badges
  linked to them by a reissue, CSV rows holding it), then revokes the badges for good and removes
  the signed credentials, the name and address from badges, emails and CSV rows, the uploaded CSV
  files, and makes what the audit log says about the person unreadable. The badge's address then
  answers 410 Gone; copies of it check as revoked. See the design plan, §12.1.

And **My badges** for recipients (design plan §8.8):

- Create an account with an address that was awarded a badge (or sign in with Google, or with
  Microsoft when it vouches for the address). People who aren't members of an organization land on
  **My badges** (`/app/badges`), which lists every badge awarded to that address by any
  organization: open its page, download the baked PNG/SVG or the JSON, add it to LinkedIn, and
  hide or show its page. Revoked, replaced and expired badges are marked; erased ones never show.
  Creating an organization is one step away (**Award badges yourself**, or **New organization**).
- Only confirmed addresses count: the account's own once it is verified, and extra addresses
  added under **Account settings → Email addresses for My badges**, each confirmed through a link
  emailed to it and opened while signed in (up to five; they never sign you in).
- Signed in with the badge's address, its public page treats you as its recipient, as the claim
  link does; the claim page and the landing page invite recipients to create an account.
- The API is `GET /api/v1/me/credentials`, `GET/PATCH /api/v1/me/credentials/{id}` and
  `/api/v1/me/emails`; a person signed in only, never an API key.

No configuration is needed for development. To override a default (for example to try Google or
Microsoft sign-in with development OAuth clients), copy `.env.development.example` to
`.env.development`.

To approve organizations you need a platform admin. Create one (or promote an existing account):

```bash
pnpm --filter @credforge/server cli create-platform-admin --email you@example.org
```

It prints a one-time link to set the password. Owners, admins and platform admins must turn on
two-step verification (TOTP) before they can continue, whichever way they sign in.

| Command | What it does |
|---|---|
| `pnpm check` | Lint, typecheck and test (also runs before every `git push`) |
| `pnpm test:e2e` | Accessibility tests of the issuer app against `pnpm dev` (see below) |
| `pnpm build` | Production build of the web app and server |
| `pnpm format` | Apply formatting and safe lint fixes |
| `pnpm db:generate` | Create a SQL migration from changes in `packages/db/src/schema.ts` |
| `pnpm db:migrate` | Apply migrations to the development database |
| `pnpm infra:down` | Stop PostgreSQL and Mailpit (data is kept) |
| `pnpm --filter @credforge/server cli publish-status-lists` | Re-sign status lists with revocations the worker hasn't published yet (`--all` for every list) |
| `pnpm --filter @credforge/server cli revoke-org-credentials --org <id> --reason …` | Revoke every badge of a suspended organization (abuse); without `--yes` it only counts them |
| `pnpm --filter @credforge/server cli erase-recipient --org <id> --email …` | Erase a recipient's data from an organization's records, for a request that reaches the operator (or `--credential <id>`); without `--yes` it only says what it would erase |
| `pnpm --filter @credforge/server cli reapply-erasures` | After restoring a backup: erase again whoever was erased since it was taken (`deploy/restore.sh` runs it) |

### Tests

`pnpm test` runs unit tests and the server's integration tests. The integration tests use a real
PostgreSQL: Testcontainers starts `postgres:18-alpine`, so **Docker must be running**. To use an
existing server instead, set `TEST_DATABASE_URL` to a superuser connection string; each test file
creates and drops its own database there. The integration suite includes a cross-tenant test that
tries every organization-scoped endpoint against another organization's data (with a session and
with an API key), and every JSON response from `/api/v1` in every test is checked against its
schema in the OpenAPI document; another test fails if a route is missing from the document. Domain
verification uses a stand-in for DNS and HTTPS lookups. Erasing a recipient is checked end to end
in the database: nothing about the person is left in badges, emails, queued email jobs, CSV rows,
uploads or the audit log, while the badges stay revoked. My badges is tested for the
verified-address rule (signing up with someone else's address, an unverified session, Google's
`email_verified` and Microsoft's `xms_edov`), isolation between people and from API keys, extra
addresses and their links, and invite-only instances. Batches, revocation
and the worker's jobs are tested by running the job functions directly against the test database;
verification of other issuers' credentials uses a stand-in fetcher that serves the
`packages/ob3` sample issuer.

The SendGrid transport and Event Webhook are tested without an account: requests are compared
with what the Mail Send API expects, and webhook signatures are checked against a recorded test
vector (`apps/server/test/fixtures/sendgrid/`). The `s3` storage driver is tested against a
stand-in client; its tests against a real bucket run only when `S3_TEST_ENDPOINT`,
`S3_TEST_REGION`, `S3_TEST_BUCKET`, `S3_TEST_ACCESS_KEY_ID` and `S3_TEST_SECRET_ACCESS_KEY` are
set (use the `credforge-dev` Space and its dev-only key).

### Accessibility tests (end to end)

`pnpm test:e2e` drives the issuer app in Chromium with [Playwright](https://playwright.dev) and
checks every screen with [axe](https://github.com/dequelabs/axe-core) against the WCAG 2.0–2.2
A and AA rules, in light and dark mode (emulated `prefers-color-scheme`) at 1280 and 375 px wide.
It also awards a badge through the UI to the owner's own address, opens the claim link from
Mailpit as the recipient, checks the public badge page, certificate and achievement page, and
verifies the downloaded baked PNG with `@credforge/ob3`. The M4 tests upload a CSV file and go
through the column mapping, the validation report, awarding, progress and results (the worker must
be running), search and filter the awarded badges, open the bulk revoke panel and the reissue form,
revoke a badge and check its public page, and use the `/verify` page. The M5 tests create an API
key (shown once), use it without cookies, revoke it, open the website verification instructions,
and check the landing page, the draft privacy policy and terms, the "Report a problem" form and the
API docs (no CSP errors). The moderation tests have a new org's first content wait for review
(its public page leaves it out), report it from that page, review it on the Platform screen and in
the moderation queue (a blurred image shown and blurred again, a removal's reason asked in place,
clearing), resolve the report and approve the org; and send the report form on a page of its own,
with a mistake first. The seed marks its own org trusted, so the other tests see their content at
once. The erasure test sets up an organization of its own, reviews what erasing
a recipient would cover, confirms it, and checks the erased badge's screen and its public page
(410). The My badges tests award badges to a new recipient-only account (which lands on My badges),
hide and show a badge's page, add and confirm an extra address from its Mailpit link, and check the
empty list, Account settings and the public page as its signed-in recipient.
Any violation fails the test. It also checks keyboard behaviour that broke before: the mobile menu
takes focus, keeps Tab inside it and returns focus on Escape, its organization switcher is
labelled, cancelling a confirm button returns focus to it, and step changes move focus to the new
heading.

It isn't part of `pnpm check` because it needs Docker and the running development stack. Install
the browser once, then start the stack and run it:

```bash
pnpm --filter @credforge/e2e exec playwright install chromium
pnpm infra:up
pnpm dev           # in another terminal; wait until the server is listening
pnpm test:e2e
```

Each run seeds its own accounts without the UI: sign-up and two-step verification through Better
Auth's API, confirmation and invitation links from Mailpit, a platform admin through the
`create-platform-admin` CLI, and TOTP codes computed from the secret. The accounts use
`e2e-<run>-…@example.test` addresses and a password generated for the run, kept in `e2e/.auth/`
with the saved sessions (git-ignored). At the end the run declines its organization, so it leaves
the platform approval queue, and takes its platform admin's rights away again: every new
organization emails every platform admin, so admins left over from earlier runs slow down every
later run's email (demote old ones with `pnpm --filter @credforge/server cli remove-platform-admin
--email …`). The test data stays in the development database.

Pass Playwright options after the script, for example `pnpm test:e2e -g "sign in"` or
`pnpm test:e2e --ui`. A failed test keeps a trace: `pnpm --filter @credforge/e2e exec playwright
show-report` opens the report. `E2E_BASE_URL` (which must match the server's `PUBLIC_BASE_URL`)
and `E2E_MAILPIT_URL` point the tests at other addresses.

## Run the production stack

```bash
cp .env.example .env   # fill in PUBLIC_BASE_URL, the two database passwords, AUTH_SECRET,
                       # CREDFORGE_MASTER_KEY and the email settings
docker compose up -d --build
docker compose exec app node dist/cli.js create-platform-admin --email you@example.org
```

This starts `db`, runs `migrate` once, and then starts `app` and `worker`. The app listens on
`127.0.0.1:3000` for a reverse proxy (nginx with TLS) to forward to. Check it with
`curl http://127.0.0.1:3000/readyz`.

- **`PUBLIC_BASE_URL` is permanent**: every credential embeds URLs under it, and the app refuses to
  start if it changes. For a local trial use `http://localhost:3000`, then remove the volumes
  (`docker compose down -v`) before setting the real domain.
- **`CREDFORGE_MASTER_KEY` encrypts every issuer's signing key. Back it up separately from the
  database.** The app refuses to start with a different key than the one it was set up with.
- **Two-step verification.** `AUTH_SECRET` encrypts everyone's two-step secrets and backup codes:
  back it up with the master key and never change it. Authenticator apps name the entry after the
  instance (`credforge (credforge.app)`, `credforge (localhost)` in development). For someone who
  can't pass it any more (lost phone and backup codes),
  `node dist/cli.js reset-two-factor --email <address>` deletes their two-step secret and backup
  codes, clears a lockout, ends their sessions and records it in the audit log; owners, admins and
  platform admins must set it up again at their next sign-in when `REQUIRE_MFA_FOR_ADMINS=true`.
  What to try first (the 15-minute lock after 10 wrong codes, backup codes, the clock) is in
  [docs/deployment.md](docs/deployment.md#lost-access-to-two-step-verification).
- **Two database roles.** `migrate` runs as the database owner and creates a restricted role for
  the app and worker (`POSTGRES_APP_PASSWORD`). That role can't run DDL, and it can only read and
  append to the audit log.
- **Email.** `EMAIL_TRANSPORT=sendgrid` sends through SendGrid's v3 Web API over HTTPS
  (DigitalOcean blocks outbound SMTP), `smtp` through any SMTP server. See *Email and storage for
  credforge.app* below.
- **Files.** `STORAGE_DRIVER=s3` keeps badge images and logos in a private S3-compatible bucket
  (a DigitalOcean Space on credforge.app); `local` keeps them in the `uploads` volume, which then
  needs backing up with the database. Images are always served through the app at permanent
  `{PUBLIC_BASE_URL}` URLs, so the storage can change without breaking issued badges.
- **The worker** issues CSV batches, sends email and re-signs status lists after revocations: keep
  it running. Verification (`/verify`, `POST /api/v1/verify`) is rate limited per client IP
  (`VERIFY_RATE_LIMIT`, default 20 a minute), so set `TRUST_PROXY` behind nginx; `/status/` is
  never limited. `node dist/cli.js publish-status-lists` re-signs any lists the worker missed.
- **Google and Microsoft sign-in** turn on when their client ID and secret are set. Redirect URIs
  are `{PUBLIC_BASE_URL}/api/auth/callback/google` and `…/callback/microsoft`. For Microsoft, add
  the optional ID token claim `xms_edov`; without it credforge sends its own confirmation email
  before a Microsoft account can be used. Google's consent screen needs the privacy policy and
  terms URLs: `{PUBLIC_BASE_URL}/privacy` and `/terms`.
- **Rate limits** (in memory, per minute): sign-in, sign-up, password reset and two-step codes per
  client IP (on in production, `AUTH_RATE_LIMIT`), claim and invitation links per client IP
  (`CLAIM_RATE_LIMIT`, 30), verification per client IP (`VERIFY_RATE_LIMIT`, 20) and each API key
  (`API_RATE_LIMIT`, 300). Over a limit: `429` with `Retry-After`. `/status/` is never limited.
- **Moderation** ([docs/abuse-handling.md](docs/abuse-handling.md)). `MODERATION_REVIEW`
  (`untrusted` by default: orgs you haven't marked trusted; `all`; `off`) decides whose new
  images and public text wait for a platform admin. An optional word list
  (`MODERATION_TEXT_BLOCKLIST_FILE`, one term per line, `=term` for whole words) holds matching
  text for review; credforge ships none. `ORG_UPLOAD_RATE_LIMIT` (60 an hour) and
  `ORG_STORAGE_QUOTA_MB` (500) limit each org's uploads, `REPORT_RATE_LIMIT` (10 an hour per
  client IP) the report form. Cleared images are cached for 10 minutes, so a removed one leaves
  browsers and nginx within that time.
- **Contacts and legal pages.** `ABUSE_EMAIL` is offered on the report form and receives owners'
  replies to moderation emails, `SECURITY_EMAIL` serves `/.well-known/security.txt`, and
  `OPERATOR_NAME` and `PRIVACY_EMAIL` fill in `/privacy` and `/terms`. Those pages are drafts, and say so, until you review them and
  set `LEGAL_PAGES_DRAFT=false`. Inbound mail for these addresses needs an MX host: SendGrid only
  sends.
- **Backups.** `deploy/backup.sh` (nightly with the systemd timer in `deploy/systemd/`) dumps the
  database, encrypts it with a key derived from `CREDFORGE_MASTER_KEY` and uploads it to its own
  bucket with its own key (`backup.env`, from `backup.env.example`); `deploy/restore.sh` restores
  one. Setup, the restore procedure and the drill that was run are in
  [docs/restore-drill.md](docs/restore-drill.md).
- **Erasing a recipient's data** also writes a small record without personal data (the badge and
  CSV row ids) to the files bucket under `erasures/`. A backup taken before an erasure still holds
  that person's data, so `deploy/restore.sh` runs `node dist/cli.js reapply-erasures` after
  restoring; backups themselves age out after 30 days.
- **Logs** are rotated by Docker (5 × 10 MB per container). Secrets in URLs (claim, reset,
  confirmation and invitation links, OAuth codes) and the addresses checked with `/verify` are
  removed from request logs.

### Deploy to a server

[docs/deployment.md](docs/deployment.md) is the whole procedure for credforge.app (a DigitalOcean
droplet behind your own nginx): preparing the droplet, DNS and the CAA record, the production
`.env`, nginx and TLS, the first platform admin, Google and Microsoft sign-in, the SendGrid Event
Webhook, backups and the 1EdTech validator check.

Images are built on your machine and streamed to the server over SSH, with no registry:

```bash
deploy/ship.sh you@your-server     # or an ~/.ssh/config alias; --help lists the options
```

It checks the server, builds `credforge:<date>-<commit>` for `linux/amd64`, sends it with
`docker save | gzip | ssh … docker load`, copies `docker-compose.yml` and the backup scripts to
`/opt/credforge`, runs the migration and then restarts `app` and `worker`, and waits until the
app is ready. It never reads `.env`, which stays on the server. `--no-build --tag <older tag>`
rolls back to an image the server still has. `deploy/nginx.conf.example` is a matching nginx
site (TLS, redirects, HSTS, `client_max_body_size`, image caching, a flood guard that leaves
`/status/` alone).

### Email and storage for credforge.app

What has to exist outside credforge before `EMAIL_TRANSPORT=sendgrid` and `STORAGE_DRIVER=s3`
work. Values in angle brackets come from the SendGrid and DigitalOcean control panels.

**SendGrid**

1. **Domain Authentication** (Settings → Sender Authentication → Authenticate Your Domain) for
   `credforge.app`, with automated security on. SendGrid shows three **CNAME** records to add at
   your DNS host, of this shape:

   | Host | Type | Value |
   |---|---|---|
   | `em<nnnn>.credforge.app` | CNAME | `u<nnnnnnn>.wl<nnn>.sendgrid.net` |
   | `s1._domainkey.credforge.app` | CNAME | `s1.domainkey.u<nnnnnnn>.wl<nnn>.sendgrid.net` |
   | `s2._domainkey.credforge.app` | CNAME | `s2.domainkey.u<nnnnnnn>.wl<nnn>.sendgrid.net` |

   Then click Verify. Link branding isn't needed: credforge turns click tracking off.
2. A **DMARC** record: `_dmarc.credforge.app` TXT `v=DMARC1; p=none; rua=mailto:<you>@credforge.app`.
   Move to `p=quarantine` once the reports show only SendGrid sending for the domain.
3. A **restricted API key** with only *Mail Send* (Settings → API Keys → Restricted Access) →
   `SENDGRID_API_KEY` (or `SENDGRID_API_KEY_FILE`).
4. The **Event Webhook** (Settings → Mail Settings → Event Webhooks): POST URL
   `https://credforge.app/api/webhooks/sendgrid`; events *Processed*, *Dropped*, *Deferred*,
   *Delivered*, *Bounced* and *Spam Reports*; turn on **Signed Event Webhook Requests** and copy the
   verification key → `SENDGRID_WEBHOOK_PUBLIC_KEY`. Then use *Test Your Integration*.
5. `EMAIL_FROM=credforge <awards@credforge.app>` (an address on the authenticated domain).

**DigitalOcean Spaces** (in the droplet's region)

1. Buckets: `credforge-prod` (File Listing **restricted**, no CDN, no CORS needed),
   `credforge-backups` for the nightly database backups (File Listing restricted), and
   `credforge-dev` for development and the driver's integration tests. Turn on versioning for
   `credforge-prod` (`aws s3api put-bucket-versioning --bucket credforge-prod
   --versioning-configuration Status=Enabled --endpoint-url https://<region>.digitaloceanspaces.com`).
2. **Limited access keys** (API → Spaces Keys): one with Read/Write/Delete on `credforge-prod`
   only → `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (or `_FILE`); one with Read/Write/Delete on
   `credforge-backups` only → `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` in
   `backup.env` (not `.env`); one on `credforge-dev` only for development (`S3_TEST_*`).
3. `S3_ENDPOINT=https://<region>.digitaloceanspaces.com`, `S3_REGION=<region>`,
   `S3_BUCKET=credforge-prod`; `BACKUP_S3_BUCKET=credforge-backups` in `backup.env` (the backups
   use the same endpoint and region). The backup script deletes backups after 30 days
   (`BACKUP_RETENTION_DAYS`), keeping the newest 7, so no lifecycle rule is needed.

No DNS record is needed for Spaces. nginx in front of the app needs `client_max_body_size 10m`
(image uploads, CSV files up to 5 MB, webhook batches) and must not rate-limit `/status/`:
validators fetch the status list for every check (the 1EdTech validator about 10 times).
`deploy/nginx.conf.example` does both. Uploaded
CSV files are kept privately under `orgs/{orgId}/imports/` for 30 days; exports are streamed and
never stored.

## Repository layout

```text
apps/server         Fastify: REST API, auth, server-rendered public pages, worker, migrations, CLI
apps/web            React issuer app (Vite, TanStack Router/Query, shadcn/ui) and the public stylesheet
packages/contracts  Roles, permissions, request schemas and response types shared by server and app
packages/db         Database schema and SQL migrations (Drizzle ORM)
packages/ob3        Credential engine: build, sign, verify, bake and status lists for Open Badges 3.0
packages/ui         Brand tokens (Tailwind CSS theme)
e2e/                End-to-end accessibility tests of the issuer app (Playwright + axe)
deploy/             ship.sh (build here, deploy over SSH), the nginx example, backup and restore
                    scripts, the systemd timer for the nightly backup
docs/               Design plan, deployment guide, backups and the restore drill
branding/           Brand guide, copy kit and logo assets
```

## License

[Apache-2.0](LICENSE). Report security issues as described in [SECURITY.md](SECURITY.md).
