import type { ImageSet } from '@credforge/contracts';
import {
  and,
  eq,
  type FileVariant,
  file,
  inArray,
  moderationItem,
  type Queryable,
  sql,
} from '@credforge/db';
import { type ImageBytes, processImage, type VariantName } from './images';
import type { Storage } from './storage';

export type FileRow = typeof file.$inferSelect;
export type ImageFileKind = 'badge_image' | 'issuer_logo';

/** Where an image's public URLs live: `/achievements/{id}/images` or `/issuers/{id}/images`. */
export function imageBasePath(kind: ImageFileKind, subjectId: string): string {
  return kind === 'badge_image'
    ? `/achievements/${subjectId}/images`
    : `/issuers/${subjectId}/images`;
}

/** Object key prefix (design plan §13.5), one folder per content hash. */
function keyPrefix(orgId: string, kind: ImageFileKind, subjectId: string, sha256: string): string {
  return kind === 'badge_image'
    ? `orgs/${orgId}/achievements/${subjectId}/${sha256}`
    : `orgs/${orgId}/issuers/${subjectId}/logo/${sha256}`;
}

function extensionOf(row: Pick<FileRow, 'mimeType'>): 'png' | 'svg' {
  return row.mimeType === 'image/svg+xml' ? 'svg' : 'png';
}

/** The permanent, content-addressed URLs of an image and its derived sizes. */
export function imageSet(publicBaseUrl: string, row: FileRow): ImageSet {
  const base = `${publicBaseUrl}${imageBasePath(row.kind as ImageFileKind, row.subjectId ?? '')}`;
  return {
    url: `${base}/${row.sha256}.${extensionOf(row)}`,
    url512: `${base}/${row.sha256}-512.png`,
    url128: `${base}/${row.sha256}-128.png`,
    ogUrl: row.variants.og ? `${base}/${row.sha256}-og.png` : null,
    mimeType: row.mimeType === 'image/svg+xml' ? 'image/svg+xml' : 'image/png',
    width: row.width,
    height: row.height,
  };
}

export interface StoreImageInput {
  orgId: string;
  kind: ImageFileKind;
  /** The achievement or issuer the image belongs to. */
  subjectId: string;
  bytes: Buffer;
  createdBy: string | null;
}

/**
 * Checks, cleans and resizes an upload (images.ts), writes the original and its variants to
 * storage, and records them. The same image uploaded again for the same subject reuses the
 * existing record. Objects are written before the row: a failed insert leaves only unreferenced,
 * content-addressed objects behind, never a row without its files.
 */
export async function storeImage(
  db: Queryable,
  storage: Storage,
  input: StoreImageInput,
): Promise<FileRow> {
  const image = await processImage(input.bytes, { openGraph: input.kind === 'badge_image' });
  const [existing] = await db
    .select()
    .from(file)
    .where(
      and(
        eq(file.orgId, input.orgId),
        eq(file.kind, input.kind),
        eq(file.subjectId, input.subjectId),
        eq(file.sha256, image.sha256),
      ),
    );
  if (existing) return existing;

  const prefix = keyPrefix(input.orgId, input.kind, input.subjectId, image.sha256);
  const originalKey = `${prefix}/original.${image.extension}`;
  await storage.put(originalKey, image.original.bytes, image.original.mimeType);
  const variants: Record<string, FileVariant> = {};
  for (const [name, variant] of Object.entries(image.variants) as [VariantName, ImageBytes][]) {
    const key = `${prefix}/${name}.png`;
    await storage.put(key, variant.bytes, variant.mimeType);
    variants[name] = {
      key,
      mimeType: variant.mimeType,
      size: variant.bytes.length,
      width: variant.width,
      height: variant.height,
    };
  }

  const [row] = await db
    .insert(file)
    .values({
      orgId: input.orgId,
      kind: input.kind,
      subjectId: input.subjectId,
      driver: storage.driver,
      bucket: storage.bucket,
      key: originalKey,
      mimeType: image.original.mimeType,
      size: image.original.bytes.length,
      sha256: image.sha256,
      width: image.original.width,
      height: image.original.height,
      variants,
      visibility: 'public',
      createdBy: input.createdBy,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  // Uploaded twice at once: the other request recorded it first.
  const [raced] = await db
    .select()
    .from(file)
    .where(
      and(
        eq(file.kind, input.kind),
        eq(file.subjectId, input.subjectId),
        eq(file.sha256, image.sha256),
      ),
    );
  if (!raced) throw new Error('Image record missing after insert conflict.');
  return raced;
}

/** Marks files as referenced by an issued credential, so they are never deleted. */
export async function retainFiles(db: Queryable, fileIds: (string | null | undefined)[]) {
  const ids = fileIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return;
  await db.update(file).set({ retain: true }).where(inArray(file.id, ids));
}

/**
 * Deletes files and their objects, except any an issued credential refers to (design plan
 * §5.4: those are never deleted) and images a platform admin removed (their record keeps the
 * same image from being published again, §6.5). Returns how many were deleted.
 */
export async function deleteFiles(db: Queryable, storage: Storage, rows: FileRow[]) {
  let deleted = 0;
  for (const row of rows) {
    if (row.retain) continue;
    const [gone] = await db
      .delete(file)
      .where(
        and(
          eq(file.id, row.id),
          eq(file.retain, false),
          sql`not exists (select 1 from ${moderationItem} where ${moderationItem.fileId} = ${file.id} and ${moderationItem.status} = 'removed')`,
        ),
      )
      .returning({ id: file.id });
    if (!gone) continue;
    for (const key of [row.key, ...Object.values(row.variants).map((variant) => variant.key)]) {
      await storage.delete(key);
    }
    deleted++;
  }
  return deleted;
}

export async function loadFiles(db: Queryable, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map<string, FileRow>();
  const rows = await db.select().from(file).where(inArray(file.id, wanted));
  return new Map(rows.map((row) => [row.id, row]));
}

/** Parses an image file name from a public URL: `{sha256}.png`, `{sha256}-512.png`, … */
export function parseImageName(
  name: string,
): { sha256: string; variant: VariantName | null; extension: 'png' | 'svg' } | null {
  const match = /^([0-9a-f]{64})(?:-(512|128|og))?\.(png|svg)$/.exec(name);
  if (!match) return null;
  const variant = (match[2] as VariantName | undefined) ?? null;
  const extension = match[3] as 'png' | 'svg';
  if (variant && extension !== 'png') return null;
  return { sha256: match[1] as string, variant, extension };
}
