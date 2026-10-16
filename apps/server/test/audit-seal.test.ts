import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newAuditKey, openRecipientDetails, sealRecipientDetails } from '../src/audit/audit';

describe('sealed recipient details (design plan §12.1)', () => {
  const details = {
    data: { recipientName: 'Quinn Erasable', recipientEmail: 'quinn@example.org' },
    actorLabel: 'Quinn Erasable',
    ip: '203.0.113.9',
  };

  it('open with the credential’s key, and say nothing readable while sealed', () => {
    const key = newAuditKey();
    const id = randomUUID();
    const sealed = sealRecipientDetails(key, id, details);
    expect(sealed).not.toMatch(/quinn|203\.0/i);
    expect(openRecipientDetails(key, id, sealed)).toEqual(details);
    // A fresh IV every time.
    expect(sealRecipientDetails(key, id, details)).not.toBe(sealed);
  });

  it('stay shut with another key, for another credential, or once changed', () => {
    const key = newAuditKey();
    const id = randomUUID();
    const sealed = sealRecipientDetails(key, id, details);
    expect(openRecipientDetails(newAuditKey(), id, sealed)).toBeNull();
    expect(openRecipientDetails(key, randomUUID(), sealed)).toBeNull();
    const [iv, ciphertext, tag] = sealed.split('.');
    const flipped = `${iv}.${ciphertext?.startsWith('A') ? 'B' : 'A'}${ciphertext?.slice(1)}.${tag}`;
    expect(openRecipientDetails(key, id, flipped)).toBeNull();
    expect(openRecipientDetails(key, id, 'not sealed')).toBeNull();
  });
});
