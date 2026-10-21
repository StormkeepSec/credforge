/**
 * The operator's thresholds for the automatic check (design plan §6.5, decision 60). A scanner
 * scores content from 0 to 1 per category, in the provider's own category names. A score at or
 * over a category's hold threshold holds the item for a platform admin; at or over its remove
 * threshold it is removed at once. Removing is off unless the operator sets a remove threshold.
 * credforge ships no thresholds tuned for any provider or instance: the default hold threshold is
 * the generic midpoint, for the operator to adjust.
 */

export interface CategoryThreshold {
  /** Null: this category never holds. */
  hold: number | null;
  /** Null: this category is never removed automatically. */
  remove: number | null;
}

/** A category's own thresholds; `remove` left out uses the default remove threshold. */
export interface CategoryOverride {
  hold: number | null;
  remove?: number | null;
}

export interface Thresholds {
  /** For every category without its own (MODERATION_HOLD_THRESHOLD). */
  hold: number;
  /** For every category without its own (MODERATION_REMOVE_THRESHOLD); null: off. */
  remove: number | null;
  /** Per category (MODERATION_CATEGORY_THRESHOLDS), by lowercase name. */
  categories: Record<string, CategoryOverride>;
}

export const DEFAULT_HOLD_THRESHOLD = 0.5;

export class ThresholdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThresholdError';
  }
}

/** Category names as providers write them: `sexual`, `sexual/minors`, `hate_speech`, `self-harm`. */
export const CATEGORY_NAME = /^[a-z0-9][a-z0-9_./-]{0,63}$/;

/** A threshold: a number above 0 and at most 1, or `off`. */
function parseLevel(value: string, what: string): number | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'off') return null;
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/.test(trimmed)) {
    throw new ThresholdError(`${what} must be a number above 0 and at most 1, or off`);
  }
  const level = Number(trimmed);
  if (!(level > 0 && level <= 1)) {
    throw new ThresholdError(`${what} must be a number above 0 and at most 1, or off`);
  }
  return level;
}

/**
 * `sexual/minors=0.05:0.5,violence=0.8,harassment=off`: each category's hold threshold, and after
 * a colon its remove threshold (left out: the default remove threshold). `off` turns either off.
 */
export function parseCategoryThresholds(value: string | undefined): Thresholds['categories'] {
  const categories: Thresholds['categories'] = {};
  for (const part of (value ?? '').split(',')) {
    if (!part.trim()) continue;
    const equals = part.indexOf('=');
    if (equals < 0) {
      throw new ThresholdError(`"${part.trim()}" must be category=hold or category=hold:remove`);
    }
    const name = part.slice(0, equals).trim().toLowerCase();
    if (!CATEGORY_NAME.test(name)) {
      throw new ThresholdError(`"${name}" isn't a category name (letters, digits, _ . / -)`);
    }
    if (name in categories) throw new ThresholdError(`${name} is listed twice`);
    const [hold = '', remove, extra] = part.slice(equals + 1).split(':');
    if (extra !== undefined) {
      throw new ThresholdError(`"${part.trim()}" must be category=hold or category=hold:remove`);
    }
    categories[name] = {
      hold: parseLevel(hold, `The hold threshold of ${name}`),
      ...(remove !== undefined && {
        remove: parseLevel(remove, `The remove threshold of ${name}`),
      }),
    };
  }
  return categories;
}

/** The thresholds that apply to one category. */
export function thresholdsFor(thresholds: Thresholds, category: string): CategoryThreshold {
  const own = thresholds.categories[category.toLowerCase()];
  return {
    hold: own ? own.hold : thresholds.hold,
    remove: own && own.remove !== undefined ? own.remove : thresholds.remove,
  };
}

export interface ThresholdDecision {
  /** Categories at or over their hold threshold (or their remove threshold). */
  hold: string[];
  /** Categories at or over their remove threshold. */
  remove: string[];
}

/** Which categories of a scan hold the item, and which remove it. */
export function decide(thresholds: Thresholds, scores: Record<string, number>): ThresholdDecision {
  const hold: string[] = [];
  const remove: string[] = [];
  for (const [category, score] of Object.entries(scores).sort(([, a], [, b]) => b - a)) {
    const level = thresholdsFor(thresholds, category);
    const removes = level.remove !== null && score >= level.remove;
    if (removes) remove.push(category);
    if (removes || (level.hold !== null && score >= level.hold)) hold.push(category);
  }
  return { hold, remove };
}

/** For MODERATION_HOLD_THRESHOLD and MODERATION_REMOVE_THRESHOLD. */
export function parseThreshold(value: string, name: string): number | null {
  return parseLevel(value, name);
}
