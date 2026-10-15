/** Queue names. Keep them stable: jobs already enqueued refer to them by name. */
export const QUEUES = {
  /** Proves scheduling and job processing work end to end; later feeds worker health. */
  heartbeat: 'system.heartbeat',
  /** Outgoing email (verification, invitations, approval notices). */
  email: 'email.send',
  /** Issues a confirmed batch's rows, a chunk per job (design plan §8.3). */
  batch: 'batch.issue',
  /** Re-signs and publishes a status list after a revocation, debounced (§8.6). */
  statusList: 'status-list.publish',
  /**
   * Every minute: publishes lists and resumes batches whose job went missing, and deletes CSV
   * uploads after 30 days. The database, not the queue, says what is left to do.
   */
  sweep: 'system.sweep',
} as const;
