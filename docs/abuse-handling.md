# Handling abuse on a credforge instance

A runbook for the people who run a credforge instance: what credforge gives you against
offensive, illegal and fraudulent content, how to set it up, and what to do day to day, when
something is reported, and when it is serious.

> **This is not legal advice.** What you must do, how fast, and what you may keep depends on where
> you and your users are, and changes over time. The obligations named below are pointers to
> check with a lawyer who knows your jurisdiction, not a summary you can rely on.

credforge ships **mechanisms only** (design plan §6.5, decisions 56–58). It ships no word list, no
thresholds and no moderation provider: every instance decides those for itself, in its own
configuration. Automatic scanning and matching known child sexual abuse material (CSAM) against
hash lists are separate pieces of work; until your instance has them, review is done by people.

## 1. What credforge gives you

| Mechanism | What it does | Where |
|---|---|---|
| **Hold until cleared** | New images (badge images, issuer logos) and public text (organization, issuer and achievement names, descriptions, criteria, tags) of orgs you haven't marked trusted wait for a platform admin. Public pages show the last cleared version or a neutral placeholder; Open Graph cards and baked downloads leave held images out; only the org's own members can be awarded badges carrying held content, and those badges' pages stay private until it is cleared. Edits go back to review; going back to text that was already cleared doesn't. | `MODERATION_REVIEW` |
| **Approval reviews the first content** | Approving a new org on the Platform screen publishes the content you were shown with it. Anything saved after you loaded the page keeps waiting. | Platform |
| **Trusted orgs** | An org you mark trusted publishes new content without waiting (with `MODERATION_REVIEW=untrusted`). Word-list matches and reports still hold its content. | Platform → Mark as trusted |
| **Your word list** | Public text that contains a listed term is held for review, never refused. Matching ignores case and accents, sees through common look-alike letters and swaps (`0` for o, `@` for a, Cyrillic letters…) and repeated letters, and finds terms inside longer words; `=term` lines match whole words only. | `MODERATION_TEXT_BLOCKLIST_FILE` |
| **Reports** | A "Report a problem" form on every public badge, achievement and issuer page, with categories including child safety. Reports are stored for the queue and emailed to every platform admin. A child-safety report holds the page's images at once. No third-party CAPTCHA: a per-address rate limit, a signed form token (a few seconds to a day old), a field only bots fill in, and a same-origin check. | `/report/…`, `REPORT_RATE_LIMIT` |
| **The moderation queue** | Held text and images (images blurred until you ask to see them, never offered as a download), reports with what the page shows, and what was cleared or removed. | Platform → Moderation |
| **Actions** | Clear; remove an image or text; unpublish an achievement; suspend the org; revoke every badge it awarded; disable an account; mark an org trusted. Each writes an audit event and emails the org's owners (or the person) the reason; replies go to `ABUSE_EMAIL`. | Moderation, Platform |
| **Upload limits** | Image and CSV uploads per org per hour, and a storage quota per org; both can be changed per org. | `ORG_UPLOAD_RATE_LIMIT`, `ORG_STORAGE_QUOTA_MB` |
| **Earlier controls** | Org approval (`SIGNUP_MODE=approval`), daily email caps, suspension notices on public pages, domain verification, SVG sanitizing and image re-encoding, the append-only audit log, erasing a recipient's data, `cli.js revoke-org-credentials`. | design plan §6.3, §12 |

**What removal means for issued badges.** Signed credentials can't change. A removed image's
permanent, content-addressed URL keeps answering, with an "Image removed" placeholder, so badges
that refer to it still verify; their baked downloads use the placeholder. The same image uploaded
again, by anyone, stays removed. An unpublished achievement's page answers 410 and its badges'
pages no longer show its details, but each badge's signed JSON still carries its text (it is what
was signed): revoke the badges too when the text itself must stop circulating.

## 2. Setting up

1. **An abuse inbox.** Set `ABUSE_EMAIL` to an address someone reads (it needs an inbound mail
   host: SendGrid only sends). The report form offers it as another way in, the legal pages name it,
   and owners' replies to moderation emails go there.
2. **Platform admins.** At least two people, each with two-step verification
   (`REQUIRE_MFA_FOR_ADMINS=true`), so reports don't wait for one person's holiday. Create them with
   `cli.js create-platform-admin`. Every platform admin gets every report email.
