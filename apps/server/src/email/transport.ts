import nodemailer from 'nodemailer';
import type { Logger } from 'pino';
import type { Config } from '../config';

/** A rendered email, ready to send. */
export interface EmailMessage {
  /** Template name, for logs and (M3) delivery tracking, e.g. `verify-email`. */
  kind: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<{ messageId?: string }>;
}

/**
 * Builds the transport named by EMAIL_TRANSPORT. `smtp` sends through any SMTP server (Mailpit
 * in development); `log` prints messages to the log instead of sending them, for development
 * only, since it prints the links in them. SendGrid's HTTPS API arrives in M3.
 */
export function createEmailTransport(
  config: Pick<Config, 'email'>,
  log: Pick<Logger, 'info'>,
): EmailTransport {
  const { from } = config.email;
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
      const info = await smtp.sendMail({
        from,
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
