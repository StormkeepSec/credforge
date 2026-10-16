import type pg from 'pg';
import { ERASED_MARKER, SEALED_FIELD, sealRecipientDetails } from './audit';

/** Recorded in `instance_settings` once the rewrite has run (or found nothing to do). */
export const EARLIER_EVENTS_SEALED = 'audit_recipient_details_sealed_at';

/** What earlier events said about recipients in plain `data`, by action (design plan §12.1). */
const RECIPIENT_FIELDS: Record<string, readonly string[]> = {
  'credential.issued': ['recipientName', 'recipientEmail'],
  'credential.revoked': ['recipientName', 'recipientEmail', 'reason', 'publicReason'],
  'credential.reissued': ['reason'],
  'credential.email_resent': ['to'],
  'credential.claimed': [],
  'credential.hidden': [],
  'credential.shown': [],
  'email.bounced': ['reason'],
  'email.dropped': ['reason'],
  'email.spam_reported': ['reason'],
  'email.failed': ['reason'],
};

interface EarlierEvent {
  id: string;
  org_id: string | null;
  action: string;
  target_id: string | null;
  actor_type: string;
  actor_label: string | null;
  ip: string | null;
  user_agent: string | null;
  data: Record<string, unknown>;
  audit_key: Buffer | null;
}

interface Rewrite {
  id: string;
  data: Record<string, unknown>;
  actor_label: string | null;
  ip: string | null;
  user_agent: string | null;
}

/** The event with its recipient details sealed, or null when it says nothing about anyone. */
function rewrite(event: EarlierEvent): Rewrite | null {
  if (event.action === 'credentials.exported') {
    // The search text may be a name or an address: only that a search was used is kept.
    const filters = event.data.filters as Record<string, unknown> | undefined;
    if (!filters || typeof filters.q !== 'string') return null;
    const { q: _q, ...rest } = filters;
    return {
      id: event.id,
      data: { ...event.data, filters: { ...rest, search: true } },
      actor_label: event.actor_label,
      ip: event.ip,
      user_agent: event.user_agent,
    };
  }
  const fields = RECIPIENT_FIELDS[event.action];
  if (!fields || !event.target_id) return null;
  const data: Record<string, unknown> = {};
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.data)) {
    if (fields.includes(key) && value !== null && value !== undefined) data[key] = value;
    else plain[key] = value;
  }
  const recipientActs = event.actor_type === 'recipient';
  const details = {
    ...(Object.keys(data).length > 0 && { data }),
    ...(recipientActs && event.actor_label && { actorLabel: event.actor_label }),
    ...(recipientActs && event.ip && { ip: event.ip }),
    ...(recipientActs && event.user_agent && { userAgent: event.user_agent }),
  };
  if (Object.keys(details).length === 0) return null;
  const id = event.target_id.toLowerCase();
  return {
    id: event.id,
    // Without its credential's key (there should always be one) the details can't be kept.
    data: event.audit_key
      ? { ...plain, [SEALED_FIELD]: sealRecipientDetails(event.audit_key, id, details) }
      : { ...plain, ...ERASED_MARKER },
    actor_label: recipientActs ? null : event.actor_label,
    ip: recipientActs ? null : event.ip,
    user_agent: recipientActs ? null : event.user_agent,
  };
}

const CHUNK = 500;

/**
 * The one exception to the audit log's append-only rule (decision 50, chosen by the owner): run
 * once by `migrate`, as the database owner, after migration 0006. Events written before it hold
 * recipients' names, addresses and free text in plain `data`; this seals them with their
 * credentials' new audit keys, exactly as the app now writes them, so that erasing a recipient
 * reaches those events too. Search text in credential exports is reduced to "a search was used".
 *
 * Everything happens in one transaction: the append-only trigger is switched off and on again
 * inside it, so no other change can slip through, and a failure leaves both the events and the
 * trigger as they were. Each affected org gets an `audit.recipient_details_sealed` event saying
 * how many of its events were rewritten. Returns that number, or null if it had already run.
 */
export async function sealEarlierAuditEvents(pool: pg.Pool): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `select pg_advisory_xact_lock(hashtext('credforge:${EARLIER_EVENTS_SEALED}'))`,
    );
    const done = await client.query('select 1 from instance_settings where key = $1', [
      EARLIER_EVENTS_SEALED,
    ]);
    if ((done.rowCount ?? 0) > 0) {
      await client.query('commit');
      return null;
    }
    const { rows } = await client.query<EarlierEvent>(
      `select e.id::text as id, e.org_id, e.action, e.target_id, e.actor_type, e.actor_label,
              e.ip, e.user_agent, e.data, c.audit_key
         from audit_event e
         left join credential c on e.target_type = 'credential' and c.id::text = lower(e.target_id)
        where not (e.data ? $1)
          and ((e.target_type = 'credential' and e.action = any($2)) or e.action = 'credentials.exported')
        order by e.id`,
      [SEALED_FIELD, Object.keys(RECIPIENT_FIELDS)],
    );
    const changes = rows.flatMap((row) => {
      const change = rewrite(row);
      return change ? [{ change, orgId: row.org_id }] : [];
    });
    if (changes.length > 0) {
      await client.query('alter table audit_event disable trigger audit_event_no_update_delete');
      for (let start = 0; start < changes.length; start += CHUNK) {
        const chunk = changes.slice(start, start + CHUNK).map(({ change }) => change);
        await client.query(
          `update audit_event as e
              set data = d.data, actor_label = d.actor_label, ip = d.ip, user_agent = d.user_agent
             from jsonb_to_recordset($1::jsonb)
               as d(id bigint, data jsonb, actor_label text, ip text, user_agent text)
            where e.id = d.id`,
          [JSON.stringify(chunk)],
        );
      }
      await client.query('alter table audit_event enable trigger audit_event_no_update_delete');
      const perOrg = new Map<string | null, number>();
      for (const { orgId } of changes) perOrg.set(orgId, (perOrg.get(orgId) ?? 0) + 1);
      for (const [orgId, count] of perOrg) {
        await client.query(
          `insert into audit_event (org_id, actor_type, actor_label, action, data)
           values ($1, 'system', 'credforge migrate', 'audit.recipient_details_sealed', $2)`,
          [orgId, JSON.stringify({ events: count })],
        );
      }
    }
    await client.query(
      `insert into instance_settings (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [EARLIER_EVENTS_SEALED, new Date().toISOString()],
    );
    await client.query('commit');
    return changes.length;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