3. **The review policy.** Keep `MODERATION_REVIEW=untrusted` (the default) on any instance where
   strangers can sign up. Mark orgs trusted once you know them. `all` reviews everyone, trusted or
   not; `off` reviews no one (the word list and reports still hold content) and suits an instance
   only you and people you know use.
4. **A word list, if you want one.** Write one term per line to a file outside the repository and
   point `MODERATION_TEXT_BLOCKLIST_FILE` at it (in Docker, mount it read-only, for example as a
   secret). Choose terms for your users' languages; prefer `=term` for short words that are often
   part of innocent ones. A match only holds content for review, so a broad list costs your time,
   not your users'. The app reads the file at start-up: restart `app` after changing it. With
   the compose stack, every service that reads `.env` resolves `…_FILE` settings when it starts
   (and refuses to start if it can't read the file), so mount it into all of them with a
   `docker-compose.override.yml` next to `docker-compose.yml`:

   ```yaml
   x-blocklist: &blocklist
     volumes: ["./moderation-blocklist.txt:/run/secrets/moderation-blocklist.txt:ro"]
   services:
     app: *blocklist
     worker: *blocklist
     migrate: *blocklist
     backup: *blocklist
   ```

   and set `MODERATION_TEXT_BLOCKLIST_FILE=/run/secrets/moderation-blocklist.txt` in `.env`. The
   file must be readable by the containers' `node` user (uid 1000).
5. **Limits.** The defaults (60 uploads an hour, 500 MB per org, 10 reports per address an hour)
   suit a small public instance. Raise an org's own limits on the Platform screen.
6. **The legal pages.** `/privacy` and `/terms` describe the review policy, the word list and what
   a report keeps, from your configuration. Review them before `LEGAL_PAGES_DRAFT=false`.
7. **Caches.** Cleared images are cached for 10 minutes (browsers and nginx), so a removed image
   is gone from them within 10 minutes. To purge nginx at once: `sudo rm -rf
   /var/cache/nginx/credforge-images/*`. Copies elsewhere (link previews LinkedIn or Slack already
   fetched, email clients' image proxies, people's downloads) are out of your reach.

## 3. Day to day

- **Look at the queue at least daily**, more often after announcing the instance. The sidebar's
  **Moderation** lists what waits, oldest first, and the reports.
- **Approving an org**: open its card under Platform → Waiting. Its issuer profile, logo, published
  achievements and name are shown with it; remove anything you won't publish first, then
  **Approve and publish**. Decline orgs you don't want, with a reason.
- **Clear** what is fine. **Remove** an image or text that breaks your terms; give a reason the
  owners will understand. **Unpublish** an achievement whose purpose is the problem.
- **Trust** orgs that have shown they publish responsibly; it saves you reviewing every edit.
- **Look after yourselves.** Images stay blurred until you choose to see them; most decisions
  don't need the full image. Take turns, take breaks, and stop and ask for help after seeing
  something distressing.

## 4. Reports

Read reports in this order: **child safety first** (see §6), then anything that could hurt people
now (threats, phishing, a credential used to deceive), then the rest.

1. Open the report under Moderation → Reports. It shows the reported page's content as the queue
   shows it (images blurred).
2. Decide, and act on the content: clear, remove, unpublish; suspend the org or disable an account
   for deliberate abuse; revoke its badges for fraud.
3. **Resolve** the report (something was done) or **dismiss** it (nothing was wrong), with a note
   for the record. The reporter's address, if they gave one, is on the report: answer them if it
   helps, without naming who was involved beyond what is public.
4. A flood of reports about one page (or of nonsense) is itself abuse: the rate limit keeps each
   address to 10 an hour; check what was held and clear it.

What a report keeps: the page, the category, what the reporter wrote and, only if they gave it,
their email address. Not their IP address (it is used in memory for the rate limit). The org never
sees reports; its audit log shows only that images were held, by "report".

## 5. Takedowns, appeals and transparency

**Taking something down** (any action above):

1. Look at enough to decide, no more. Write down why, in the reason field: the owners get it by
   email, and the audit log keeps it.
2. Prefer the narrowest action that works: remove one image before unpublishing an achievement,
   unpublish before suspending the org, suspend before revoking every badge.
3. For deliberate abuse (spam, phishing, impersonation, hateful campaigns), suspend the org and
   disable the accounts behind it; revoke its badges when they deceive people. API keys belong to
   the org, not to a person: disabling an account leaves the org's keys working, while suspending
   the org makes them read-only.

**Appeals.** Owners reply to the email about the decision; it goes to `ABUSE_EMAIL`. Have someone
who didn't make the first decision look again, and answer within a time you can keep (for
example, 7 days). To undo: **Put back** a removed image or text in Moderation → Removed,
reinstate an unpublished achievement (it comes back archived; the org restores it), reinstate a
suspended org, enable a disabled account. Revoked badges can't be un-revoked: the org reissues
them.

