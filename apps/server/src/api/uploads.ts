import type { Queryable } from '@credforge/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { ImageError, MAX_UPLOAD_BYTES } from '../files/images';
import { checkUpload, type OrgUploadLimits } from '../files/limits';
import { type FileRow, type StoreImageInput, storeImage } from '../files/service';
import type { Storage } from '../files/storage';
import { ApiError } from './errors';
import type { RateLimiter } from './rate-limit';

/** What an upload is counted against: the org's hourly upload limit and storage quota (§6.5). */
export interface UploadGuard {
  config: Pick<Config, 'orgUploadRateLimit' | 'orgStorageQuotaMb'>;
  limiter: RateLimiter;
  org: OrgUploadLimits;
  reply: Pick<FastifyReply, 'header'>;
}

/**
 * Image uploads are the raw file as the request body (`PUT …/image` with the file's content
 * type), so no multipart parser is needed. The declared type is only a hint: the pipeline checks
 * the bytes themselves.
 */
const IMAGE_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'application/octet-stream',
];

/** Lets the routes of this plugin receive image uploads up to 2 MB. */
export function acceptImageUploads(app: FastifyInstance) {
  app.addContentTypeParser(
    IMAGE_CONTENT_TYPES,
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_request, body, done) => done(null, body),
  );
}

export const UPLOAD_ROUTE_OPTIONS = { bodyLimit: MAX_UPLOAD_BYTES } as const;

function uploadedBytes(request: FastifyRequest): Buffer {
  const body = request.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new ApiError(
      415,
      'unsupported_file',
      'Upload a PNG, SVG, JPEG or WebP image',
      'Send the image file as the request body, with its content type (for example image/png).',
    );
  }
  return body;
}

/**
 * Stores the uploaded image, once it fits the org's upload limits, turning pipeline errors into
 * problem responses.
 */
export async function storeUploadedImage(
  db: Queryable,
  storage: Storage,
  request: FastifyRequest,
  input: Omit<StoreImageInput, 'bytes'>,
  guard: UploadGuard,
): Promise<FileRow> {
  const bytes = uploadedBytes(request);
  await checkUpload(db, guard.config, guard.limiter, guard.org, bytes.length, guard.reply);
  try {
    return await storeImage(db, storage, { ...input, bytes });
  } catch (error) {
    if (error instanceof ImageError) {
      if (error.reason === 'too_large') {
        throw new ApiError(413, 'file_too_large', 'File too large', error.message);
      }
      throw new ApiError(
        error.reason === 'unsupported' ? 415 : 400,
        'unsupported_file',
        error.reason === 'unsupported' ? 'Unsupported file' : 'Image can’t be used',
        error.message,
      );
    }
    throw error;
  }
}
