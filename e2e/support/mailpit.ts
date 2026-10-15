import { MAILPIT_URL } from './stack';

interface MessageSummary {
  ID: string;
  Created: string;
}

/** Link patterns in the emails credforge sends. */
export const LINKS = {
  verifyEmail: '/api/auth/verify-email?token=',
  resetPassword: '/reset-password?token=',
  invitation: '/invite/',
} as const;

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${MAILPIT_URL}/api/v1${path}`);
  if (!response.ok) throw new Error(`Mailpit ${path}: ${response.status}`);
  return (await response.json()) as T;
}

/**
 * The newest link containing `pattern` in an email to `to`. Email goes out through the worker's
 * queue, so this waits for it to arrive.
 */
export async function mailLink(to: string, pattern: string, timeout = 20_000): Promise<string> {
  const query = encodeURIComponent(`to:"${to}"`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { messages } = await getJson<{ messages: MessageSummary[] }>(
      `/search?query=${query}&limit=20`,
    );
    const newestFirst = [...messages].sort((a, b) => b.Created.localeCompare(a.Created));
    for (const summary of newestFirst) {
      const message = await getJson<{ Text: string }>(`/message/${summary.ID}`);
      const link = message.Text.match(/https?:\/\/[^\s<>"]+/g)?.find((url) =>
        url.includes(pattern),
      );
      if (link) return link.replace(/[).,]+$/, '');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No email to ${to} with a link containing ${pattern} arrived in Mailpit.`);
}
