const NOTICES = {
  achievement: {
    new: {
      title: 'Waiting for review',
      body: 'This achievement is new. Its details are shown once the people who run this credforge site have reviewed them.',
    },
    update: {
      title: 'An update is waiting for review',
      body: 'This page shows the achievement as it was last reviewed by the people who run this credforge site.',
    },
  },
  issuer: {
    new: {
      title: 'Waiting for review',
      body: 'This issuer’s profile is new. Its details are shown once the people who run this credforge site have reviewed them.',
    },
    update: {
      title: 'An update is waiting for review',
      body: 'This page shows the issuer’s profile as it was last reviewed by the people who run this credforge site.',
    },
  },
} as const;

/**
 * Public content that waits for review (design plan §6.5): what the page leaves out, or that it
 * shows the version cleared last. Neutral wording: waiting isn't a verdict.
 */
export function ReviewNotice({
  subject,
  state,
  className = 'mt-8',
}: {
  subject: keyof typeof NOTICES;
  state: 'new' | 'update';
  className?: string;
}) {
  const notice = NOTICES[subject][state];
  return (
    <div
      role="note"
      className={`${className} rounded-lg border border-ink/15 bg-white p-4 text-ink`}
    >
      <p className="font-semibold">{notice.title}</p>
      <p className="mt-1 text-sm text-ink-muted">{notice.body}</p>
    </div>
  );
}