**Transparency.** Publishing a short report now and then (what was reported, what you did,
how fast) builds trust and may be required where you operate. The audit log has the numbers:

```sql
-- Decisions per month (run with psql as the database owner).
select date_trunc('month', created_at) as month, action, count(*)
from audit_event
where action in ('moderation.cleared', 'moderation.removed', 'moderation.images_held',
                 'achievement.unpublished_by_platform', 'org.suspended', 'org.credentials_revoked',
                 'user.disabled', 'report.resolved', 'report.dismissed')
group by 1, 2 order by 1, 2;

-- Reports per category and outcome.
select category, status, count(*) from content_report group by 1, 2 order by 1, 2;
```

If you operate in the European Union, the Digital Services Act asks hosting services for a way to
report illegal content (the form), reasons for decisions sent to those affected (the emails), a
way to contest them, and, for many services, transparency reports. Other places have their own
rules. Check what applies to you.

## 6. Child sexual abuse material

If you see, or are told about, an image that may show the sexual abuse or exploitation of a child:

1. **Don't copy, download, forward or show it to anyone**, including colleagues "to check". Don't
   screenshot it. Leave the image blurred.
2. **Take it down at once**: remove the image in the moderation queue (it stops being served,
   everywhere, within the cache time above), suspend the org, and disable the accounts that
   uploaded it. Don't warn them first.
3. **Preserve, don't destroy.** A removed image stays in the instance's private files bucket (it
   isn't deleted, and isn't served); its record, the audit log, the org, the uploading account and
   the request logs are what you will be asked about. Don't erase the org or its accounts. Limit who
   can reach the files bucket and the database to the people who must, and note who did.
4. **Report it to the authority for your jurisdiction**, through their official channel, and keep
   the report's reference with the case. Examples, as starting points:
   - **United States:** the National Center for Missing & Exploited Children's **CyberTipline**
     (report.cybertip.org). Providers of an electronic communication service or remote computing
     service must report apparent CSAM they become aware of (18 U.S.C. § 2258A) and preserve what
     they reported for a period the law sets (extended to one year by the REPORT Act of 2024). Ask
     your lawyer whether and how this applies to you, and about registering for reporting in advance.
   - **United Kingdom:** the Internet Watch Foundation (iwf.org.uk) and the National Crime Agency's
     CEOP.
   - **Canada:** Cybertip.ca; Canada also has mandatory reporting for internet service providers.
   - **Australia:** the eSafety Commissioner.
   - **Elsewhere:** INHOPE (inhope.org) lists national hotlines; your national police can tell you
     who receives these reports.
5. **Look after the person who found it.** Offer time off and support.

Hash-matching against known CSAM (PhotoDNA, Thorn Safer, Cloudflare's CSAM Scanning Tool and the
like) needs vetted access from those organizations. credforge is being given a slot for such an
adapter; it ships no implementation.

## 7. Limits of what credforge can do

- Review is only as quick as your platform admins. With `MODERATION_REVIEW=untrusted`, an
  untrusted org's badges reach people outside it only after review, so nobody outside the org sees
  held content.
- The word list holds text; it can't read images. Images wait for a person (or, once added, a
  scanner).
- A badge's signed JSON keeps the text it was signed with. Revoking it marks it revoked everywhere;
  nothing can unsend a copy someone already has.
- Images other services already fetched (link previews, email image proxies) stay in their caches.
