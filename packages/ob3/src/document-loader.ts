import { MULTIKEY_CONTEXT_V1 } from './constants';
import { PINNED_CONTEXTS } from './contexts';

/** What a JSON-LD document loader returns (the jsonld.js `RemoteDocument` shape). */
export interface RemoteDocument {
  contextUrl: null;
  documentUrl: string;
  document: unknown;
}

export type DocumentLoader = (url: string) => Promise<RemoteDocument>;

export interface DocumentLoaderOptions {
  /**
   * Documents to serve besides the pinned contexts, keyed by their `id`: typically the issuer
   * profile (controller document) that the caller fetched and chose to check against. A key
   * listed in a document's `verificationMethod` is served at its own id, `{id}#{fragment}`.
   */
  documents?: Iterable<unknown>;
  /** Extra contexts by URL, for tests or for a newer context the caller has pinned itself. */
  contexts?: Iterable<readonly [string, unknown]>;
}

export class DocumentNotFoundError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(
      `The document loader does not have "${url}". Contexts are pinned and never fetched; ` +
        'pass controller documents in the "documents" option.',
    );
    this.name = 'DocumentNotFoundError';
    this.url = url;
  }
}

/**
 * Creates a JSON-LD document loader that serves the pinned contexts plus the given documents and
 * nothing else. It makes no network requests, so signing and verifying can't be influenced by
 * whatever a context URL happens to return.
 */
export function createDocumentLoader(options: DocumentLoaderOptions = {}): DocumentLoader {
  const contexts = new Map<string, unknown>(PINNED_CONTEXTS);
  for (const [url, context] of options.contexts ?? []) contexts.set(url, context);

  const documents = new Map<string, Record<string, unknown>>();
  for (const document of options.documents ?? []) {
    if (!isRecord(document) || typeof document.id !== 'string') {
      throw new TypeError('Every document passed to the document loader needs a string "id".');
    }
    documents.set(document.id, document);
  }

  return async (url) => {
    const context = contexts.get(url);
    if (context !== undefined) return { contextUrl: null, documentUrl: url, document: context };

    const hash = url.indexOf('#');
    const document = documents.get(hash === -1 ? url : url.slice(0, hash));
    if (document) {
      if (hash === -1) {
        return { contextUrl: null, documentUrl: url, document: structuredClone(document) };
      }
      const method = findVerificationMethod(document, url);
      if (method) return { contextUrl: null, documentUrl: url, document: method };
    }
    throw new DocumentNotFoundError(url);
  };
}

/**
 * Finds the verification method with the given id in a controller document and returns it as a
 * standalone JSON-LD document. A Multikey gets the Multikey context, which Digital Bazaar's key
 * library requires.
 */
export function findVerificationMethod(
  controllerDocument: unknown,
  id: string,
): Record<string, unknown> | undefined {
  if (!isRecord(controllerDocument) || typeof controllerDocument.id !== 'string') return undefined;
  const controllerId = controllerDocument.id;
  for (const method of asArray(controllerDocument.verificationMethod)) {
    if (!isRecord(method) || typeof method.id !== 'string') continue;
    // Controlled Identifiers allows relative ids such as "#key-1".
    const methodId = method.id.startsWith('#') ? `${controllerId}${method.id}` : method.id;
    if (methodId !== id) continue;
    const { '@context': _ignored, ...rest } = structuredClone(method);
    const context =
      method.type === 'Multikey' ? MULTIKEY_CONTEXT_V1 : controllerDocument['@context'];
    return { '@context': context, ...rest, id: methodId };
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
