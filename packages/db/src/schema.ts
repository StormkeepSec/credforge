import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Instance-wide key/value settings.
 *
 * `public_base_url` is recorded on first start: every signed credential embeds URLs under it,
 * so the app refuses to start if it later changes (see apps/server/src/instance.ts).
 */
export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
