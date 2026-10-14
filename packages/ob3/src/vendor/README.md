# Vendored contexts and schemas

Byte-for-byte copies of published files, retrieved on 2026-10-14. The document loader serves the
contexts from here and never fetches them, and the schema validator compiles the schemas from here.
`test/document-loader.test.ts` checks every file against the SHA-256 below, so any edit is caught.
Biome ignores this folder so the files stay exactly as published.

| File | Source URL | SHA-256 |
|---|---|---|
| `contexts/credentials-v2.json` | https://www.w3.org/ns/credentials/v2 | `59955ced6697d61e03f2b2556febe5308ab16842846f5b586d7f1f7adec92734` |
| `contexts/ob-v3p0-context-3.0.3.json` | https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json | `3d34f4d4ef1bce691106e63798beb5e7b862ba841423f5ee1e53ab7ddf3bca84` |
| `contexts/ob-v3p0-extensions.json` | https://purl.imsglobal.org/spec/ob/v3p0/extensions.json | `87c06c81bc2317663bf288d740d94fddd2818c4342b186270ff6371dfaa63f93` |
| `contexts/cid-v1.json` | https://www.w3.org/ns/cid/v1 | `ea216ecc1cb02cd39b693dba2250141e270ba0bf95890be107dd9a9e8e43de85` |
| `contexts/multikey-v1.json` | https://w3id.org/security/multikey/v1 | `ba2c182de2d92f7e47184bcca8fcf0beaee6d3986c527bf664c195bbc7c58597` |
| `contexts/data-integrity-v2.json` | https://w3id.org/security/data-integrity/v2 | `67f21e6e33a6c14e5ccfd2fc7865f7474fb71a04af7e94136cb399dfac8ae8f4` |
| `schemas/ob_v3p0_achievementcredential_schema.json` | https://purl.imsglobal.org/spec/ob/v3p0/schema/json/ob_v3p0_achievementcredential_schema.json | `b7358e895f492e74055dc6bfc7ffc420d0e497f90c4579fb83d9519b86d393ea` |
| `schemas/ob_v3p0_profile_schema.json` | https://purl.imsglobal.org/spec/ob/v3p0/schema/json/ob_v3p0_profile_schema.json | `6b268f2caa591bf657e2a290e195713c41dc2db4e1c797723cfd00a1a83f8f13` |

The security v1/v2 contexts that Digital Bazaar's controller check uses come bundled with
`jsonld-signatures` (`@digitalbazaar/security-context`).

## Updating

1. Download the new file to a scratch folder (contexts need `Accept: application/ld+json`; w3id.org
   redirects).
2. Diff it against the copy here and read every change: a context change alters what every
   signature covers.
3. Replace the file, update the hash here and in `test/document-loader.test.ts`, and run
   `pnpm --filter @credforge/ob3 test`. A new context version (for example OB `context-3.0.4.json`)
   is a new file and URL, not an edit of the old one; issued credentials keep referencing the old
   URL, so keep the old file too.

The W3C files are under the W3C Software and Document License; the 1EdTech files are published by
1EdTech for implementers of the Open Badges specification.
