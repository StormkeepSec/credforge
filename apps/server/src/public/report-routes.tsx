import { emailField, REPORT_CATEGORIES, type ReportCategory } from '@credforge/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isUuid } from '../api/errors';
import { createRateLimiter } from '../api/rate-limit';
import { isSameOrigin } from '../api/v1';
import {
  checkReportFormToken,
  createReport,
  REPORT_DETAILS_MAX,
  type ReportTarget,
  type ReportTargetType,
  reportFormToken,
  reportTarget,
} from '../moderation/reports';
import type { Services } from '../services';
import type { PublicAssets } from './assets';
import type { ReportField } from './components/report-form';
import { renderDocument } from './document';
import { ReportPage } from './pages/report';

const TARGET_TYPES: readonly ReportTargetType[] = ['credential', 'achievement', 'issuer'];
const HOUR = 60 * 60 * 1000;
/** Report emails to the platform admins per hour, beyond child-safety ones (those always go). */
const REPORT_MAILS_PER_HOUR = 30;

/** The form's action for a page: `/report/{type}/{id}`. */
export function reportPath(type: ReportTargetType, id: string): string {
  return `/report/${type}/${id}`;
}

type FormBody = Partial<Record<'category' | 'details' | 'email' | 'token' | 'website', string>>;

/**
 * `/report/{type}/{id}`: the "Report a problem" form of a public badge, achievement or issuer page
 * (design plan §6.5). `GET` shows it on its own page (and the thank-you note after `?sent=1`);
 * `POST` takes it.
 */
export const publicReportRoutes: FastifyPluginAsync<{
  services: Pick<Services, 'db' | 'config' | 'outbox'>;
  assets: PublicAssets;
}> = async (app, { services, assets }) => {
  const { db, config } = services;
  const base = config.publicBaseUrl;
  const siteName = new URL(base).host;
  // In memory, like the other limits: one app process behind nginx (design plan §3).
  const limiter = createRateLimiter({ max: config.reportRateLimit, windowMs: HOUR });
  const mailLimiter = createRateLimiter({ max: REPORT_MAILS_PER_HOUR, windowMs: HOUR });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 8192 },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );

  async function targetOf(request: FastifyRequest): Promise<ReportTarget | null> {
    const { type, id } = request.params as { type: string; id: string };
    if (!TARGET_TYPES.includes(type as ReportTargetType) || !isUuid(id)) return null;
    return reportTarget(db, base, type as ReportTargetType, id.toLowerCase());
  }

  function render(
    reply: FastifyReply,
    target: ReportTarget,
    page: {
      sent?: boolean;
      values?: Partial<Record<ReportField, string>>;
      errors?: Partial<Record<ReportField, string>>;
      formError?: string;
    } = {},
  ) {
    const path = reportPath(target.type, target.id);
    reply
      .header('cache-control', 'private, no-store')
      .header('x-robots-tag', 'noindex')
      .type('text/html; charset=utf-8');
    return reply.send(
      renderDocument(
        <ReportPage
          url={`${base}${path}`}
          stylesheet={assets.stylesheet}
          targetName={target.name}
          targetUrl={target.pageUrl}
          sent={page.sent ?? false}
          formError={page.formError}
          errors={page.errors}
          form={{
            action: path,
            token: reportFormToken(config.authSecret, target),
            values: page.values,
            abuseEmail: config.abuseEmail,
            siteName,
          }}
        />,
      ),
    );
  }

  app.get('/report/:type/:id', async (request, reply) => {
    const target = await targetOf(request);
    if (!target) return reply.callNotFound();
    return render(reply, target, { sent: (request.query as { sent?: string }).sent === '1' });
  });

  app.post('/report/:type/:id', async (request, reply) => {
    const target = await targetOf(request);
    if (!target) return reply.callNotFound();
    if (!isSameOrigin(request, base)) {
      return reply.code(403).type('text/plain').send('Send the report from the page itself.');
    }
    const body = (request.body ?? {}) as FormBody;
    const sent = `${reportPath(target.type, target.id)}?sent=1`;
    const values = { category: body.category, details: body.details, email: body.email };

    // Bots: the field people never see is filled in, or the form came back faster than anyone
    // reads it. They are told it worked, and nothing is stored.
    const token = checkReportFormToken(config.authSecret, target, body.token);
    if ((body.website ?? '') !== '' || token === 'too_fast') return reply.redirect(sent, 303);
    if (token === 'invalid') {
      reply.code(400);
      return render(reply, target, {
        values,
        formError: 'The form was open too long, or didn’t come from this site. Send it again.',
      });
    }
    const limit = limiter.take(`report:${request.ip}`);
    if (!limit.allowed) {
      reply.code(429).header('retry-after', String(limit.retryAfter));
      return render(reply, target, {
        values,
        formError: `Too many reports were sent from this network. Try again in ${Math.ceil(limit.retryAfter / 60)} minutes, or email the people who run this site.`,
      });
    }

    const errors: Partial<Record<ReportField, string>> = {};
    const category = REPORT_CATEGORIES.find((value) => value === body.category);
    if (!category) errors.category = 'Choose what is wrong';
    const details = (body.details ?? '').trim();
    if (details.length > REPORT_DETAILS_MAX) {
      errors.details = `At most ${REPORT_DETAILS_MAX} characters`;
    }
    const emailInput = (body.email ?? '').trim();
    const email = emailInput ? emailField.safeParse(emailInput) : null;
    if (email && !email.success) errors.email = 'Enter a valid email address, or leave it empty';
    if (!category || Object.keys(errors).length > 0) {
      reply.code(400);
      return render(reply, target, { values, errors });
    }

    await createReport(
      services,
      target,
      {
        category: category as ReportCategory,
        details: details || null,
        reporterEmail: email?.success ? email.data : null,
      },
      mailLimiter,
    );
    return reply.redirect(sent, 303);
  });
};
