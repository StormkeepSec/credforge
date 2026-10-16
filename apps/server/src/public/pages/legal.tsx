import type { ReactNode } from 'react';
import { SitePage } from '../components/site-chrome';
import { Document } from '../document';

/**
 * The privacy policy and terms of service (design plan §12, decision 36). They are drafted in
 * plain language from what credforge actually stores and does, and stay marked as drafts
 * (LEGAL_PAGES_DRAFT) until the operator has reviewed them, ideally with legal advice. Facts that
 * depend on the instance (its address, who runs it, the email and storage providers, sign-in
 * methods) come from its configuration; anything only the operator can supply is marked.
 */
export interface LegalFacts {
  /** e.g. `credforge.app`. */
  siteName: string;
  publicBaseUrl: string;
  operatorName: string | undefined;
  privacyEmail: string | undefined;
  abuseEmail: string | undefined;
  securityEmail: string | undefined;
  draft: boolean;
  signupMode: 'approval' | 'open' | 'invite';
  requireMfaForAdmins: boolean;
  /** Who processes data for the instance, from its configuration. */
  providers: {
    email: 'sendgrid' | 'smtp' | 'log';
    /** `digitalocean` when files are on DigitalOcean Spaces. */
    storage: 'digitalocean' | 's3' | 'local';
    storageRegion: string | null;
    google: boolean;
    microsoft: boolean;
  };
}

const LAST_UPDATED = '15 October 2026';

const link = 'font-semibold text-signal-strong underline underline-offset-4 hover:text-ink';

/** Something only the operator can fill in, shown highlighted until it is. */
function ToFill({ children }: { children: ReactNode }) {
  return <mark className="rounded bg-warning/15 px-1 text-ink">[{children}]</mark>;
}

function Mail({ address, fallback }: { address: string | undefined; fallback: string }) {
  return address ? (
    <a href={`mailto:${address}`} className={link}>
      {address}
    </a>
  ) : (
    <ToFill>{fallback}</ToFill>
  );
}

function Operator({ facts }: { facts: LegalFacts }) {
  if (facts.operatorName) return facts.operatorName;
  return <ToFill>name and postal address of whoever runs {facts.siteName}</ToFill>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return (
    <section aria-labelledby={id} className="mt-10">
      <h2 id={id} className="text-2xl font-bold tracking-tight">
        {title}
      </h2>
      <div className="mt-4 grid gap-4 leading-relaxed text-ink-muted [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-ink [&_ul]:grid [&_ul]:gap-2">
        {children}
      </div>
    </section>
  );
}

function LegalLayout({
  url,
  stylesheet,
  title,
  description,
  facts,
  children,
}: {
  url: string;
  stylesheet: string;
  title: string;
  description: string;
  facts: LegalFacts;
  children: ReactNode;
}) {
  return (
    <Document
      title={`${title} · ${facts.siteName}`}
      description={description}
      url={url}
      stylesheet={stylesheet}
    >
      <SitePage>
        <article className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
          <h1 className="text-4xl font-bold tracking-tight">{title}</h1>
          <p className="mt-3 text-sm text-ink-muted">
            {facts.draft ? `Draft of ${LAST_UPDATED}` : `Last updated ${LAST_UPDATED}`}
          </p>
          {facts.draft && (
            <div
              role="note"
              className="mt-8 rounded-lg border border-warning/40 bg-warning/5 p-4 text-ink"
            >
              <p className="font-semibold">Draft for review: not in effect yet</p>
              <p className="mt-1 text-sm text-ink-muted">
                This text describes what credforge stores and does, and is waiting for review by the
                people who run this site. Highlighted parts still need to be filled in.
              </p>
            </div>
          )}
          {children}
        </article>
      </SitePage>
    </Document>
  );
}

