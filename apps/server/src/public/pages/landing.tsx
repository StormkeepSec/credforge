import type { SignupMode } from '@credforge/contracts';
import { BrandMark } from '../components/brand-mark';
import { SitePage } from '../components/site-chrome';
import { Document } from '../document';

// Copy comes from branding/credforge-copy-kit.md and the brand guide (Messaging, Website
// application). Keep every claim within the kit's language guardrails and true of the product:
// say "create and award", never "certified", "analytics", "integrations" or "guaranteed".

const ways = [
  {
    label: 'Create',
    title: 'Give the milestone a clear shape.',
    body: 'Design badges around the achievement they represent.',
    accent: 'bg-signal',
  },
  {
    label: 'Award',
    title: 'Recognize what was earned.',
    body: 'Turn accomplishment into a meaningful award.',
    accent: 'bg-signal',
  },
  {
    label: 'Explain',
    title: 'Let the story travel.',
    body: 'Use the Open Badges 3.0 standard to add context.',
    accent: 'bg-spark',
  },
];

const whyBadges = [
  {
    title: 'Give achievement a clear shape',
    body: 'Turn a skill, milestone, or accomplishment into a badge people can recognize. Start with what was earned and make its meaning clear.',
  },
  {
    title: 'Award with purpose',
    body: 'Recognition lands differently when it reflects real work. Use credforge to create and award digital badges for moments that matter to your program and its people.',
  },
  {
    title: 'Build on an open standard',
    body: 'Open Badges 3.0 provides a standards-based way to describe an achievement, its issuer, recipient, criteria, and possible evidence. credforge is built for creating and awarding badges in that format.',
  },
];

/** The brand idea's three steps, each tied to what the product does today. */
const story = [
  {
    step: '01',
    title: 'Earned',
    lead: 'Start with a real milestone.',
    body: 'Describe the achievement, how it is earned and the skills it shows. Award it to one person, or to many from a CSV file.',
  },
  {
    step: '02',
    title: 'Explained',
    lead: 'Show what the badge represents.',
    body: 'Each badge has its own page with the criteria, skills and evidence behind it, and the organization that awarded it.',
  },
  {
    step: '03',
    title: 'Carried',
    lead: 'Make recognition easier to share.',
    body: 'Recipients get a link to their badge page, the badge image with the credential inside it, and a printable certificate. They can add it to LinkedIn or hide the page.',
  },
];

const cta =
  'inline-flex items-center rounded-full px-7 py-3.5 font-semibold tracking-wide focus-visible:outline-2 focus-visible:outline-offset-4';

/** The brand's angled lines, used sparingly behind dark panels. */
function AngledLines({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 240 240"
      className={className}
      aria-hidden="true"
      focusable="false"
      fill="none"
    >
      {Array.from({ length: 10 }, (_, i) => (
        <line
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed decoration
          key={i}
          x1={i * 24 - 120}
          y1={0}
          x2={i * 24 + 120}
          y2={240}
          stroke="#379392"
          strokeOpacity="0.35"
          strokeWidth="1.5"
        />
      ))}
    </svg>
  );
}

interface LandingPageProps {
  url: string;
  stylesheet: string;
  signupMode: SignupMode;
  requireMfaForAdmins: boolean;
}

