import { joinFields } from './scan-webhook';
import {
  type CategoryScores,
  type ImageModerator,
  ScanError,
  type TextModerator,
} from './scanners';

/**
 * OpenAI's moderation endpoint as a classifier (design plan §6.5, decision 60): free of charge,
 * one request per image or text, and a score from 0 to 1 per category (`sexual`, `hate`,
 * `violence`, `self-harm`, …), which is what the thresholds work on. Some categories score text
 * only (OpenAI's `sexual/minors` among them); those it didn't score for an image are left out.
 * OpenAI asks that known or suspected CSAM isn't sent to it: the known-CSAM matcher runs first.
 */

export const OPENAI_MODERATION_URL = 'https://api.openai.com/v1/moderations';
export const OPENAI_DEFAULT_MODEL = 'omni-moderation-latest';

export interface OpenAiOptions {
  apiKey: string;
  model: string;
  userAgent: string;
  timeoutMs?: number;
  /** Stands in for the global fetch in tests. */
  fetch?: typeof fetch;
}

interface ModerationAnswer {
  results?: {
    category_scores?: Record<string, number | null>;
    category_applied_input_types?: Record<string, string[] | null>;
  }[];
}

export function createOpenAiModerator(options: OpenAiOptions): ImageModerator & TextModerator {
  const name = 'OpenAI';

  async function moderate(input: unknown, inputType: 'image' | 'text'): Promise<CategoryScores> {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(OPENAI_MODERATION_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          'user-agent': options.userAgent,
        },
        body: JSON.stringify({ model: options.model, input }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new ScanError('OpenAI couldn’t be reached.', { cause: error });
    }
    if (!response.ok) {
      // Never log the answer's body: it may echo part of the request.
      throw new ScanError(`OpenAI answered ${response.status}.`);
    }
    let answer: ModerationAnswer;
    try {
      answer = (await response.json()) as ModerationAnswer;
    } catch {
      throw new ScanError('OpenAI didn’t answer JSON.');
    }
    const result = answer.results?.[0];
    if (!result?.category_scores || typeof result.category_scores !== 'object') {
      throw new ScanError('OpenAI answered without category scores.');
    }
    const applied = result.category_applied_input_types;
    const scores: CategoryScores = {};
    for (const [category, score] of Object.entries(result.category_scores)) {
      if (typeof score !== 'number' || !Number.isFinite(score)) continue;
      // A category that doesn't apply to this kind of input scores 0: leave it out.
      const types = applied?.[category];
      if (Array.isArray(types) && !types.includes(inputType)) continue;
      scores[category] = Math.min(Math.max(score, 0), 1);
    }
    return scores;
  }

  return {
    name,
    scanImage(image) {
      return moderate(
        [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${image.png.toString('base64')}` },
          },
        ],
        'image',
      );
    },
    scanText(text) {
      return moderate(joinFields(text.fields), 'text');
    },
  };
}