export function PrivacyPage({
  url,
  stylesheet,
  facts,
}: {
  url: string;
  stylesheet: string;
  facts: LegalFacts;
}) {
  const p = facts.providers;
  const region = p.storageRegion ? ` (region ${p.storageRegion})` : '';
  return (
    <LegalLayout
      url={url}
      stylesheet={stylesheet}
      title="Privacy policy"
      description={`What ${facts.siteName} stores about you, why, and for how long.`}
      facts={facts}
    >
      <Section title="In short">
        <ul>
          <li>
            Organizations use {facts.siteName} to create and award digital badges. We store what
            that needs: accounts for the people who award badges, and each recipient’s name and
            email address.
          </li>
          <li>
            A badge’s public page shows the recipient’s name, never their email address. In the
            signed badge, the email address is only a salted hash.
          </li>
          <li>
            No advertising, no analytics, no tracking pixels. Emails are sent with click and open
            tracking turned off.
          </li>
          <li>We don’t sell personal data or share it beyond the providers listed below.</li>
        </ul>
      </Section>

      <Section title="Who is responsible">
        <p>
          {facts.siteName} ({facts.publicBaseUrl}) is run by <Operator facts={facts} />. Questions
          and requests about your data:{' '}
          <Mail address={facts.privacyEmail} fallback="privacy contact address" />.
        </p>
        <p>
          For accounts on {facts.siteName}, we decide how the data is used. For badges, the
          organization that awards a badge decides who receives it and what it says; we store and
          send it on their behalf.{' '}
          <ToFill>Confirm these roles (controller and processor) with legal advice.</ToFill>
        </p>
      </Section>

      <Section title="If you receive a badge">
        <p>The organization that awarded you a badge gave us:</p>
        <ul>
          <li>
            <strong>Your name</strong>, which appears on the badge, its public page and its
            printable certificate.
          </li>
          <li>
            <strong>Your email address</strong>, to send you the badge and for the organization’s
            records. The signed badge contains it only as a salted hash, so it can be checked
            against an address someone already knows but can’t be read from the badge.
          </li>
          <li>
            Anything else the organization added: the date, an expiry date, evidence links, and
            extra columns from a spreadsheet upload. Extra columns are never public.
          </li>
        </ul>
        <p>
          We also record whether the award email was delivered or bounced, and when you first opened
          your claim link. Your claim link works for 90 days and lets you add the badge to LinkedIn
          or hide its public page. A hidden page can’t be seen by anyone else. Badge pages ask
          search engines not to index them.
        </p>
        <p>
          If something on a badge is wrong, or you want it removed, contact the organization that
          awarded it first: they can correct it (by reissuing it) or revoke it. You can also contact
          us.{' '}
          <ToFill>
            Decide how deletion requests are handled: credforge has no self-service deletion of a
            recipient’s data yet.
          </ToFill>
        </p>
      </Section>

      <Section title="If you have an account">
        <ul>
          <li>
            <strong>Account details:</strong> your name, email address and a hash of your password
            (we never store the password itself).
          </li>
          {(p.google || p.microsoft) && (
            <li>
              <strong>
                Signing in with{' '}
                {[p.google && 'Google', p.microsoft && 'Microsoft'].filter(Boolean).join(' or ')}:
              </strong>{' '}
              we receive your name, email address and an account identifier. We don’t keep the
              provider’s access tokens, so we can’t act on your account there.
            </li>
          )}
          <li>
            <strong>Two-step verification:</strong> your authenticator secret (encrypted) and backup
            codes.
          </li>
          <li>
            <strong>Sessions:</strong> the IP address and browser of each signed-in session, until
            it expires.
          </li>
          <li>
            <strong>Your organization’s data:</strong> its members and their roles, invitations,
            issuer profile, achievements, the badges it awarded and its API keys (stored only as a
            hash).
          </li>
          <li>
            <strong>Audit log:</strong> every change in an organization is recorded with who made
            it, when, their IP address and browser. Awards are recorded with the recipient’s name
            and email address. This log can’t be edited or deleted, so that badges stay accountable.
          </li>
        </ul>
        <p>
          Issuer profiles and achievements are public on purpose: they say who awards a badge and
          what it means. Contact addresses you put on an issuer profile are public too.
        </p>
      </Section>

      <Section title="If you check a badge">
        <p>
          The verification tool doesn’t store or log the badge, link or email address you check.
          Your IP address is used, in memory only, to limit how many checks one network can make.
        </p>
      </Section>

      <Section title="Cookies">
        <p>
          Only the cookies the site needs: your session when you sign in, and a cookie that
          remembers a badge’s claim link on that badge’s page. No advertising or analytics cookies.
        </p>
      </Section>

      <Section title="Who processes data for us">
        <ul>
          {p.storage === 'digitalocean' ? (
            <li>
              <strong>DigitalOcean</strong> hosts our servers, database and files{region}.
            </li>
          ) : (
            <li>
              <ToFill>Hosting provider and region</ToFill> hosts our servers and database
              {p.storage === 's3' && ', and an S3-compatible service stores uploaded files'}.
            </li>
          )}
          {p.email === 'sendgrid' && (
            <li>
              <strong>Twilio SendGrid</strong> delivers our emails (award, confirmation, invitation
              and password emails) and tells us whether they arrived.
            </li>
          )}
          {p.email === 'smtp' && (
            <li>
              <ToFill>Email provider</ToFill> delivers our emails.
            </li>
          )}
          {p.google && (
            <li>
              <strong>Google</strong>, when you choose to sign in with Google.
            </li>
          )}
          {p.microsoft && (
            <li>
              <strong>Microsoft</strong>, when you choose to sign in with Microsoft.
            </li>
          )}
        </ul>
        <p>
          <ToFill>
            Where the data is stored and any international transfers, with their legal basis.
          </ToFill>
        </p>
      </Section>

      <Section title="How long we keep it">
        <ul>
          <li>
            <strong>Badges</strong> are kept as long as the organization that awarded them, so they
            can still be checked. A revoked badge stays recorded as revoked.
          </li>
          <li>
            <strong>Spreadsheets</strong> uploaded to award many badges are deleted after 30 days.
          </li>
          <li>
            <strong>Claim links</strong> stop working after 90 days (the organization can send a new
            one). Invitations expire after 7 days.
          </li>
          <li>
            <strong>Database backups</strong> are kept for 30 days.
          </li>
          <li>
            <strong>Server logs</strong> (IP address and the page requested, with links’ secret
            parts removed) are kept for <ToFill>how long</ToFill>.
          </li>
          <li>
            <strong>Accounts</strong> are kept until you ask us to delete yours.{' '}
            <ToFill>Decide how long the audit log is kept.</ToFill>
          </li>
        </ul>
      </Section>

      <Section title="Security">
        <p>
          Everything is sent over HTTPS. Passwords are hashed, the keys that sign badges are
          encrypted and files are stored privately.
          {facts.requireMfaForAdmins && ' Owners and admins must use two-step verification.'}{' '}
          {facts.securityEmail && (
            <>
              Please report security problems to{' '}
              <Mail address={facts.securityEmail} fallback="security contact address" />.
            </>
          )}
        </p>
      </Section>

      <Section title="Your rights">
        <p>
          You can ask for a copy of your data, ask us to correct or delete it, or object to how we
          use it: write to <Mail address={facts.privacyEmail} fallback="privacy contact address" />.
          For a badge, we may pass your request to the organization that awarded it. You may also
          complain to your data protection authority.{' '}
          <ToFill>Rights and authorities that apply where the operator and users are.</ToFill>
        </p>
      </Section>

      <Section title="Children">
        <p>
          <ToFill>
            Whether badges may be awarded to children, and the age limit for accounts.
          </ToFill>
        </p>
      </Section>

      <Section title="Changes">
        <p>
          We’ll post changes on this page with a new date, and tell account holders by email about
          important ones.
        </p>
      </Section>
    </LegalLayout>
  );
}

