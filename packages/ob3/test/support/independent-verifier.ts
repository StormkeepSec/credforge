// A second, independent eddsa-rdfc-2022 verifier for tests. It shares no code with the signing
// path: JSON-LD to RDF with jsonld-streaming-parser (not jsonld.js), RDFC-1.0 with rdfjs-c14n (not
// rdf-canonize), SHA-256 and Ed25519 from node:crypto (not @noble/Digital Bazaar), and a
// hand-written base58 decoder. Key resolution follows the 1EdTech validator's EmbeddedProofProbe:
// a `{controller}#{publicKeyMultibase}` verification method yields the key directly, and the
// controller must equal the credential issuer. When a profile document is given, it is also
// checked the way a controller-document verifier would (plain JSON, no JSON-LD processing).

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JsonLdParser } from 'jsonld-streaming-parser';
import { type InputQuads, RDFC10 } from 'rdfjs-c14n';

// The published context files, read from disk, not through the package's loader.
const CONTEXT_FILES: Record<string, string> = {
  'https://www.w3.org/ns/credentials/v2': 'credentials-v2.json',
  'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json': 'ob-v3p0-context-3.0.3.json',
  'https://purl.imsglobal.org/spec/ob/v3p0/extensions.json': 'ob-v3p0-extensions.json',
  'https://www.w3.org/ns/cid/v1': 'cid-v1.json',
  'https://w3id.org/security/multikey/v1': 'multikey-v1.json',
  'https://w3id.org/security/data-integrity/v2': 'data-integrity-v2.json',
};

export interface IndependentVerifyOptions {
  /** The issuer profile to cross-check (assertionMethod and Multikey entry). */
  profile?: unknown;
  /** Extra contexts by URL (for the W3C test vectors). */
  contexts?: Record<string, unknown>;
  /** Skip "key controller must equal the issuer" (the W3C vector signs with another key). */
  skipIssuerCheck?: boolean;
}

export interface IndependentResult {
  verified: boolean;
  reason?: string;
}

export async function independentVerify(
  signed: object,
  options: IndependentVerifyOptions = {},
): Promise<IndependentResult> {
  const document = signed as Record<string, unknown>;
  const { proof, ...unsecured } = document;
  if (!isObject(proof)) return { verified: false, reason: 'no single proof object' };
  if (proof.type !== 'DataIntegrityProof') return { verified: false, reason: 'proof type' };
  if (proof.cryptosuite !== 'eddsa-rdfc-2022') return { verified: false, reason: 'cryptosuite' };
  if (proof.proofPurpose !== 'assertionMethod') return { verified: false, reason: 'proofPurpose' };
  if (typeof proof.verificationMethod !== 'string' || typeof proof.proofValue !== 'string') {
    return { verified: false, reason: 'proof fields' };
  }

  // 1EdTech-style key resolution.
  const [controller, fragment] = proof.verificationMethod.split('#');
  if (!controller || !fragment?.startsWith('z')) {
    return { verified: false, reason: 'verificationMethod is not {controller}#z…' };
  }
  const multicodec = base58btc(fragment.slice(1));
  if (multicodec.length !== 34 || multicodec[0] !== 0xed || multicodec[1] !== 0x01) {
    return { verified: false, reason: 'fragment is not an Ed25519 multikey' };
  }
  const issuer = isObject(document.issuer) ? document.issuer.id : document.issuer;
  if (!options.skipIssuerCheck && controller !== issuer) {
    return { verified: false, reason: 'key controller does not match issuer' };
  }
  if (options.profile !== undefined) {
    const problem = checkProfile(options.profile, proof.verificationMethod, controller, fragment);
    if (problem) return { verified: false, reason: problem };
  }

  // eddsa-rdfc-2022 verification (vc-di-eddsa §3.2.2 – 3.2.4).
  const contexts = options.contexts ?? {};
  const { proofValue, ...proofConfig } = proof;
  const proofCanonical = await canonicalNQuads(
    { '@context': document['@context'], ...proofConfig },
    contexts,
  );
  const documentCanonical = await canonicalNQuads(unsecured, contexts);
  const hashData = Buffer.concat([sha256(proofCanonical), sha256(documentCanonical)]);
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), multicodec.subarray(2)]),
    format: 'der',
    type: 'spki',
  });
  if (!(proofValue as string).startsWith('z')) return { verified: false, reason: 'proofValue' };
  const signature = base58btc((proofValue as string).slice(1));
  const verified = verify(null, hashData, publicKey, signature);
  return verified ? { verified } : { verified, reason: 'signature' };
}

/** RDFC-1.0 canonical N-Quads of a JSON-LD document, via the independent toolchain. */
export async function canonicalNQuads(
  document: unknown,
  extraContexts: Record<string, unknown> = {},
): Promise<string> {
  const parser = new JsonLdParser({
    strictValues: true,
    documentLoader: {
      async load(url: string) {
        if (url in extraContexts) return extraContexts[url];
        const file = CONTEXT_FILES[url];
        if (!file) throw new Error(`No context for ${url}`);
        return JSON.parse(
          readFileSync(new URL(`../../src/vendor/contexts/${file}`, import.meta.url), 'utf8'),
        );
      },
    },
  });
  const quads = await new Promise<InputQuads>((resolve, reject) => {
    const out: unknown[] = [];
    parser.on('data', (quad: unknown) => out.push(quad));
    parser.on('error', reject);
    parser.on('end', () => resolve(out as InputQuads));
    parser.write(JSON.stringify(document));
    parser.end();
  });
  return new RDFC10().canonicalize(quads);
}

function checkProfile(
  profile: unknown,
  methodId: string,
  controller: string,
  publicKeyMultibase: string,
): string | undefined {
  if (!isObject(profile) || profile.id !== controller) return 'profile id is not the controller';
  const assertion = Array.isArray(profile.assertionMethod) ? profile.assertionMethod : [];
  if (!assertion.includes(methodId)) return 'key not in assertionMethod';
  const methods = Array.isArray(profile.verificationMethod) ? profile.verificationMethod : [];
  const method = methods.find((entry) => isObject(entry) && entry.id === methodId);
  if (!isObject(method)) return 'key not in verificationMethod';
  if (method.type !== 'Multikey') return 'verification method is not a Multikey';
  if (method.controller !== controller) return 'verification method controller';
  if (method.publicKeyMultibase !== publicKeyMultibase) return 'publicKeyMultibase mismatch';
  return undefined;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decodes base58btc (the part after the multibase `z`). */
export function base58btc(text: string): Buffer {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit === -1) throw new Error(`Invalid base58 character "${char}"`);
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
