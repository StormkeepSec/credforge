# credforge

**Make achievement mean more.** credforge helps organizations create and award
[Open Badges 3.0](https://www.imsglobal.org/spec/ob/v3p0) digital badges.

> **Status:** early development. M0 (foundations), M1 (the credential engine in `packages/ob3`),
> M2 (accounts, organizations and issuers) and M3 (achievements, awarding one badge, delivery and
> the public badge pages) are done. See the [design plan](docs/design-plan.md) for the architecture
> and the roadmap.

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

### Tests

`pnpm test` runs unit tests and the server's integration tests. The integration tests use a real
PostgreSQL: Testcontainers starts `postgres:18-alpine`, so **Docker must be running**. To use an
existing server instead, set `TEST_DATABASE_URL` to a superuser connection string; each test file
creates and drops its own database there. The integration suite includes a cross-tenant test that
tries every organization-scoped endpoint against another organization's data.

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
verifies the downloaded baked PNG with `@credforge/ob3`.
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
the platform approval queue. The test data stays in the development database.

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
- **Google and Microsoft sign-in** turn on when their client ID and secret are set. Redirect URIs
  are `{PUBLIC_BASE_URL}/api/auth/callback/google` and `…/callback/microsoft`. For Microsoft, add
  the optional ID token claim `xms_edov`; without it credforge sends its own confirmation email
  before a Microsoft account can be used.

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

1. Buckets: `credforge-prod` (File Listing **restricted**, no CDN, no CORS needed) and
   `credforge-dev` for development and the driver's integration tests. Turn on versioning for
   `credforge-prod` (`aws s3api put-bucket-versioning --bucket credforge-prod
   --versioning-configuration Status=Enabled --endpoint-url https://<region>.digitaloceanspaces.com`).
2. **Limited access keys** (API → Spaces Keys): one with Read/Write/Delete on `credforge-prod`
   only → `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (or `_FILE`); one on `credforge-dev` only
   for development (`S3_TEST_*`).
3. `S3_ENDPOINT=https://<region>.digitaloceanspaces.com`, `S3_REGION=<region>`,
   `S3_BUCKET=credforge-prod`.

No DNS record is needed for Spaces. nginx in front of the app needs `client_max_body_size 10m`
(image uploads and webhook batches) and must not rate-limit `/status/`: validators fetch the
status list for every check (the 1EdTech validator about 10 times).

## Repository layout

```text
apps/server         Fastify: REST API, auth, server-rendered public pages, worker, migrations, CLI
apps/web            React issuer app (Vite, TanStack Router/Query, shadcn/ui) and the public stylesheet
packages/contracts  Roles, permissions, request schemas and response types shared by server and app
packages/db         Database schema and SQL migrations (Drizzle ORM)
packages/ob3        Credential engine: build, sign, verify, bake and status lists for Open Badges 3.0
packages/ui         Brand tokens (Tailwind CSS theme)
e2e/                End-to-end accessibility tests of the issuer app (Playwright + axe)
docs/               Design plan and other documentation
branding/           Brand guide, copy kit and logo assets
```

## License

[Apache-2.0](LICENSE). Report security issues as described in [SECURITY.md](SECURITY.md).
