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
  /** Content review (design plan §6.5): whose content waits for review, and a word list. */
  moderation: {
    review: 'untrusted' | 'all' | 'off';
    blocklist: boolean;
    /**
     * The automatic check (decision 60): who it sends content to, what it checks, and whether
     * it removes content at once. Null when none is set up.
     */
    scanner: { name: string; images: boolean; text: boolean; removes: boolean } | null;
    /** Who compares images with lists of known child sexual abuse material; null: nobody. */
    csamMatcher: string | null;
  };
}

/** "images and public text", "images" or "public text": what the automatic check reads. */
function scanned(scanner: { images: boolean; text: boolean }): string {
  return [scanner.images && 'images', scanner.text && 'public text'].filter(Boolean).join(' and ');
}

const LAST_UPDATED = '21 October 2026';

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
            Recipients don’t need an account. If they create one, it shows only the badges awarded
            to email addresses they have confirmed are theirs.
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
          <strong>You don’t need an account.</strong> If you create one (or sign in) with the
          address a badge was sent to, <strong>My badges</strong> lists every badge awarded to that
          address on {facts.siteName}, by any organization, once the address is confirmed: by the
          link in our confirmation email
          {(p.google || p.microsoft) &&
            `, or because ${[p.google && 'Google', p.microsoft && 'Microsoft'].filter(Boolean).join(' or ')} confirms it when you sign in with them`}
          . An account whose address isn’t confirmed sees no badges. You can add other addresses you
          receive badges at; each one is confirmed through a link we email to it, opened while
          you’re signed in. From My badges you can open and download each badge, add it to LinkedIn,
          and hide or show its page; hidden badges stay visible to you. We don’t tell the
          organizations that awarded your badges that you have an account: when you hide or show a
          page, their records say that the recipient did, as they do when you use the claim link.
        </p>
        <p>
          If something on a badge is wrong, contact the organization that awarded it: they can
          correct it (by reissuing it) or revoke it.
        </p>
        <p>
          <strong>To have your data deleted</strong>, ask the organization that awarded the badge,
          or write to <Mail address={facts.privacyEmail} fallback="privacy contact address" /> and
          we’ll pass your request on (or, if the organization doesn’t answer, handle it ourselves).
          Erasing your data:
        </p>
        <ul>
          <li>
            covers every badge that organization awarded to your email address, and revokes them for
            good;
          </li>
          <li>
            removes your name, your email address and the signed badges from its records on{' '}
            {facts.siteName}: the badges, the emails we sent, the rows of any spreadsheet it
            uploaded, and the spreadsheets themselves;
          </li>
          <li>
            makes what its audit log says about you unreadable: the log keeps a record that a badge
            was awarded and erased, but no longer who it was for;
          </li>
          <li>
            replaces each badge’s page with a notice that the badge was removed. Any copy of a badge
            (a downloaded file or badge image) still checks as revoked.
          </li>
          <li>
            removes those badges from My badges. If you have an account, the account itself stays
            until you ask us to delete it.
          </li>
        </ul>
        <p>
          Erasing can’t reach copies outside {facts.siteName}: badges you downloaded or shared (for
          example on LinkedIn), emails already delivered, or records the organization exported. Our
          database backups keep a copy for up to 30 days before they are deleted; if we ever restore
          one, erasures made since are applied again.{' '}
          <ToFill>
            How quickly deletion requests are answered (for example, within one month).
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
            <strong>Other email addresses you add</strong> to see the badges sent to them, and when
            each was confirmed. They are never used to sign in, and we email them only their
            confirmation link. Adding, confirming and removing one is recorded with your account.
          </li>
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
            it, when, their IP address and browser. This log can’t be edited or deleted, so that
            badges stay accountable. What it says about a badge’s recipient (their name, email
            address, and their IP address and browser when they open or hide their badge) is
            encrypted with a key kept with that badge, and erasing the recipient’s data deletes the
            key.
          </li>
        </ul>
        <p>
          Issuer profiles and achievements are public on purpose: they say who awards a badge and
          what it means. Contact addresses you put on an issuer profile are public too.
        </p>
        <p>
          {facts.moderation.review === 'all'
            ? 'The people who run this site review the images and public text organizations upload before they are shown publicly. '
            : facts.moderation.review === 'untrusted'
              ? 'The people who run this site review the images and public text of organizations they haven’t marked as trusted before they are shown publicly. '
              : ''}
          {facts.moderation.blocklist
            ? 'Text that matches a list of words the people who run this site keep is held for them to review. '
            : ''}
          {facts.moderation.scanner &&
            `Before they are shown publicly, organizations’ ${scanned(facts.moderation.scanner)} ${facts.moderation.scanner.images && facts.moderation.scanner.text ? 'are' : 'is'} checked automatically by ${facts.moderation.scanner.name}, which rates how likely it is to be sexual, violent, hateful or otherwise against the terms; what it rates highly is held for review${facts.moderation.scanner.removes ? ', or removed at once' : ''}. `}
          They may hold or remove content that is reported or breaks the terms, and they see who
          uploaded it.
        </p>
        {facts.moderation.csamMatcher && (
          <p>
            Uploaded images are compared with lists of known child sexual abuse material by{' '}
            {facts.moderation.csamMatcher}. An image that matches is blocked at once and never
            shown, the organization is suspended and the account that uploaded it disabled, and the
            image and what we know about its upload (the account, the organization, when, from which
            IP address and browser) are kept encrypted as evidence. We report such material to the
            authorities where the law requires it.
          </p>
        )}
      </Section>

      <Section title="If you report a problem">
        <p>
          The “Report a problem” form on badge, achievement and issuer pages keeps the page you
          reported, what you chose and wrote, and your email address only if you give it (so the
          people who run this site can answer you). Your IP address is used in memory only, to limit
          how many reports one network can send, and isn’t stored with the report. Reports go to the
          people who run this site, never to the organization you report.
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
          Only the cookies the site needs: your session when you sign in (badge pages also use it to
          recognize you as a badge’s recipient), and a cookie that remembers a badge’s claim link on
          that badge’s page. No advertising or analytics cookies.
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
          {facts.moderation.scanner && (
            <li>
              <strong>{facts.moderation.scanner.name}</strong> checks the{' '}
              {scanned(facts.moderation.scanner)} organizations publish, before they are shown: we
              send it the content, never who uploaded it.
            </li>
          )}
          {facts.moderation.csamMatcher && (
            <li>
              <strong>{facts.moderation.csamMatcher}</strong> compares uploaded images with lists of
              known child sexual abuse material.
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
            can still be checked, unless the recipient’s data is erased. A revoked badge stays
            recorded as revoked.
          </li>
          <li>
            <strong>Spreadsheets</strong> uploaded to award many badges are deleted after 30 days.
          </li>
          <li>
            <strong>Claim links</strong> stop working after 90 days (the organization can send a new
            one). Invitations expire after 7 days. Links confirming an address you add stop working
            after 24 hours.
          </li>
          <li>
            <strong>Database backups</strong> are kept for 30 days. Restoring one applies again any
            erasure made after it was taken.
          </li>
          <li>
            <strong>Server logs</strong> (IP address and the page requested, with links’ secret
            parts removed) are kept for <ToFill>how long</ToFill>.
          </li>
          {facts.moderation.csamMatcher && (
            <li>
              <strong>Evidence of child sexual abuse material</strong> is kept encrypted for as long
              as the law requires (in the United States, at least a year after it is reported):{' '}
              <ToFill>how long, where this site operates</ToFill>.
            </li>
          )}
          <li>
            <strong>Accounts</strong>, and the addresses you added to them (until you remove them),
            are kept until you ask us to delete yours.{' '}
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
          revoke badges. Anyone can check a badge’s signature, status and dates. People who receive
          badges may create an account to see the badges awarded to the email addresses they have
          confirmed.
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
            Answer recipients’ requests about their data. To delete a recipient’s data, use “Erase
            this person’s data” on one of their badges; we may do it for you when a request reaches
            us and you don’t answer.
          </li>
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
          <li>
            Sexual or violent content, anything that sexualizes, exploits or endangers children, and
            hate, harassment or threats.
          </li>
          <li>Uploading malware or anything meant to harm the people who open it.</li>
          <li>
            Getting around rate limits, probing or attacking the service, or using it to attack
            others.
          </li>
        </ul>
        <p>
          Report misuse with “Report a problem” on any badge, achievement or issuer page, or to{' '}
          <Mail address={facts.abuseEmail} fallback="abuse contact address" />.
        </p>
      </Section>

      <Section title="Suspension and leaving">
        <p>
          We may hold an organization’s images and text for review before they are shown, remove
          them, unpublish achievements, disable accounts, and suspend an organization that breaks
          these terms.
          {facts.moderation.scanner &&
            ` Images and text may be checked automatically before they are shown${facts.moderation.scanner.removes ? ', and what the check rates as very likely to break these terms is removed at once' : ''}.`}
          {facts.moderation.csamMatcher &&
            ' An image that matches known child sexual abuse material is blocked at once and the organization suspended; we report it to the authorities where the law requires it.'}{' '}
          A suspended organization can’t award or email badges. Badges it awarded earlier stay
          checkable unless they are revoked, which we may do for badges that are fraudulent or
          abusive. We tell the organization’s owners what we did and why; to appeal, reply to that
          email.
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
