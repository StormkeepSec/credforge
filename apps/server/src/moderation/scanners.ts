/**
 * The automatic check (design plan §6.5, decision 60): pluggable scanners the worker runs on new
 * images and public text before they can be published. Which one runs comes from configuration
 * (MODERATION_PROVIDER, CSAM_MATCHER); credforge ships a generic signed webhook for both, and an
 * adapter for OpenAI's moderation endpoint as a classifier. Anything else plugs in behind the
 * webhook, or implements these interfaces in a fork.
 */

import { CATEGORY_NAME } from './thresholds';

/** Scores from 0 to 1 per category, in the provider's own category names. */
export type CategoryScores = Record<string, number>;

/** What a scanner is told about the content, beyond the content itself. */
export interface ScanContext {
  /** Identifies this check (not the content or its org), for the provider's logs. */
  requestId: string;
  /** What the content is: a badge image or an issuer logo, or whose public text. */
  subject: 'badge_image' | 'issuer_logo' | 'organization' | 'issuer' | 'achievement';
}

/** A PNG of the image as people see it: credforge's 512 px rendering, so never an SVG. */
export interface ScanImage {
  png: Buffer;
  width: number;
  height: number;
}

/** The public text of an org, issuer or achievement, field by field. */
export interface ScanText {
  fields: { name: string; value: string }[];
}

export interface ImageModerator {
  /** Named in the moderation queue and the privacy policy. */
  readonly name: string;
  scanImage(image: ScanImage, context: ScanContext): Promise<CategoryScores>;
}

export interface TextModerator {
  readonly name: string;
  scanText(text: ScanText, context: ScanContext): Promise<CategoryScores>;
}

/** The image as stored: the cleaned original for raster images, the 512 px PNG for SVGs. */
export interface MatchImage {
  bytes: Buffer;
  mimeType: 'image/png';
  width: number;
  height: number;
  /** Hex SHA-256 of the stored original (its content address). */
  sha256: string;
}

/** A match in a list of known child sexual abuse material, as the matcher reports it. */
export interface KnownCsamMatch {
  /** The hash list or service that matched, e.g. a list name. */
  list?: string;
  /** The matcher's own reference for the match, for the report to the authorities. */
  reference?: string;
}

/**
 * Hash matching against known CSAM (PhotoDNA, Thorn Safer and the like). credforge ships no
 * implementation: these services give access only to vetted organizations. A match blocks the
 * image at once, keeps it as sealed evidence, and suspends the org (`csam.ts`). It runs before
 * any classifier, so a matched image is never sent anywhere else.
 */
export interface KnownCsamMatcher {
  readonly name: string;
  /** The match, or null when the image isn't in any list. Throws when it can't tell. */
  match(image: MatchImage, context: ScanContext): Promise<KnownCsamMatch | null>;
}

export interface Scanners {
  image?: ImageModerator;
  text?: TextModerator;
  csam?: KnownCsamMatcher;
}

/** A scan that couldn't finish (the provider is down, slow or answered something unexpected). */
export class ScanError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScanError';
  }
}

/** Scores as providers send them, checked: category names and numbers from 0 to 1. */
export function parseScores(value: unknown, provider: string): CategoryScores {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScanError(`${provider} answered without category scores.`);
  }
  const scores: CategoryScores = {};
  for (const [category, score] of Object.entries(value)) {
    if (score === null) continue;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new ScanError(`${provider} answered a score that isn't between 0 and 1 (${category}).`);
    }
    const name = category.trim().toLowerCase();
    if (!CATEGORY_NAME.test(name)) {
      throw new ScanError(`${provider} answered a category name credforge can't use.`);
    }
    scores[name] = Math.max(scores[name] ?? 0, score);
  }
  if (Object.keys(scores).length > 100) {
    throw new ScanError(`${provider} answered more than 100 categories.`);
  }
  return scores;
}
