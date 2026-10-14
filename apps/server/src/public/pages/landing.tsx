import { BrandMark } from '../components/brand-mark';
import { SitePage } from '../components/site-chrome';
import { Document } from '../document';

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

interface LandingPageProps {
  url: string;
  stylesheet: string;
}

// Copy comes from branding/credforge-copy-kit.md. Keep claims within its language guardrails.
export function LandingPage({ url, stylesheet }: LandingPageProps) {
  return (
    <Document
      title="credforge · Make achievement mean more."
      description="Create and award Open Badges 3.0 digital badges that make progress visible and recognition meaningful."
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
            <div className="mt-10">
              <a
                href="/signup"
                className="inline-flex items-center rounded-full bg-ink px-7 py-3.5 font-semibold tracking-wide text-canvas hover:bg-ink-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal-strong"
              >
                Create your first badge
              </a>
            </div>
            <p className="mt-6 text-sm tracking-wide text-ink-muted">
              For programs built on meaningful achievement.
            </p>
          </div>
          <div className="mx-auto w-full max-w-sm rounded-3xl bg-ink p-6" aria-hidden="true">
            <div className="flex aspect-square flex-col items-center justify-center gap-6 rounded-2xl bg-canvas/5">
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
      </SitePage>
    </Document>
  );
}
