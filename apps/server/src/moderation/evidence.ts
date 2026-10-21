import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  type KeyObject,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';

/**
 * Sealed evidence of known child sexual abuse material (design plan §6.5, decision 61).
 *
 * The image and what is known about its upload are encrypted with a fresh AES-256-GCM key, bound
 * to the evidence id as additional authenticated data, and that key is encrypted (RSA-OAEP with
 * SHA-256) to the operator's evidence public key, CSAM_EVIDENCE_PUBLIC_KEY. The private key never
 * is on the server: whoever runs the instance keeps it offline, so neither the app, a platform
 * admin, nor anyone with the database or a backup can open the evidence. `cli.js open-evidence`
 * opens an exported envelope on the machine that holds the private key.
 */

export const EVIDENCE_FORMAT = 'credforge-evidence';
export const EVIDENCE_ALGORITHM = 'RSA-OAEP-256+A256GCM';
/** Shorter RSA keys are refused (NIST SP 800-57 puts 3072 bits at 128-bit security). */
export const MIN_EVIDENCE_KEY_BITS = 3072;

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceError';
  }
}

/** An RSA public key of at least 3072 bits: a PEM block, or base64 of its DER (SPKI) encoding. */
export function parseEvidencePublicKey(value: string): KeyObject {
  let key: KeyObject;
  try {
    key = value.includes('BEGIN')
      ? createPublicKey(value)
      : createPublicKey({ key: Buffer.from(value.trim(), 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new EvidenceError('must be an RSA public key (PEM, or base64 of its DER encoding)');
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa') {
    throw new EvidenceError('must be an RSA public key (RSA-OAEP), not a private or other key');
  }
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_EVIDENCE_KEY_BITS) {
    throw new EvidenceError(`must be an RSA key of at least ${MIN_EVIDENCE_KEY_BITS} bits`);
  }
  return key;
}

/** `sha256:{hex}` of the public key's DER encoding: says which key evidence was sealed to. */
export function keyFingerprint(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

export interface EvidenceFile {
  /** e.g. `original.png`. */
  name: string;
  mimeType: string;
  bytes: Buffer;
}

export interface EvidenceBundle {
  /** What is known about the content and its upload (`csam.ts`). */
  manifest: Record<string, unknown>;
  files: EvidenceFile[];
}

/** Stored in `moderation_evidence.envelope`, and what `export-evidence` writes, as JSON. */
export interface EvidenceEnvelope {
  format: typeof EVIDENCE_FORMAT;
  version: 1;
  id: string;
  alg: typeof EVIDENCE_ALGORITHM;
  keyFingerprint: string;
  /** base64url: the AES key encrypted to the public key, the IV, the GCM tag, the ciphertext. */
  wrappedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

const aad = (id: string) => Buffer.from(`credforge:evidence:${id}`, 'utf8');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Seals a bundle to the public key; returns the envelope as UTF-8 JSON. */
export function sealEvidence(publicKey: KeyObject, id: string, bundle: EvidenceBundle): Buffer {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(
    JSON.stringify({
      manifest: bundle.manifest,
      files: bundle.files.map((item) => ({
        name: item.name,
        mimeType: item.mimeType,
        size: item.bytes.length,
        sha256: sha256(item.bytes),
        data: item.bytes.toString('base64'),
      })),
    }),
    'utf8',
  );
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(aad(id));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrappedKey = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    dataKey,
  );
  dataKey.fill(0);
  const envelope: EvidenceEnvelope = {
    format: EVIDENCE_FORMAT,
    version: 1,
    id,
    alg: EVIDENCE_ALGORITHM,
    keyFingerprint: keyFingerprint(publicKey),
    wrappedKey: wrappedKey.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

/** Reads an envelope's plain fields (no key needed). */
export function readEnvelope(stored: Buffer | string): EvidenceEnvelope {
  let envelope: EvidenceEnvelope;
  try {
    envelope = JSON.parse(stored.toString()) as EvidenceEnvelope;
  } catch {
    throw new EvidenceError('This isn’t a credforge evidence file.');
  }
  if (envelope?.format !== EVIDENCE_FORMAT || envelope.version !== 1) {
    throw new EvidenceError('This isn’t a credforge evidence file (or it is a newer version).');
  }
  if (envelope.alg !== EVIDENCE_ALGORITHM) {
    throw new EvidenceError(`Unknown algorithm ${String(envelope.alg)}.`);
  }
  return envelope;
}

/** Opens an envelope with the private key, checking every file against its recorded hash. */
export function openEvidence(privateKey: KeyObject, stored: Buffer | string): EvidenceBundle {
  const envelope = readEnvelope(stored);
  if (keyFingerprint(privateKey) !== envelope.keyFingerprint) {
    throw new EvidenceError(
      `This evidence was sealed to another key (${envelope.keyFingerprint}).`,
    );
  }
  let plaintext: Buffer;
  try {
    const dataKey = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(envelope.wrappedKey, 'base64url'),
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      dataKey,
      Buffer.from(envelope.iv, 'base64url'),
    );
    decipher.setAAD(aad(envelope.id));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    dataKey.fill(0);
  } catch {
    throw new EvidenceError(
      'The evidence couldn’t be opened: it was changed, or the key is wrong.',
    );
  }
  const opened = JSON.parse(plaintext.toString('utf8')) as {
    manifest: Record<string, unknown>;
    files: { name: string; mimeType: string; sha256: string; data: string }[];
  };
  return {
    manifest: opened.manifest,
    files: opened.files.map((item) => {
      const bytes = Buffer.from(item.data, 'base64');
      if (sha256(bytes) !== item.sha256) {
        throw new EvidenceError(`${item.name} doesn’t match its recorded SHA-256.`);
      }
      return { name: item.name, mimeType: item.mimeType, bytes };
    }),
  };
}

/** Hex SHA-256 of a stored envelope. */
export function envelopeSha256(stored: Buffer): string {
  return sha256(stored);
}
