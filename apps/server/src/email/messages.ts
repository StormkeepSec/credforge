import { type OrgRole, ROLE_LABELS } from '@credforge/contracts';
import type { EmailMessage } from './transport';

/**
 * credforge's own account emails. Plain text first; the HTML version is the same words in a
 * minimal layout with inline styles (email clients ignore stylesheets). Every value that comes
 * from a user (names, org names, reasons) is escaped.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Section {
  /** Paragraphs of plain text. */
  paragraphs: string[];
  action?: { label: string; url: string };
  /** Small print under the button. */
  footnote?: string;
  /** An image above the paragraphs (the badge in award emails). */
  image?: { url: string; alt: string };
  /** Signs off the plain-text version (default "— credforge"). */
  signature?: string;
}

function render(kind: string, to: string, subject: string, section: Section): EmailMessage {
  const { paragraphs, image, action, footnote } = section;
  const text = [
    ...paragraphs,
    ...(action ? [`${action.label}: ${action.url}`] : []),
    ...(footnote ? [footnote] : []),
    section.signature ?? '— credforge',
  ].join('\n\n');

  const p = (content: string) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#111827">${content}</p>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#fafafa;font-family:'Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fafafa;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px">
<tr><td style="background:#111827;border-radius:8px 8px 0 0;padding:16px 24px;color:#fafafa;font-size:18px;font-weight:700">credforge</td></tr>
<tr><td style="padding:24px">
${
  image
    ? `<p style="margin:0 0 24px;text-align:center"><img src="${escapeHtml(image.url)}" width="160" height="160" alt="${escapeHtml(image.alt)}" style="display:inline-block;width:160px;height:160px;border:0"></p>`
    : ''
}
${paragraphs.map((paragraph) => p(escapeHtml(paragraph))).join('\n')}
${
  action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:6px">${escapeHtml(action.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#374151">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(action.url)}</span></p>`
    : ''
}
${footnote ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#374151">${escapeHtml(footnote)}</p>` : ''}
</td></tr></table></td></tr></table>
</body></html>`;

  return { kind, to, subject, text, html };
}

export function verifyEmailMessage(to: string, name: string, url: string): EmailMessage {
  return render('verify-email', to, 'Confirm your email address for credforge', {
    paragraphs: [
      `Hi ${name},`,
      'Confirm this email address to finish setting up your credforge account.',
    ],
    action: { label: 'Confirm email address', url },
    footnote:
      "The link works for 24 hours. If you didn't create a credforge account, you can ignore this email.",
  });
}

export function resetPasswordMessage(to: string, name: string, url: string): EmailMessage {
  return render('reset-password', to, 'Set a new credforge password', {
    paragraphs: [`Hi ${name},`, 'Someone asked to set a new password for your credforge account.'],
    action: { label: 'Set a new password', url },
    footnote:
      "The link works for one hour. If you didn't ask for this, ignore this email: your password stays the same.",
  });
}

export function existingAccountMessage(to: string, name: string, signInUrl: string): EmailMessage {
  return render('existing-account', to, 'You already have a credforge account', {
    paragraphs: [
      `Hi ${name},`,
      'Someone tried to create a credforge account with this email address, but you already have one.',
      'If it was you, sign in instead. You can set a new password from the sign-in page if you need to.',
    ],
    action: { label: 'Sign in', url: signInUrl },
    footnote: "If it wasn't you, you can ignore this email.",
  });
}

export function invitationMessage(input: {
  to: string;
  orgName: string;
  inviterName: string | null;
  role: OrgRole;
  url: string;
  expiresAt: Date;
}): EmailMessage {
  const who = input.inviterName ? `${input.inviterName} invited you` : 'You have been invited';
  return render('invitation', input.to, `Join ${input.orgName} on credforge`, {
    paragraphs: [
      `${who} to join ${input.orgName} on credforge as ${articleFor(ROLE_LABELS[input.role])}.`,
      'credforge is where the organization creates and awards Open Badges.',
    ],
    action: { label: 'Accept the invitation', url: input.url },
    footnote: `The invitation is for ${input.to} and expires on ${formatDate(input.expiresAt)}. Sign in or create an account with this address to accept it.`,
  });
}

export function orgSubmittedMessage(input: {
  to: string;
  orgName: string;
  requesterName: string;
  requesterEmail: string;
  url: string;
}): EmailMessage {
  return render('org-submitted', input.to, `Waiting for approval: ${input.orgName}`, {
    paragraphs: [
      `${input.requesterName} (${input.requesterEmail}) created the organization ${input.orgName}. It is waiting for a platform admin to approve it.`,
    ],
    action: { label: 'Review pending organizations', url: input.url },
  });
}

export function orgApprovedMessage(to: string, orgName: string, url: string): EmailMessage {
  return render('org-approved', to, `${orgName} is approved on credforge`, {
    paragraphs: [
      `Good news: ${orgName} is approved.`,
      'You can now award badges to anyone, not just members of your organization.',
    ],
    action: { label: 'Open credforge', url },
  });
}

export function orgDeclinedMessage(
  to: string,
  orgName: string,
  reason: string | null,
): EmailMessage {
  return render('org-declined', to, `${orgName} wasn't approved on credforge`, {
    paragraphs: [
      `${orgName} wasn't approved, so it can't award badges on this credforge instance.`,
      ...(reason ? [`Reason: ${reason}`] : []),
      'If you think this is a mistake, reply to the person who runs this instance.',
    ],
  });
}

