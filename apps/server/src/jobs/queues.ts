/** Queue names. Keep them stable: jobs already enqueued refer to them by name. */
export const QUEUES = {
  /** Proves scheduling and job processing work end to end; later feeds worker health. */
  heartbeat: 'system.heartbeat',
  /** Outgoing email (verification, invitations, approval notices). */
  email: 'email.send',
} as const;
