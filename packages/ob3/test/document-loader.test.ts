import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCredential,
  CID_CONTEXT_V1,
  createDocumentLoader,
  DATA_INTEGRITY_CONTEXT_V2,
  DocumentNotFoundError,
  MULTIKEY_CONTEXT_V1,
  OB_CONTEXT_V3,
  OB_EXTENSIONS_CONTEXT,
  PINNED_CONTEXTS,
  signCredential,
  VC_CONTEXT_V2,
} from '../src/index';
import { credentialInput, ISSUER_ID, testIssuer } from './support/fixtures';

// SHA-256 of each vendored file, as published on 2026-10-14 (see src/vendor/README.md). A change
// here means a vendored file was edited.
const VENDORED: Record<string, string> = {
  'contexts/credentials-v2.json':
    '59955ced6697d61e03f2b2556febe5308ab16842846f5b586d7f1f7adec92734',
  'contexts/ob-v3p0-context-3.0.3.json':
    '3d34f4d4ef1bce691106e63798beb5e7b862ba841423f5ee1e53ab7ddf3bca84',
  'contexts/ob-v3p0-extensions.json':
    '87c06c81bc2317663bf288d740d94fddd2818c4342b186270ff6371dfaa63f93',
  'contexts/cid-v1.json': 'ea216ecc1cb02cd39b693dba2250141e270ba0bf95890be107dd9a9e8e43de85',
  'contexts/multikey-v1.json': 'ba2c182de2d92f7e47184bcca8fcf0beaee6d3986c527bf664c195bbc7c58597',
  'contexts/data-integrity-v2.json':
    '67f21e6e33a6c14e5ccfd2fc7865f7474fb71a04af7e94136cb399dfac8ae8f4',
  'schemas/ob_v3p0_achievementcredential_schema.json':
    'b7358e895f492e74055dc6bfc7ffc420d0e497f90c4579fb83d9519b86d393ea',
  'schemas/ob_v3p0_profile_schema.json':
    '6b268f2caa591bf657e2a290e195713c41dc2db4e1c797723cfd00a1a83f8f13',
};

function vendored(path: string): Buffer {
  return readFileSync(new URL(`../src/vendor/${path}`, import.meta.url));
}

describe('vendored contexts and schemas', () => {
  it.each(Object.entries(VENDORED))('%s is the published file', (path, sha256) => {
    expect(createHash('sha256').update(vendored(path)).digest('hex')).toBe(sha256);
  });

  it('pins exactly the contexts credforge documents use', () => {
    expect([...PINNED_CONTEXTS.keys()].sort()).toEqual(
      [
        VC_CONTEXT_V2,
        OB_CONTEXT_V3,
        OB_EXTENSIONS_CONTEXT,
        CID_CONTEXT_V1,
        MULTIKEY_CONTEXT_V1,
        DATA_INTEGRITY_CONTEXT_V2,
      ].sort(),
    );
    expect(PINNED_CONTEXTS.get(OB_CONTEXT_V3)).toEqual(
      JSON.parse(vendored('contexts/ob-v3p0-context-3.0.3.json').toString('utf8')),
    );
  });

  it('keeps the pinned contexts immutable', () => {
    const context = PINNED_CONTEXTS.get(VC_CONTEXT_V2) as { '@context': Record<string, unknown> };
    expect(Object.isFrozen(context['@context'])).toBe(true);
  });
});

describe('createDocumentLoader', () => {
  afterEach(() => vi.restoreAllMocks());

  it('serves pinned contexts', async () => {
    const loader = createDocumentLoader();
    const result = await loader(OB_CONTEXT_V3);
    expect(result).toEqual({
      contextUrl: null,
      documentUrl: OB_CONTEXT_V3,
      document: PINNED_CONTEXTS.get(OB_CONTEXT_V3),
    });
  });

  it('never fetches: unknown URLs fail, and signing makes no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const loader = createDocumentLoader();
    await expect(loader('https://www.w3.org/2018/credentials/v1')).rejects.toThrow(
      DocumentNotFoundError,
    );
    await expect(loader(ISSUER_ID)).rejects.toThrow(/pass controller documents/);

    const { signer } = await testIssuer();
    await signCredential(buildCredential(credentialInput()), signer);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves given documents and their keys by fragment', async () => {
    const { profile, keyPair } = await testIssuer();
    const loader = createDocumentLoader({ documents: [profile] });
    expect((await loader(ISSUER_ID)).document).toEqual(profile);
    const key = await loader(`${ISSUER_ID}#${keyPair.publicKeyMultibase}`);
    expect(key.document).toMatchObject({
      '@context': MULTIKEY_CONTEXT_V1,
      type: 'Multikey',
      controller: ISSUER_ID,
    });
    await expect(loader(`${ISSUER_ID}#z6MkUnknown`)).rejects.toThrow(DocumentNotFoundError);
  });

  it('returns copies, so callers’ documents are never modified', async () => {
    const { profile } = await testIssuer();
    const loader = createDocumentLoader({ documents: [profile] });
    const { document } = await loader(ISSUER_ID);
    expect(document).not.toBe(profile);
  });

  it('requires an id on every document', () => {
    expect(() => createDocumentLoader({ documents: [{ name: 'no id' }] })).toThrow(/string "id"/);
  });
});