export function TermsPage({
  url,
  stylesheet,
  facts,
}: {
  url: string;
  stylesheet: string;
  facts: LegalFacts;
}) {
  return (
    <LegalLayout
      url={url}
      stylesheet={stylesheet}
      title="Terms of service"
      description={`The rules for using ${facts.siteName} to create and award badges.`}
      facts={facts}
    >
      <Section title="The agreement">
        <p>
          These terms are between you and <Operator facts={facts} />, who run {facts.siteName}. By
          creating an account you accept them, for yourself and for any organization you set up or
          join. If you use {facts.siteName} for an organization, you confirm you may act for it.
        </p>
      </Section>

      <Section title="What the service does">
        <p>
          {facts.siteName} lets organizations create achievements and award them as signed Open
          Badges 3.0 credentials, email recipients their badges, publish a page for each badge, and
          revoke badges. Anyone can check a badge’s signature, status and dates.
        </p>
        <p>
          A badge says that the organization awarded it. {facts.siteName} doesn’t check whether the
          achievement happened. “Website verified” on an issuer’s page means only that the issuer
          proved control of that website’s domain; otherwise the website is self-reported.
        </p>
      </Section>

      <Section title="Accounts and organizations">
        <ul>
          <li>Give accurate information and keep your password and API keys secret.</li>
          <li>
            {facts.requireMfaForAdmins && 'Owners and admins must use two-step verification. '}
            You are responsible for what happens under your account and your organization’s API
            keys.
          </li>
          {facts.signupMode === 'approval' && (
            <li>
              New organizations are reviewed. Until one is approved it can only award badges to its
              own members. We may decline an organization without giving a reason.
            </li>
          )}
          <li>
            Each organization can send a limited number of award emails a day. We may change the
            limit.
          </li>
        </ul>
      </Section>

      <Section title="Your responsibilities as an issuer">
        <ul>
          <li>
            Award badges only for achievements that are real, under your own organization’s name.
          </li>
          <li>
            Have the right to give us recipients’ names and email addresses and to email them their
            badges, under the laws that apply to you.
          </li>
          <li>Correct or revoke a badge when it turns out to be wrong.</li>
          <li>
            You keep the rights to your content (names, descriptions, images). You let us store,
            sign, publish and send it to run the service, including after you leave, so that badges
            you awarded can still be checked.
          </li>
        </ul>
      </Section>

      <Section title="Not allowed">
        <ul>
          <li>Pretending to be another organization or person.</li>
          <li>Phishing, spam, or emails people didn’t expect from you.</li>
          <li>Badges for things that didn’t happen, or content that is unlawful or abusive.</li>
          <li>Uploading malware or anything meant to harm the people who open it.</li>
          <li>
            Getting around rate limits, probing or attacking the service, or using it to attack
            others.
          </li>
        </ul>
        <p>
          Report misuse to <Mail address={facts.abuseEmail} fallback="abuse contact address" />, or
          with “Report a problem” on any badge or issuer page.
        </p>
      </Section>

      <Section title="Suspension and leaving">
        <p>
          We may suspend an organization that breaks these terms. A suspended organization can’t
          award or email badges. Badges it awarded earlier stay checkable unless they are revoked,
          which we may do for badges that are fraudulent or abusive.
        </p>
        <p>
          You may stop using the service at any time.{' '}
          <ToFill>
            What happens to an organization’s data when it leaves, and how to ask for an account to
            be deleted.
          </ToFill>
        </p>
      </Section>

      <Section title="Fees">
        <p>
          <ToFill>Whether the service is free, and how prices would be introduced.</ToFill>
        </p>
      </Section>

      <Section title="No warranty, limited liability">
        <p>
          We work to keep {facts.siteName} available and badges checkable, but the service is
          provided as it is, without guarantees.{' '}
          <ToFill>Limitation of liability and indemnity wording, with legal advice.</ToFill>
        </p>
      </Section>

      <Section title="Open source">
        <p>
          credforge’s source code is available under the Apache-2.0 license. That license covers the
          code, not the content organizations put on {facts.siteName}.
        </p>
      </Section>

      <Section title="Changes and law">
        <p>
          We’ll post changes on this page and tell account holders by email about important ones.
          Using the service after a change means you accept it.{' '}
          <ToFill>Governing law and where disputes are decided.</ToFill>
        </p>
      </Section>
    </LegalLayout>
  );
}
