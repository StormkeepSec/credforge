# credforge

**Make achievement mean more.** credforge helps organizations create and award
[Open Badges 3.0](https://www.imsglobal.org/spec/ob/v3p0) digital badges.

> **Status:** early development. M0 (foundations) and M1 (the credential engine in `packages/ob3`)
> are done. See the [design plan](docs/design-plan.md) for the architecture and the roadmap.

## Requirements

- **Node.js 24** (LTS)
- **pnpm 10**: enable it once with `corepack enable`, or install it with `npm install -g pnpm@10`
- **Docker** (Docker Desktop on Windows/macOS) for PostgreSQL and the production stack

## Develop

```bash
pnpm install
pnpm infra:up      # PostgreSQL + Mailpit in Docker
pnpm dev           # migrate, then run the server, worker and web app with reload
```

Open **http://localhost:5173**. Vite serves the issuer app and forwards the API, health checks
and server-rendered pages to the Fastify server on port 3000. Mailpit's inbox is at
http://localhost:8025.

No configuration is needed for development. To override a default, copy
`.env.development.example` to `.env.development`.

| Command | What it does |
|---|---|
| `pnpm check` | Lint, typecheck and test (also runs before every `git push`) |
| `pnpm build` | Production build of the web app and server |
| `pnpm format` | Apply formatting and safe lint fixes |
| `pnpm db:generate` | Create a SQL migration from changes in `packages/db/src/schema.ts` |
| `pnpm db:migrate` | Apply migrations to the development database |
| `pnpm infra:down` | Stop PostgreSQL and Mailpit (data is kept) |

## Run the production stack

```bash
cp .env.example .env   # set PUBLIC_BASE_URL and POSTGRES_PASSWORD
docker compose up -d --build
```

This starts `db`, runs `migrate` once, and then starts `app` and `worker`. The app listens on
`127.0.0.1:3000` for a reverse proxy (nginx with TLS) to forward to. Check it with
`curl http://127.0.0.1:3000/readyz`.

`PUBLIC_BASE_URL` is **permanent**: every credential embeds URLs under it, and the app refuses to
start if it changes. For a local trial use `http://localhost:3000`, then remove the volumes
(`docker compose down -v`) before setting the real domain.

## Repository layout

```text
apps/server     Fastify: REST API, server-rendered public pages, worker, migrations runner
apps/web        React issuer app (Vite) and the stylesheet for public pages
packages/db     Database schema and SQL migrations (Drizzle ORM)
packages/ob3    Credential engine: build, sign, verify, bake and status lists for Open Badges 3.0
packages/ui     Brand tokens (Tailwind CSS theme)
docs/           Design plan and other documentation
branding/       Brand guide, copy kit and logo assets
```

## License

[Apache-2.0](LICENSE). Report security issues as described in [SECURITY.md](SECURITY.md).