export function LandingPage({
  url,
  stylesheet,
  signupMode,
  requireMfaForAdmins,
}: LandingPageProps) {
  return (
    <Document
      title="credforge · Make achievement mean more."
      description="credforge helps organizations create and award Open Badges 3.0 digital badges that make skills, milestones, and accomplishments easier to recognize."
      url={url}
      stylesheet={stylesheet}
    >
      <SitePage>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 md:grid-cols-[3fr_2fr] md:py-24">
          <div>
            <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              Achievement deserves more than a moment.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-muted">
              Create and award Open Badges 3.0 digital badges that make progress visible and
              recognition meaningful.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-4">
              <a
                href="/signup"
                className={`${cta} bg-ink text-canvas hover:bg-ink-muted focus-visible:outline-signal-strong`}
              >
                Create your first badge
              </a>
              <a
                href="#why-badges"
                className={`${cta} border border-ink/20 text-ink hover:border-ink focus-visible:outline-signal-strong`}
              >
                Explore digital badges
              </a>
            </div>
            <p className="mt-6 text-sm tracking-wide text-ink-muted">
              For programs built on meaningful achievement.
            </p>
          </div>
          <div
            className="relative mx-auto w-full max-w-sm overflow-hidden rounded-3xl bg-ink p-6"
            aria-hidden="true"
          >
            <AngledLines className="absolute -top-10 -right-10 size-60" />
            <div className="relative flex aspect-square flex-col items-center justify-center gap-6 rounded-2xl bg-canvas/5">
              <BrandMark variant="reverse" className="w-1/2" />
              <span className="text-xs font-bold tracking-[0.2em] text-canvas">ACHIEVEMENT</span>
            </div>
          </div>
        </section>

        <section aria-labelledby="ways-heading" className="border-t border-ink/10 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 id="ways-heading" className="text-3xl font-bold tracking-tight">
              Make achievement mean more.
            </h2>
            <ul className="mt-10 grid gap-6 md:grid-cols-3">
              {ways.map((way) => (
                <li key={way.label} className="rounded-2xl border border-ink/10 bg-white p-6">
                  <span className={`block h-1.5 w-12 rounded-full ${way.accent}`} />
                  <p className="mt-6 text-xs font-bold tracking-[0.15em] text-ink-muted uppercase">
                    {way.label}
                  </p>
                  <h3 className="mt-3 text-xl font-bold">{way.title}</h3>
                  <p className="mt-2 text-ink-muted">{way.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="why-badges" aria-labelledby="why-heading" className="border-t border-ink/10">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <p className="text-sm font-bold tracking-[0.15em] text-signal-strong uppercase">
              Why badges
            </p>
            <h2 id="why-heading" className="mt-3 text-3xl font-bold tracking-tight text-balance">
              Every badge should tell an earned story.
            </h2>
            <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink-muted">
              credforge gives organizations a purposeful way to recognize skills, progress, and
              achievement, and helps each award carry more meaning than a graphic alone.
            </p>
            <div className="mt-12 grid gap-10 md:grid-cols-3">
              {whyBadges.map((item) => (
                <div key={item.title}>
                  <h3 className="text-xl font-bold">{item.title}</h3>
                  <p className="mt-3 leading-relaxed text-ink-muted">{item.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="story-heading" className="border-t border-ink/10 bg-white">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 id="story-heading" className="text-3xl font-bold tracking-tight">
              From the work to the badge
            </h2>
            <ol className="mt-10 grid gap-8 border-t border-ink/10 pt-10 md:grid-cols-3">
              {story.map((item) => (
                <li key={item.step} className="grid grid-cols-[auto_1fr] gap-x-4">
                  <span className="text-sm font-bold text-spark-strong">{item.step}</span>
                  <div>
                    <h3 className="text-xl font-bold">{item.title}</h3>
                    <p className="mt-1 font-semibold">{item.lead}</p>
                    <p className="mt-2 leading-relaxed text-ink-muted">{item.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="standard-heading" className="border-t border-ink/10">
          <div className="mx-auto grid max-w-6xl gap-12 px-4 py-16 sm:px-6 md:grid-cols-2">
            <div>
              <h2 id="standard-heading" className="text-3xl font-bold tracking-tight">
                A credential anyone can check
              </h2>
              <p className="mt-4 leading-relaxed text-ink-muted">
                Each badge is a signed Open Badges 3.0 credential. Its page shows who awarded it, to
                whom, what was earned and when. Anyone can check its signature, whether it was
                revoked, and its dates, on the badge’s page or with the verification tool.
              </p>
              <p className="mt-4 leading-relaxed text-ink-muted">
                Recipients don’t need an account. Their email address appears in the credential only
                as a salted hash.
              </p>
              <a
                href="/verify"
                className="mt-6 inline-flex font-semibold text-signal-strong underline underline-offset-4 hover:text-ink"
              >
                Verify a badge
              </a>
            </div>
            <div>
              <h2 className="text-3xl font-bold tracking-tight">For the organizations behind it</h2>
              <ul className="mt-4 grid gap-3 leading-relaxed text-ink-muted">
                {signupMode === 'approval' && (
                  <li>
                    New organizations are reviewed before they can award badges to people outside
                    their own team.
                  </li>
                )}
                <li>
                  Issuers can verify their website’s domain; badge pages say “self-reported” until
                  they do.
                </li>
                {requireMfaForAdmins && (
                  <li>Owners and admins sign in with two-step verification.</li>
                )}
                <li>Every change is kept in an audit log that can’t be edited.</li>
                <li>
                  A documented{' '}
                  <a
                    href="/api/docs"
                    className="font-semibold text-signal-strong underline underline-offset-4 hover:text-ink"
                  >
                    REST API
                  </a>{' '}
                  with keys you control.
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section aria-labelledby="closing-heading" className="relative overflow-hidden bg-ink">
          <AngledLines className="absolute -top-16 right-0 size-72" />
          <div className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2
              id="closing-heading"
              className="text-3xl font-bold tracking-tight text-balance text-canvas sm:text-4xl"
            >
              Give progress <span className="text-spark">a mark of meaning.</span>
            </h2>
            <p className="mt-4 max-w-2xl text-lg leading-relaxed text-canvas/85">
              credforge is a platform for creating and awarding Open Badges 3.0 digital badges.
              Because the story behind an achievement matters as much as the moment it is awarded.
            </p>
            <a
              href="/signup"
              className={`${cta} mt-8 bg-canvas text-ink hover:bg-white focus-visible:outline-spark`}
            >
              Create your first badge
            </a>
          </div>
        </section>
      </SitePage>
    </Document>
  );
}
