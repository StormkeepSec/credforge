import type { ErrorObject, ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import addFormats from 'ajv-formats';
import achievementCredentialSchema from './vendor/schemas/ob_v3p0_achievementcredential_schema.json' with {
  type: 'json',
};
import profileSchema from './vendor/schemas/ob_v3p0_profile_schema.json' with { type: 'json' };

export interface SchemaValidationResult {
  valid: boolean;
  /** One line per problem, e.g. `/credentialSubject/identifier/0 must have required property 'hashed'`. */
  errors: string[];
}

let validators: { credential: ValidateFunction; profile: ValidateFunction } | undefined;

// The official schemas are JSON Schema draft 2019-09. Compiling takes a moment, so it happens once,
// on first use.
function getValidators() {
  if (!validators) {
    // `strict: false` because the official schemas use draft 2019-09 constructs (tuple `items` with
    // `additionalItems`) that Ajv's strict mode flags; they are valid for that draft.
    const ajv = new Ajv2019({ allErrors: true, strict: false });
    addFormats(ajv);
    validators = {
      credential: ajv.compile(achievementCredentialSchema),
      profile: ajv.compile(profileSchema),
    };
  }
  return validators;
}

/** Validates against the official OB 3.0 AchievementCredential JSON Schema (bundled copy). */
export function validateCredentialSchema(credential: unknown): SchemaValidationResult {
  return run(getValidators().credential, credential);
}

/** Validates against the official OB 3.0 Profile JSON Schema (bundled copy). */
export function validateProfileSchema(profile: unknown): SchemaValidationResult {
  return run(getValidators().profile, profile);
}

function run(validate: ValidateFunction, data: unknown): SchemaValidationResult {
  if (validate(data)) return { valid: true, errors: [] };
  return { valid: false, errors: (validate.errors ?? []).map(formatError) };
}

function formatError(error: ErrorObject): string {
  const params = Object.entries(error.params)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ');
  return `${error.instancePath || '/'} ${error.message ?? 'is invalid'}${params ? ` (${params})` : ''}`;
}
