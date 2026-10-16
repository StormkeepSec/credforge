import { API_KEY_SCOPES } from '@credforge/contracts';
import { z } from 'zod';
import { OPERATIONS, type Operation, problemSchema } from './operations';

type JsonSchema = Record<string, unknown>;

/**
 * Converts a Zod schema to JSON Schema (2020-12, as OpenAPI 3.1 uses). Schemas with an `id`
 * (`.meta({ id })`) become shared components, referenced as `#/components/schemas/{id}`.
 */
function toJsonSchema(
  schema: z.ZodType,
  io: 'input' | 'output',
  components: Record<string, JsonSchema>,
): JsonSchema {
  const converted = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonSchema;
  const { $schema: _schema, $defs, ...rest } = converted;
  const relink = (value: unknown): JsonSchema =>
    JSON.parse(JSON.stringify(value).replaceAll('"#/$defs/', '"#/components/schemas/'));
  for (const [id, definition] of Object.entries(($defs ?? {}) as Record<string, unknown>)) {
    components[id] ??= relink(definition);
  }
  return relink(rest);
}

const ERRORS: Record<number, string> = {
  400: 'Invalid input (`validation_failed`, with field errors)',
  401: 'Not signed in, or the API key is unknown, revoked or expired',
  403: 'Not allowed (role, key scope, org status, or an endpoint API keys can’t use)',
  404: 'Not found (also for organizations you aren’t a member of)',
  429: 'Too many requests (`rate_limited`, with `Retry-After`)',
};

function errorStatuses(op: Operation): number[] {
  const statuses = [400, 429];
  if (op.auth.kind !== 'public') statuses.push(401, 403);
  if (op.path.includes('{')) statuses.push(404);
  return statuses.sort();
}

/** `POST /orgs/{orgId}/credentials/{credentialId}/revoke` → `postCredentialsByCredentialIdRevoke`. */
function operationId(op: Operation): string {
  const path = op.path.startsWith('/orgs/{orgId}/')
    ? op.path.slice('/orgs/{orgId}'.length)
    : op.path;
  const words = path
    .split('/')
    .filter(Boolean)
    .flatMap((part) => (part.startsWith('{') ? ['by', part.slice(1, -1)] : part.split(/[-.]/)));
  return [op.method.toLowerCase(), ...words]
    .map((word, i) => (i === 0 ? word : `${word[0]?.toUpperCase()}${word.slice(1)}`))
    .join('');
}

function authNote(op: Operation): string {
  switch (op.auth.kind) {
    case 'public':
      return 'No sign-in needed.';
    case 'session':
      return 'Needs a person signed in.';
    case 'platform':
      return 'Needs a platform admin signed in.';
    case 'org': {
      const permission = op.auth.permission ? ` with \`${op.auth.permission}\`` : '';
      return op.auth.apiKey
        ? `A member${permission}, or an API key with that scope.`
        : `A member${permission}. Not available to API keys.`;
    }
  }
}

function security(op: Operation): Record<string, string[]>[] {
  if (op.auth.kind === 'public') return [];
  if (op.auth.kind === 'org' && op.auth.apiKey) return [{ apiKey: [] }, { session: [] }];
  return [{ session: [] }];
}

/** The OpenAPI 3.1 document for `/api/v1`, built from the operations table. */
export function buildOpenApiDocument(publicBaseUrl: string): JsonSchema {
  const components: Record<string, JsonSchema> = {};
  const problemRef = toJsonSchema(problemSchema, 'output', components);
  const paths: Record<string, Record<string, unknown>> = {};

  for (const op of OPERATIONS) {
    const parameters: JsonSchema[] = [];
    for (const name of op.path.match(/\{(\w+)\}/g) ?? []) {
      const param = name.slice(1, -1);
      parameters.push({
        name: param,
        in: 'path',
        required: true,
        schema: param === 'token' ? { type: 'string' } : { type: 'string', format: 'uuid' },
      });
    }
    if (op.query) {
      for (const [name, field] of Object.entries(op.query.shape)) {
        const schema = toJsonSchema(field as z.ZodType, 'input', components);
        parameters.push({
          name,
          in: 'query',
          required: !(field as z.ZodType).safeParse(undefined).success,
          schema,
          ...(typeof schema.description === 'string' && { description: schema.description }),
        });
      }
    }

    const content: Record<string, unknown> = {};
    if (op.body)
      content['application/json'] = { schema: toJsonSchema(op.body, 'input', components) };
    for (const type of op.rawBody?.contentTypes ?? []) {
      content[type] = {
        schema: { type: 'string', contentMediaType: type, description: op.rawBody?.description },
      };
    }

    const responses: Record<string, unknown> = {};
    for (const response of op.responses) {
      const type = response.contentType ?? 'application/json';
      responses[String(response.status)] = {
        description: response.description,
        ...(response.schema
          ? { content: { [type]: { schema: toJsonSchema(response.schema, 'output', components) } } }
          : response.contentType
            ? { content: { [type]: { schema: { type: 'string' } } } }
            : {}),
      };
    }
    for (const status of errorStatuses(op)) {
      responses[String(status)] = {
        description: ERRORS[status],
        content: { 'application/problem+json': { schema: problemRef } },
      };
    }

    paths[op.path] ??= {};
    (paths[op.path] as Record<string, unknown>)[op.method.toLowerCase()] = {
      operationId: operationId(op),
      tags: [op.tag],
      summary: op.summary,
      description: [op.description, authNote(op)].filter(Boolean).join('\n\n'),
      security: security(op),
      ...(parameters.length > 0 && { parameters }),
      ...(Object.keys(content).length > 0 && {
        requestBody: { required: !op.rawBody || !op.body, content },
      }),
      responses,
    };
  }

  const tags = [...new Set(OPERATIONS.map((op) => op.tag))].map((name) => ({ name }));
  return {
    openapi: '3.1.0',
    info: {
      title: 'credforge API',
      version: '1',
      description: [
        'Create and award Open Badges 3.0 badges from your own systems.',
        '',
        '**Authentication.** Create an API key under *Settings → API keys* in the issuer app and send it as `Authorization: Bearer cf_…`. A key belongs to one organization and can only use the operations marked for API keys, with the scopes it was given: ' +
          API_KEY_SCOPES.map((scope) => `\`${scope}\``).join(', ') +
          '. Requests from the issuer app use its session cookie instead.',
        '',
        '**Errors** are `application/problem+json` (RFC 9457) with a machine-readable `code`.',
        '',
        '**Rate limits.** Each API key has its own limit per minute; over it, `429` with `Retry-After`. Verification is limited per client IP.',
        '',
        '**Pagination** is by cursor: pass the `next` value from one page as `before` (or `after`) for the next.',
      ].join('\n'),
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: `${publicBaseUrl}/api/v1` }],
    tags,
    paths,
    components: {
      schemas: components,
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'cf_…',
          description: 'An API key from Settings → API keys.',
        },
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'credforge.session_token',
          description: 'The issuer app’s session (sign in at /login).',
        },
      },
    },
  };
}
