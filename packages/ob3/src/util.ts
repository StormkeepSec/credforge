/** Returns a copy without the properties whose value is `undefined`, so they don't reach JSON-LD. */
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Throws unless the value is an absolute URL or other IRI with a scheme (`https:`, `did:`, …). */
export function assertAbsoluteUrl(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !URL.canParse(value) || /\s/.test(value)) {
    throw new TypeError(`"${name}" must be an absolute URL.`);
  }
}

/** Returns the trimmed text, or throws if it is empty. */
export function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`"${name}" must be a non-empty string.`);
  }
  return value.trim();
}
