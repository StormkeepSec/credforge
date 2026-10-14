// Minimal typings for the Digital Bazaar libraries, which ship JavaScript only. They cover just the
// parts of each API that this package calls.

declare module '@digitalbazaar/vc' {
  export interface RemoteDocument {
    contextUrl: string | null;
    documentUrl: string;
    document: unknown;
  }

  export type DocumentLoader = (url: string) => Promise<RemoteDocument>;

  export interface VerifyCredentialResult {
    verified: boolean;
    error?: unknown;
    results?: Array<{ verified: boolean; error?: unknown }>;
  }

  export function issue(options: {
    credential: object;
    suite: unknown;
    documentLoader?: DocumentLoader;
    now?: string | Date;
  }): Promise<Record<string, unknown>>;

  export function verifyCredential(options: {
    credential: object;
    suite: unknown;
    documentLoader?: DocumentLoader;
    checkStatus?: () => Promise<{ verified: boolean }>;
    now?: string | Date;
    maxClockSkew?: number;
  }): Promise<VerifyCredentialResult>;
}

declare module '@digitalbazaar/data-integrity' {
  export interface DataIntegritySigner {
    id: string;
    algorithm: string;
    sign(options: { data: Uint8Array }): Promise<Uint8Array>;
  }

  export class DataIntegrityProof {
    constructor(options: { cryptosuite: unknown; signer?: DataIntegritySigner; date?: Date });
  }
}

declare module '@digitalbazaar/eddsa-rdfc-2022-cryptosuite' {
  export const cryptosuite: {
    name: string;
    requiredAlgorithm: string;
    canonize(input: object, options: object): Promise<string>;
  };
}

declare module '@digitalbazaar/ed25519-multikey' {
  export interface Ed25519MultikeyKeyPair {
    id?: string;
    controller?: string;
    publicKeyMultibase: string;
    secretKeyMultibase?: string;
    export(options: {
      publicKey?: boolean;
      secretKey?: boolean;
      includeContext?: boolean;
      canonicalize?: boolean;
    }): Promise<{ publicKeyMultibase: string; secretKeyMultibase?: string }>;
    signer(): {
      id?: string;
      algorithm: string;
      sign(options: { data: Uint8Array }): Promise<Uint8Array>;
    };
    verifier(): {
      algorithm: string;
      verify(options: { data: Uint8Array; signature: Uint8Array }): Promise<boolean>;
    };
  }

  export function generate(options?: {
    id?: string;
    controller?: string;
    seed?: Uint8Array;
  }): Promise<Ed25519MultikeyKeyPair>;

  export function from(key: {
    type?: string;
    '@context'?: string | string[];
    id?: string;
    controller?: string;
    publicKeyMultibase: string;
    secretKeyMultibase?: string;
  }): Promise<Ed25519MultikeyKeyPair>;
}
