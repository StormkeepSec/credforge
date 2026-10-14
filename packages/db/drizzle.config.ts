import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` turns schema changes into a new SQL migration in ./migrations.
// Review the generated SQL before committing it; migrations are applied in order at deploy time.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
});
