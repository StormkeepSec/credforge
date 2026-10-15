# @credforge/ob3

The credforge credential engine: builds, signs, verifies, bakes and revokes
[Open Badges 3.0](https://www.imsglobal.org/spec/ob/v3p0) credentials. It is a pure library with no
database and no HTTP, so all standards correctness lives here and is tested here. The design is in
[docs/design-plan.md](../../docs/design-plan.md) §4.2, §5 and §6.

## What it does

| Area | Functions |
|---|---|
| Build | `buildCredential(input)` → unsigned `OpenBadgeCredential` (design plan §5.1) |
| Issue | `issueCredential(input, { signer, issuerProfile })`: build, schema-check, sign, then verify against the published issuer profile (the self-check, §5.2). Throws `SelfCheckError`. |
| Sign / verify | `signCredential`, `verifyProof` (`DataIntegrityProof`, `eddsa-rdfc-2022`, proof purpose `assertionMethod`) |
| Verify everything | `verifyCredential(credential, { resolveController, loadStatusListCredential, now })` → separate `format`, `proof`, `status` and `validity` checks (§8.5) |
| Schema | `validateCredentialSchema`, `validateProfileSchema` (official OB 3.0 JSON Schemas, bundled) |
| Recipient | `emailIdentifier`, `nameIdentifier`, `hashIdentity`, `normalizeEmail`, `verifyRecipient` (OB 3.0 §9.3) |
| Issuer | `buildIssuerProfile` (the JSON served at the issuer URL, also a controller document), `buildIssuerRef` |
| Keys | `generateEd25519KeyPair`, `createEd25519Signer`, the `Signer` interface |
| Baking | `bakePng` / `extractFromPng`, `bakeSvg` / `extractFromSvg` |
| Status lists | `Bitstring`, `allocateRandomIndex`, `buildStatusListEntry`, `buildStatusListCredential`, `issueStatusListCredential`, `checkStatusListEntry` |
| JSON-LD | `createDocumentLoader` (pinned contexts, never fetches), `PINNED_CONTEXTS` |

```ts
import {
  buildIssuerProfile,
  buildStatusListEntry,
  createEd25519Signer,
  generateEd25519KeyPair,
  issueCredential,
  bakePng,
} from '@credforge/ob3';

const issuerId = 'https://credforge.app/issuers/7f3e9a52-…';
const keys = await generateEd25519KeyPair(); // store secretKeyMultibase encrypted
const signer = await createEd25519Signer({ controller: issuerId, ...keys });
const issuerProfile = buildIssuerProfile({ id: issuerId, name: 'Example Academy', keys: [keys] });

const credential = await issueCredential(
  {
    id: 'https://credforge.app/credentials/0b6f3c1e-…',
    issuer: { id: issuerId, name: 'Example Academy', url: 'https://example.org' },
    achievement: { id, name, description, criteria: { narrative } },
    recipient: { email: 'jordan@example.com', name: 'Jordan Rivera' },
    validFrom: new Date(),
    credentialStatus: buildStatusListEntry({ statusListCredential: listUrl, index }),
  },
  { signer, issuerProfile },
);
const png = bakePng(badgeImageBytes, credential);
```

## Credential shape

The output matches design plan §5.1 with these details, all checked by tests:

- `@context` is `[credentials/v2, ob/v3p0/context-3.0.3.json, ob/v3p0/extensions.json]`. The third
  context is required: it is the only one that defines `1EdTechJsonSchemaValidator2019`, the
  `credentialSchema` type. Without it that type is an undefined term, and eddsa-rdfc-2022
  canonicalization (JSON-LD safe mode) refuses to sign. The OB 3.0 spec's own examples include it.
- `credentialSchema` points at the official AchievementCredential schema.
- `credentialSubject.identifier` holds a hashed `emailAddress` (`sha256$<hex>` of the normalized
  address + salt, UTF-8) and, unless left out, a plain `name`. The salt is 16 random bytes,
  base64url; store it with the credential.
- `credentialStatus.statusListIndex` is a string (Bitstring Status List v1.0). The OB examples use a
  number; `checkStatusListEntry` reads both.
- `proof` is a single object (not an array), as Digital Bazaar writes it. The schema allows both.
- Unset optional fields are omitted entirely, never `undefined`.

## Issuer profile and key discovery

The issuer id is an HTTPS URL. The JSON served there is an OB `Profile` that is also a W3C
controller document:

```json
{
  "@context": [
    "https://www.w3.org/ns/credentials/v2",
    "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json",
    "https://www.w3.org/ns/cid/v1"
  ],
  "id": "https://credforge.app/issuers/7f3e9a52-…",
  "type": ["Profile"],
  "name": "Example Cyber Academy",
  "verificationMethod": [{
    "id": "https://credforge.app/issuers/7f3e9a52-…#z6Mk…",
    "type": "Multikey",
    "controller": "https://credforge.app/issuers/7f3e9a52-…",
    "publicKeyMultibase": "z6Mk…"
  }],
  "assertionMethod": ["https://credforge.app/issuers/7f3e9a52-…#z6Mk…"]
}
```

Why this shape (the full golden file is `test/fixtures/golden/issuer-profile.json`):

- **The Controlled Identifiers v1.0 context** (`https://www.w3.org/ns/cid/v1`, a W3C
  Recommendation) defines `verificationMethod`, `assertionMethod`, `controller`, `Multikey` and
  `publicKeyMultibase`. Neither the VCDM 2.0 nor the OB context does, and Digital Bazaar's
  verifier frames the controller document in JSON-LD safe mode, so undefined terms fail. The
  three contexts combine without protected-term conflicts.
- **Proofs use `verificationMethod: "{issuerId}#{publicKeyMultibase}"`.** The 1EdTech validator
  (`EmbeddedProofProbe` in
  [digital-credentials-public-validator](https://github.com/1EdTech/digital-credentials-public-validator))
  decodes the key straight from that fragment and only requires the part before `#` to equal
  `issuer.id`; it doesn't fetch the profile for the proof. Its fallback for other key URLs looks
  for type `"MultiKey"` (capital K), which never matches a spec-conformant `Multikey`, so the
  fragment form is the one that works there.
- **Digital Bazaar's verifier** loads the key by its id (the document loader serves the matching
  `verificationMethod` entry with the Multikey context, which `ed25519-multikey` requires), then
  loads the controller document, checks that `assertionMethod` lists the key, and checks the key's
  controller is the credential issuer.
- `verificationMethod` is always an array, `assertionMethod` holds id strings (not embedded
  objects), and each method's `controller` is exactly the issuer id. The validator's DID path and
  most hand-written verifiers assume those forms.
- Retired keys stay in `assertionMethod`. A revoked key stays in `verificationMethod` with a
  `revoked` date but leaves `assertionMethod`, so its credentials fail Digital Bazaar verification.
  The 1EdTech validator never sees the profile, so it can't detect a revoked key.

`did:web` remains the fallback. The builders and verifiers are id-agnostic (a test builds a
`did:web:credforge.app:issuers:{uuid}` profile), but the HTTPS form verifies on both paths, so
there is no need to switch.

## Keys and the `Signer` interface

`generateEd25519KeyPair()` returns `publicKeyMultibase` (`z6Mk…`) and `secretKeyMultibase`
(`z3u2…`, the 32-byte seed with the `ed25519-priv` multicodec header). The server encrypts the
secret before storing it. `createEd25519Signer` checks the pair matches before returning.

Anything that implements `Signer` (`verificationMethod`, `algorithm: 'Ed25519'`,
`sign(bytes) → 64-byte signature`) can sign, so a KMS or HSM can replace the in-process signer
later without other changes.

## Status lists

`Bitstring` defaults to 131,072 entries. Index 0 is the left-most bit of the first byte, and
`encode()` gives `u` + base64url(GZIP). The GZIP header's OS byte is fixed so the encoding is
the same on every platform. `allocateRandomIndex(allocated)` picks a random free index (herd
privacy); the caller records the allocation. Status list credentials use only the VCDM 2.0
context, a string `issuer`, and the same signer as the issuer's credentials.

## Baking

- **PNG:** exactly one uncompressed `iTXt` chunk, keyword `openbadgecredential`, inserted after
  `IHDR`. The image data is not re-encoded. Baking an image that already has one throws unless
  `{ replace: true }`. CRCs are checked on read.
- **SVG:** `xmlns:openbadges="https://purl.imsglobal.org/ob/v3p0"` on the root and
  `<openbadges:credential><![CDATA[…]]></openbadges:credential>` directly after it (a compact JWS
  goes in a `verify` attribute instead). Extraction accepts any prefix bound to that namespace.
  This edits only the root element; sanitize uploaded SVGs before baking.

## Pinned contexts

`createDocumentLoader()` serves the bundled contexts and the documents you pass it, and nothing
else. It has no network access, so a compromised or unavailable context URL can't change what a
signature covers. The files and their sources and hashes are listed in
[src/vendor/README.md](src/vendor/README.md). To verify a credential from another issuer, fetch its
issuer profile yourself and hand it over through `resolveController`.

## Tests

```bash
pnpm --filter @credforge/ob3 test
```

- **Two independent verification paths.** Every credential the tests produce is verified by
  Digital Bazaar's verifier and by `test/support/independent-verifier.ts`, which shares no code
  with signing: `jsonld-streaming-parser` instead of jsonld.js, `rdfjs-c14n` instead of
  rdf-canonize, `node:crypto` Ed25519 and a hand-written base58 decoder, with the 1EdTech
  validator's key-resolution rules. Both canonicalizers produce identical N-Quads.
- **Official schema:** every produced credential passes the bundled OB 3.0 JSON Schema.
- **W3C test vectors:** signing through the `Signer` interface reproduces the published
  vc-di-eddsa eddsa-rdfc-2022 `proofValue` and canonical forms exactly.
- **Golden files** in `test/fixtures/golden/` (unsigned and signed credential, canonical N-Quads,
  issuer profile) use a fixed test key. After an intended change, run
  `pnpm --filter @credforge/ob3 exec vitest run -u` and review the diff.
- **Cross-checks:** the status list encoding round-trips with Digital Bazaar's
  `vc-bitstring-status-list`; recipient hashes match the spec example and `sha256sum`/`md5sum`.

## Checking with the 1EdTech validator

The engine has to pass the 1EdTech validator (milestone M1). That check is manual:

```bash
pnpm --filter @credforge/ob3 fixtures
```

This writes `fixtures/sample/` (committed; a test keeps it in sync with the code). It uses a fixed
**public test key**, so anyone can sign as the sample issuer: host the sample only for the check
and remove it afterwards.

| File | Use |
|---|---|
| `credential-no-status.json`, `badge-no-status.png` | Validate right away: no hosting needed |
| `credential.json`, `badge.png`, `badge.svg` | Valid credential with a status entry: needs hosting |
| `credential-revoked.json` | Should be reported as revoked: needs hosting |
| `public/` | Documents to host at the base URL |

What the validator dereferences (from its source, `OB30Inspector`):

- **The status list credential, always, when `credentialStatus` is present.** It fetches
  `statusListCredential`, verifies that credential's proof and reads the bit. An unreachable list
  fails validation. This is why the credentials with a status entry need hosting.
- **`issuer.url`**, to check it is reachable. Failure is only a warning. The sample uses the base
  URL's origin.
- **Not the issuer profile** for a `{issuerId}#z6Mk…` verification method. Host it anyway: other
  verifiers, including credforge's own, need it.

Steps:

1. Put a sample online over HTTPS, generated for the URL it will be served from. The extensionless
   JSON files (`issuers/{uuid}`, `status/{uuid}/1`) must be sent as `Content-Type: application/json`.
   Either:

   - **A temporary tunnel (no server needed).** Start a Cloudflare quick tunnel
     ([`cloudflared`](https://github.com/cloudflare/cloudflared/releases), no account), then
     generate a sample for the address it prints into a separate folder (the committed fixtures
     stay as they are), and serve it. Run from the repo root:

     ```bash
     cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787
     pnpm --filter @credforge/ob3 fixtures -- --base-url https://<name>.trycloudflare.com --out ../ob3-tunnel-sample
     pnpm --filter @credforge/ob3 serve-sample -- --dir ../ob3-tunnel-sample/public
     ```

     `serve-sample` logs every request, so you can see what the validator fetched. The address
     changes each time the tunnel starts; regenerate the sample after a restart.

   - **nginx on the droplet**, e.g. at `https://credforge.app/ob3-sample` (the default base URL,
     so `pnpm --filter @credforge/ob3 fixtures` alone generates the right sample). Copy
     `fixtures/sample/public/` to `/var/www/ob3-sample/` and add:

     ```nginx
     location /ob3-sample/ {
         alias /var/www/ob3-sample/;
         default_type application/json;
         types { image/png png; }
     }
     ```

2. Check that `curl -i <base-url>/status/5a1e0c7d-3b2f-4e8a-9c6d-0f1e2d3c4b5a/1` returns the JSON
   with `200` and `application/json`.
3. Upload each JSON file and each baked image to the 1EdTech validator (https://vc.1ed.tech, choose
   the Open Badges 3.0 validator). Expected: the active and no-status credentials pass, and the
   revoked one is reported as revoked. If a proof fails, the downloadable report includes the
   validator's canonicalized document and proof configuration; compare them with
   `test/fixtures/golden/credential.canonical.nq`-style output from `cryptosuite.canonize`.
4. Record the result in docs/design-plan.md (§17, M1), then take the sample offline (stop the
   tunnel and `serve-sample`, or remove the nginx location).

The validator's "Uri to Resource" field also takes a URL, so credentials issued by a running
credforge instance need no files: give it the credential's URL, then `{credential URL}/badge.png`
and `{credential URL}/badge.svg`. For a local check, start the production stack with
`PUBLIC_BASE_URL` set to a quick tunnel's address and a fresh database (the base URL is recorded on
first start), as was done for M3 (design plan §17). To check revocation, revoke a credential in
the issuer app and wait until the worker has re-signed its status list (a few seconds: the
instance's own `/verify` page then says "The issuer has revoked this credential" instead of "being
updated"), then give the validator the credential's URL; it should report it as revoked.

## Using it from the server

The server bundles `@credforge/ob3` with tsup, and npm dependencies stay external. When the server
starts importing it (M2), add `@credforge/ob3` to its devDependencies and this package's runtime
`dependencies` to the server's `dependencies`, as is already done for `@credforge/db`; otherwise
`pnpm deploy --prod` leaves them out of the image. A test bundle of the package with esbuild runs in
plain Node ESM, including the JSON imports.
