import type { Logger } from 'pino';

/** Runs `cleanup` once on SIGTERM/SIGINT (docker compose stop, Ctrl+C), then exits. */
export function onShutdown(
  log: Pick<Logger, 'info' | 'error'>,
  cleanup: () => Promise<void>,
): void {
  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    cleanup().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
}