export function orgSuspendedMessage(
  to: string,
  orgName: string,
  reason: string | null,
): EmailMessage {
  return render('org-suspended', to, `${orgName} is suspended on credforge`, {
    paragraphs: [
      `${orgName} is suspended. It can't award badges or send email until it is reinstated. Badges it already awarded stay verifiable.`,
      ...(reason ? [`Reason: ${reason}`] : []),
    ],
  });
}

export interface AwardMessageInput {
  to: string;
  recipientName: string;
  issuerName: string;
  /** The issuer's public contact address, used as Reply-To. */
  issuerEmail: string | null;
  achievementName: string;
  achievementDescription: string;
  /** 512 px badge image. */
  imageUrl: string | null;
  claimUrl: string;
  claimExpiresAt: Date;
  /** EMAIL_FROM's display name, e.g. "credforge". */
  serviceName: string;
  /** The `email_message` row this send updates. */
  trackingId?: string;
  /** Wording for a link sent again. */
  resend?: boolean;
  /** Wording for a corrected copy that replaces an earlier badge (reissue, design plan §8.6). */
  reissue?: boolean;
}

/**
 * The award email (design plan §8.4). It comes from credforge's address with the display name
 * "{issuer} via credforge", and replies go to the issuer (§6.3). The claim link carries the
 * recipient's token, so the email says to share the badge page's address instead.
 */
export function awardMessage(input: AwardMessageInput): EmailMessage {
  const subject = input.reissue
    ? `${input.issuerName} corrected your ${input.achievementName} badge`
    : `${input.issuerName} awarded you ${input.achievementName}`;
  const message = render('award', input.to, subject, {
    image: input.imageUrl
      ? { url: input.imageUrl, alt: `${input.achievementName} badge` }
      : undefined,
    paragraphs: [
      `Hi ${input.recipientName},`,
      input.reissue
        ? `${input.issuerName} sent you a corrected copy of your ${input.achievementName} badge. It replaces the earlier one, which now shows as replaced.`
        : `${input.issuerName} awarded you ${input.achievementName}.`,
      input.achievementDescription,
      'Open your badge to see it, download it, add it to LinkedIn or share it.',
    ],
    action: { label: 'View your badge', url: input.claimUrl },
    footnote:
      `${input.resend ? 'This is a new link; earlier ones no longer work. ' : ''}This link is just for you and works until ${formatDate(input.claimExpiresAt)}: it lets you download your badge and choose whether its page is public. To share your badge, use the address of its page instead. ` +
      (input.issuerEmail
        ? `Questions about this badge? Reply to this email to reach ${input.issuerName}.`
        : `Questions about this badge? Contact ${input.issuerName}.`),
    signature: `— Sent by ${input.serviceName} for ${input.issuerName}`,
  });
  return {
    ...message,
    fromName: `${input.issuerName} via ${input.serviceName}`,
    ...(input.issuerEmail && { replyTo: input.issuerEmail }),
    ...(input.trackingId && { trackingId: input.trackingId }),
  };
}

function articleFor(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word.toLowerCase()}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
