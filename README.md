# credforge

**Make achievement mean more.** credforge helps organizations create and award
[Open Badges 3.0](https://www.imsglobal.org/spec/ob/v3p0) digital badges.

> **Status:** early development. M0 (foundations), M1 (the credential engine in `packages/ob3`) and
> M2 (accounts, organizations and issuers) are done. See the [design plan](docs/design-plan.md) for
> the architecture and the roadmap.

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
links, invitations, approval notices) lands in Mailpit at http://localhost:8025.

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

### Accessibility tests (end to end)

`pnpm test:e2e` drives the issuer app in Chromium with [Playwright](https://playwright.dev) and
checks every screen with [axe](https://github.com/dequelabs/axe-core) against the WCAG 2.0–2.2
A and AA rules, in light and dark mode (emulated `prefers-color-scheme`) at 1280 and 375 px wide.
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
- **Google and Microsoft sign-in** turn on when their client ID and secret are set. Redirect URIs
  are `{PUBLIC_BASE_URL}/api/auth/callback/google` and `…/callback/microsoft`. For Microsoft, add
  the optional ID token claim `xms_edov`; without it credforge sends its own confirmation email
  before a Microsoft account can be used.

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
