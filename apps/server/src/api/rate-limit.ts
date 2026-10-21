/**
 * A fixed-window counter per key (a client IP), kept in memory: credforge runs as one app
 * process behind nginx (design plan §3, item 2). Used where a request costs real work, such as
 * verifying, which canonicalizes and may fetch other sites. It must never be put in front of
 * `/status/`: validators fetch status lists many times per check.
 */
export interface RateLimiter {
  /**
   * Counts one request; says whether it is allowed and, if not, in how many seconds to retry.
   * `max` overrides the limiter's own limit for this key (an org's own upload limit).
   */
  take(
    key: string,
    now?: number,
    max?: number,
  ): { allowed: true } | { allowed: false; retryAfter: number };
  /** Whether a key is over its limit, without counting a request. */
  peek(key: string, now?: number): 'ok' | 'limited';
}

const MAX_KEYS = 50_000;

export function createRateLimiter(options: { max: number; windowMs: number }): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    take(key, now = Date.now(), max = options.max) {
      if (max <= 0) return { allowed: true };
      let window = windows.get(key);
      if (!window || window.resetAt <= now) {
        if (windows.size >= MAX_KEYS) {
          for (const [stale, entry] of windows) if (entry.resetAt <= now) windows.delete(stale);
          // Still full: forget the oldest windows rather than grow without bound.
          for (const oldest of windows.keys()) {
            if (windows.size < MAX_KEYS) break;
            windows.delete(oldest);
          }
        }
        window = { count: 0, resetAt: now + options.windowMs };
        windows.set(key, window);
      }
      window.count++;
      if (window.count > max) {
        return {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
        };
      }
      return { allowed: true };
    },
    peek(key, now = Date.now()) {
      if (options.max <= 0) return 'ok';
      const window = windows.get(key);
      return window && window.resetAt > now && window.count >= options.max ? 'limited' : 'ok';
    },
  };
}
