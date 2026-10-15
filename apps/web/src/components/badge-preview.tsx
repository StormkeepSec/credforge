import { achievementTypeLabel } from '@credforge/contracts';
import { Award } from 'lucide-react';

export interface BadgePreviewProps {
  imageUrl: string | null;
  name: string;
  achievementType: string;
  description: string;
  criteriaNarrative: string;
  criteriaUrl: string;
  tags: string[];
  issuerName: string;
  recipientName: string;
}

/**
 * How the recipient's badge page will look (design plan §11.1: a live preview while editing and
 * awarding). A smaller copy of the public credential page's layout, in the public pages' colors.
 */
export function BadgePreview(props: BadgePreviewProps) {
  const name = props.name.trim() || 'Achievement name';
  return (
    <figure className="overflow-hidden rounded-xl border bg-card">
      <figcaption className="border-b bg-muted px-4 py-2 text-xs font-semibold text-muted-foreground uppercase">
        Preview of the recipient’s page
      </figcaption>
      {/* The public pages are light-only, so the preview keeps their light colors in dark mode. */}
      <div className="grid gap-4 bg-[#fafafa] p-5 text-[#111827] sm:grid-cols-[7rem_1fr]">
        <div className="mx-auto size-28 sm:mx-0">
          {props.imageUrl ? (
            <img src={props.imageUrl} alt="" className="size-full object-contain" />
          ) : (
            <div className="flex size-full items-center justify-center rounded-2xl bg-[#111827]/5">
              <Award className="size-10 text-[#374151]" aria-hidden="true" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-bold tracking-[0.15em] text-[#2b7473] uppercase">
            {achievementTypeLabel(props.achievementType || 'Badge')}
          </p>
          <p className="mt-1 text-xl font-bold tracking-tight break-words">{name}</p>
          <p className="mt-2 text-sm text-[#374151]">
            Awarded to <strong className="text-[#111827]">{props.recipientName}</strong> by{' '}
            <span className="font-semibold text-[#2b7473] underline">
              {props.issuerName || 'your organization'}
            </span>
          </p>
          {props.description.trim() && (
            <p className="mt-3 text-sm whitespace-pre-line text-[#111827]">{props.description}</p>
          )}
          {(props.criteriaNarrative.trim() || props.criteriaUrl.trim()) && (
            <>
              <p className="mt-3 text-sm font-bold">How it is earned</p>
              {props.criteriaNarrative.trim() && (
                <p className="mt-1 text-sm whitespace-pre-line text-[#374151]">
                  {props.criteriaNarrative}
                </p>
              )}
              {props.criteriaUrl.trim() && (
                <p className="mt-1 text-sm break-all text-[#2b7473] underline">
                  {props.criteriaUrl}
                </p>
              )}
            </>
          )}
          {props.tags.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Skills">
              {props.tags.map((tag) => (
                <li
                  key={tag}
                  className="rounded-full border border-[#111827]/15 bg-white px-2.5 py-0.5 text-xs"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </figure>
  );
}
