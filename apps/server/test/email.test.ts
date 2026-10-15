import { describe, expect, it } from 'vitest';
import { invitationMessage, orgDeclinedMessage, verifyEmailMessage } from '../src/email/messages';
import { createMemoryOutbox, emailJobHandler } from '../src/email/outbox';
import { createEmailTransport } from '../src/email/transport';

describe('email messages', () => {
  it('escapes names in HTML but keeps the text readable', () => {
    const message = invitationMessage({
      to: 'jordan@example.org',
      orgName: 'Acme <script>alert(1)</script>',
      inviterName: 'Sam "the admin"',
      role: 'admin',
      url: 'https://credforge.test/invite/abc?x=1&y=2',
      expiresAt: new Date('2026-11-01T12:00:00Z'),
    });
    expect(message.subject).toBe('Join Acme <script>alert(1)</script> on credforge');
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('Acme &lt;script&gt;');
    expect(message.html).toContain('href="https://credforge.test/invite/abc?x=1&amp;y=2"');
    expect(message.text).toContain(
      'Sam "the admin" invited you to join Acme <script>alert(1)</script> on credforge as an admin.',
    );
    expect(message.text).toContain('expires on November 1, 2026');
  });

  it('includes the link in both versions', () => {
    const message = verifyEmailMessage(
      'a@example.org',
      'A',
      'https://credforge.test/api/auth/verify-email?token=t',
    );
    expect(message.kind).toBe('verify-email');
    expect(message.text).toContain('https://credforge.test/api/auth/verify-email?token=t');
    expect(message.html).toContain('https://credforge.test/api/auth/verify-email?token=t');
  });

  it('leaves out a missing reason', () => {
    expect(orgDeclinedMessage('a@example.org', 'Org', null).text).not.toContain('Reason');
    expect(orgDeclinedMessage('a@example.org', 'Org', 'Spam').text).toContain('Reason: Spam');
  });
});

describe('email transports', () => {
  it('logs instead of sending with EMAIL_TRANSPORT=log', async () => {
    const lines: string[] = [];
    const log = {
      info: (_meta: unknown, line?: string) => {
        lines.push(line ?? '');
      },
    } as Parameters<typeof createEmailTransport>[1];
    const transport = createEmailTransport(
      { email: { transport: 'log', from: 'credforge <no-reply@credforge.test>' } },
      log,
    );
    await transport.send(verifyEmailMessage('a@example.org', 'A', 'https://credforge.test/x'));
    expect(lines[0]).toContain('https://credforge.test/x');
  });

  it('sends queued messages through the transport', async () => {
    const sent: string[] = [];
    const handler = emailJobHandler(
      {
        name: 'test',
        send: async (message) => {
          sent.push(message.to);
          return { messageId: '1' };
        },
      },
      { info() {}, warn() {}, error() {} },
    );
    await handler(verifyEmailMessage('b@example.org', 'B', 'https://credforge.test/y'));
    expect(sent).toEqual(['b@example.org']);
  });

  it('keeps messages in memory for tests', async () => {
    const outbox = createMemoryOutbox();
    await outbox.send(verifyEmailMessage('c@example.org', 'C', 'https://credforge.test/z'));
    expect(outbox.messages.map((message) => message.to)).toEqual(['c@example.org']);
  });
});
