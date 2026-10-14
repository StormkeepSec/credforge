import {
  CID_CONTEXT_V1,
  DATA_INTEGRITY_CONTEXT_V2,
  MULTIKEY_CONTEXT_V1,
  OB_CONTEXT_V3,
  OB_EXTENSIONS_CONTEXT,
  VC_CONTEXT_V2,
} from './constants';
import cidV1 from './vendor/contexts/cid-v1.json' with { type: 'json' };
import credentialsV2 from './vendor/contexts/credentials-v2.json' with { type: 'json' };
import dataIntegrityV2 from './vendor/contexts/data-integrity-v2.json' with { type: 'json' };
import multikeyV1 from './vendor/contexts/multikey-v1.json' with { type: 'json' };
import obV3Context from './vendor/contexts/ob-v3p0-context-3.0.3.json' with { type: 'json' };
import obV3Extensions from './vendor/contexts/ob-v3p0-extensions.json' with { type: 'json' };

/**
 * JSON-LD contexts bundled with the package, by URL. They are byte-for-byte copies of the
 * published files (see `src/vendor/README.md`); the document loader serves only these and never
 * fetches a context over the network.
 */
export const PINNED_CONTEXTS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  [VC_CONTEXT_V2, deepFreeze(credentialsV2)],
  [OB_CONTEXT_V3, deepFreeze(obV3Context)],
  [OB_EXTENSIONS_CONTEXT, deepFreeze(obV3Extensions)],
  [CID_CONTEXT_V1, deepFreeze(cidV1)],
  [MULTIKEY_CONTEXT_V1, deepFreeze(multikeyV1)],
  [DATA_INTEGRITY_CONTEXT_V2, deepFreeze(dataIntegrityV2)],
]);

// Contexts are shared by every document load, so a library that mutated one would corrupt all later
// canonicalizations. Freezing turns that into an immediate error.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
