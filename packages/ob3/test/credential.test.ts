import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENT_CREDENTIAL_SCHEMA_URL,
  buildCredential,
  checkFormat,
  toDateTimeString,
  validateCredentialSchema,
} from '../src/index';
import { ACHIEVEMENT_ID, credentialInput, ISSUED_AT } from './support/fixtures';

describe('buildCredential', () => {
  it('builds the design plan §5.1 shape (golden)', async () => {
    const credential = buildCredential(credentialInput());
    await expect(`${JSON.stringify(credential, null, 2)}\n`).toMatchFileSnapshot(
      './fixtures/golden/credential.unsigned.json',
    );
    expect(credential['@context']).toEqual([
      'https://www.w3.org/ns/credentials/v2',
      'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json',
      'https://purl.imsglobal.org/spec/ob/v3p0/extensions.json',
    ]);
    expect(credential.credentialSchema).toEqual([
      { id: ACHIEVEMENT_CREDENTIAL_SCHEMA_URL, type: '1EdTechJsonSchemaValidator2019' },
    ]);
    expect(credential.credentialStatus?.statusListIndex).toBe('48213');
  });

  it('passes the official JSON Schema', () => {
    expect(validateCredentialSchema(buildCredential(credentialInput()))).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('fills every optional field and still passes the schema', () => {
    const credential = buildCredential(
      credentialInput({
        name: 'Network Defense, with distinction',
        description: 'Awarded at the spring cohort ceremony.',
        validUntil: '2029-11-02T15:04:05Z',
        evidence: [
          {
            id: 'https://example.org/portfolio/jordan',
            name: 'Lab portfolio',
            narrative: 'Six lab write-ups.',
            description: 'Reviewed by two instructors.',
            genre: 'Portfolio',
            audience: 'Employers',
          },
          { narrative: 'Final assessment: 92%.' },
        ],
        result: [{ status: 'Completed', value: '92' }],
        achievement: {
          id: ACHIEVEMENT_ID,
          name: 'Intro to Network Defense',
          description: 'Recognizes foundational skills in defending small networks.',
          criteria: {
            id: 'https://example.org/criteria/network-defense',
            narrative: 'Do the labs.',
          },
          achievementType: 'Certificate',
          image: { id: `${ACHIEVEMENT_ID}/images/9f2c7b11.png`, caption: 'Shield badge' },
          tag: ['networking', ' ', 'security '],
          alignment: [
            {
              targetName: 'Network Security',
              targetUrl: 'https://example.org/frameworks/sec/1.2',
              targetDescription: 'Secures small office networks.',
              targetCode: '1.2',
              targetFramework: 'Example Skills Framework',
              targetType: 'ext:ExampleSkill',
            },
          ],
          humanCode: 'IND-101',
          fieldOfStudy: 'Computer Security',
          specialization: 'Networks',
          version: '2',
          inLanguage: 'en',
          creditsAvailable: 1.5,
        },
      }),
    );
    expect(credential.validUntil).toBe('2029-11-02T15:04:05Z');
    expect(credential.credentialSubject.achievement.tag).toEqual(['networking', 'security']);
    expect(credential.evidence?.[1]).toEqual({
      type: ['Evidence'],
      narrative: 'Final assessment: 92%.',
    });
    expect(validateCredentialSchema(credential)).toEqual({ valid: true, errors: [] });
  });

  it('omits optional fields that were not given (no undefined values reach JSON-LD)', () => {
    const credential = buildCredential(
      credentialInput({
        credentialStatus: undefined,
        recipient: { email: 'a@example.com' },
        issuer: { id: 'https://credforge.app/issuers/1', name: 'Minimal issuer' },
      }),
    );
    expect(Object.keys(credential)).not.toContain('credentialStatus');
    expect(Object.keys(credential)).not.toContain('validUntil');
    expect(credential.issuer).toEqual({
      id: 'https://credforge.app/issuers/1',
      type: ['Profile'],
      name: 'Minimal issuer',
    });
    expect(credential.credentialSubject.identifier).toHaveLength(1);
    expect(JSON.stringify(credential)).not.toContain('undefined');
    expect(validateCredentialSchema(credential).valid).toBe(true);
  });

  it('defaults the name to the achievement name and the type to Badge', () => {
    const credential = buildCredential(credentialInput());
    expect(credential.name).toBe('Intro to Network Defense');
    expect(credential.credentialSubject.achievement.achievementType).toBe('Badge');
  });

  it.each([
    ['a relative credential id', { id: '/credentials/1' }, /"id" must be an absolute URL/],
    ['an issue date without a time zone', { validFrom: '2026-11-02T15:04:05' }, /time zone/],
    ['an invalid date', { validFrom: 'yesterday Z' }, /not a valid date/],
    [
      'an expiry before the issue date',
      { validUntil: '2026-11-01T00:00:00Z' },
      /later than "validFrom"/,
    ],
    ['an empty issuer name', { issuer: { id: 'https://x.org/i', name: ' ' } }, /issuer.name/],
    [
      'an achievement without criteria',
      {
        achievement: {
          id: ACHIEVEMENT_ID,
          name: 'A',
          description: 'B',
          criteria: { narrative: '  ' },
        },
      },
      /criteria/,
    ],
    ['an invalid evidence URL', { evidence: [{ id: 'nope' }] }, /evidence.id/],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => buildCredential(credentialInput(overrides))).toThrow(message);
  });

  it('lets the schema catch values the builder passes through', () => {
    const credential = buildCredential(
      credentialInput({
        achievement: { ...credentialInput().achievement, achievementType: 'Trophy' },
      }),
    );
    const format = checkFormat(credential);
    expect(format.outcome).toBe('failed');
    expect(format.details?.join('\n')).toMatch(/achievementType/);
  });
});

describe('toDateTimeString', () => {
  it('drops fractional seconds and normalizes to UTC', () => {
    expect(toDateTimeString(new Date('2026-11-02T15:04:05.678Z'))).toBe(ISSUED_AT);
    expect(toDateTimeString('2026-11-02T17:04:05+02:00')).toBe(ISSUED_AT);
  });
});

describe('checkFormat', () => {
  it('requires an id or identifier on the subject (OB 3.0 §9.1)', () => {
    const credential = buildCredential(credentialInput());
    const { identifier: _identifier, ...subject } = credential.credentialSubject;
    const format = checkFormat({ ...credential, credentialSubject: subject });
    expect(format.outcome).toBe('failed');
    expect(format.details).toContain(
      '/credentialSubject must have an id or an identifier (OB 3.0 §9.1)',
    );
  });

  it('reports schema errors with their JSON pointer', () => {
    const format = checkFormat({ ...buildCredential(credentialInput()), validFrom: 'soon' });
    expect(format.outcome).toBe('failed');
    expect(format.details?.some((line) => line.startsWith('/validFrom'))).toBe(true);
  });
});
