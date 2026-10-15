import nodemailer from 'nodemailer';
import type { Logger } from 'pino';
import { type Config, type Mailbox, parseMailbox } from '../config';

/** A rendered email, ready to send. */
export interface EmailMessage {
  /** Template name, for logs and delivery tracking, e.g. `verify-email`, `award`. */
  kind: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  /**
   * Display name instead of EMAIL_FROM's, e.g. "Example Academy via credforge" (design plan
   * §6.3). The address is always EMAIL_FROM's: credforge never sends as the issuer's domain.
   */
  fromName?: string;
  /** The `email_message` row whose delivery status this send updates (award emails). */
  trackingId?: string;
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<{ messageId?: string }>;
}

/** A display name that can't break out of the From header. */
export function safeDisplayName(name: string): string {
  return name
    .replace(/\p{Cc}/gu, ' ')
    .replace(/["<>\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** The sender for a message: EMAIL_FROM's address, with the message's display name if it has one. */
export function senderOf(from: Mailbox, message: Pick<EmailMessage, 'fromName'>): Mailbox {
  const name = message.fromName ? safeDisplayName(message.fromName) : from.name;
  return name ? { name, address: from.address } : { address: from.address };
}

/**
 * Builds the transport named by EMAIL_TRANSPORT. `smtp` sends through any SMTP server (Mailpit
 * in development); `log` prints messages to the log instead of sending them, for development
 * only, since it prints the links in them.
 */
export function createEmailTransport(
  config: Pick<Config, 'email'>,
  log: Pick<Logger, 'info'>,
): EmailTransport {
  const from = parseMailbox(config.email.from);
  if (!from) throw new Error(`EMAIL_FROM is not a valid sender: ${config.email.from}`);

  if (config.email.transport === 'log') {
    return {
      name: 'log',
      async send(message) {
        log.info(
          { email: { kind: message.kind, to: message.to, subject: message.subject } },
          `email (not sent, EMAIL_TRANSPORT=log):\n${message.text}`,
        );
        return {};
      },
    };
  }

  const smtp = nodemailer.createTransport(config.email.smtpUrl);
  return {
    name: 'smtp',
    async send(message) {
      const sender = senderOf(from, message);
      const info = await smtp.sendMail({
        from: sender.name ? { name: sender.name, address: sender.address } : sender.address,
        to: message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return { messageId: info.messageId };
    },
  };
}
