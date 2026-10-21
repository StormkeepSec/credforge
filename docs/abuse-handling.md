# Handling abuse on a credforge instance

A runbook for the people who run a credforge instance: what credforge gives you against
offensive, illegal and fraudulent content, how to set it up, and what to do day to day, when
something is reported, and when it is serious.

> **This is not legal advice.** What you must do, how fast, and what you may keep depends on where
> you and your users are, and changes over time. The obligations named below are pointers to
> check with a lawyer who knows your jurisdiction, not a summary you can rely on.

credforge ships **mechanisms only** (design plan §6.5, decisions 56–61). It ships no word list, no
thresholds, no moderation provider and no hash list: every instance decides those for itself, in
its own configuration. Automatic checks of new content and matching known child sexual abuse
material (CSAM) are there to plug in, and off until you set them up; without them, review is done
by people.

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
| **Automatic checks** | A classifier of your choice scores new images and public text (0 to 1 per category) before they are published, whoever uploads them, trusted orgs included. Over your hold threshold: held for you with its scores. Over your remove threshold (off unless you set one): removed at once, audited, owners told. A check that keeps failing leaves the item for you. A generic signed webhook ([moderation-webhooks.md](moderation-webhooks.md)) or OpenAI's moderation endpoint. | `MODERATION_PROVIDER` |
| **Known-CSAM matching** | A slot for a hash matcher you have vetted access to (PhotoDNA, Thorn Safer…), behind the webhook. It checks every new image first; until it has, nobody sees the image. A match is blocked at once and never shown to anyone (platform admins included), the org is suspended, the uploader disabled, and the evidence sealed to a key you keep offline. | `CSAM_MATCHER`, `CSAM_EVIDENCE_PUBLIC_KEY` |
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
6. **The legal pages.** `/privacy` and `/terms` describe the review policy, the word list, the
   automatic checks (naming the provider and the matcher, which receive the content) and what a
   report keeps, from your configuration. Review them before `LEGAL_PAGES_DRAFT=false`.
7. **Automatic checks, if you want them.** Choose a classifier and read its terms: the content
   goes to it. `MODERATION_PROVIDER=openai` with an OpenAI API key is the shortest way; anything
   else goes behind the webhook (a hosted service through a small adapter, or your own model),
   documented in [moderation-webhooks.md](moderation-webhooks.md). Start with the hold threshold
   only (`MODERATION_HOLD_THRESHOLD`, default 0.5) and watch the scores in the queue for a while:
   they show what your provider rates highly on your instance. Give sensitive categories their own
   lower thresholds (`MODERATION_CATEGORY_THRESHOLDS`). Set a remove threshold only for scores you
   are sure of: an automatic removal emails the owners, and you can put it back.
8. **Known-CSAM matching, if you can get it.** Apply for access to a hash-matching service (for
   example Microsoft's PhotoDNA Cloud Service or Thorn's Safer); it decides whether you qualify.
   Run a small bridge that holds your credentials and answers credforge's webhook
   ([moderation-webhooks.md](moderation-webhooks.md), "The known-CSAM matcher"). Before you turn it
   on, create the **evidence key** on a computer that isn't the server, and keep its private key
   offline (an encrypted USB key in a safe, with a second copy elsewhere), with its passphrase kept
   apart from it:

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -aes-256-cbc -out evidence-key.pem
   openssl pkey -in evidence-key.pem -pubout -outform DER | openssl base64 -A
   ```

   Put the second command's line in `.env` as `CSAM_EVIDENCE_PUBLIC_KEY`. The server only ever has
   the public key: it can seal evidence, never open it. Write down who holds the private key. Lose
   it and the evidence can't be opened, ever; generate a new pair and evidence from then on is
   sealed to the new one. The same key serves `cli.js block-known-csam` (section 6) even without
   a matcher.
9. **Caches.** Cleared images are cached for 10 minutes (browsers and nginx), so a removed image
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
- **With automatic checks**, the queue shows each item's scores and why it is there ("Automatic
  check: hate 0.72"). Items appear once their check has run, usually within seconds. The top of
  the page says how many wait for their check and how many checks gave up: those wait for you,
  and **Check again** runs one once more (after fixing the provider, say).
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
                 'user.disabled', 'report.resolved', 'report.dismissed',
                 'moderation.known_csam_blocked')
group by 1, 2 order by 1, 2;

-- Reports per category and outcome.
select category, status, count(*) from content_report group by 1, 2 order by 1, 2;
```

If you operate in the European Union, the Digital Services Act asks hosting services for a way to
report illegal content (the form), reasons for decisions sent to those affected (the emails), a
way to contest them, and, for many services, transparency reports. Other places have their own
rules. Check what applies to you.

## 6. Child sexual abuse material

> **Not legal advice.** This section points at duties to check with a lawyer where you operate. It
> is not a summary you can rely on, and laws here change often.

### When the matcher finds known CSAM

credforge acts at once, before anyone looks (design plan §6.5, decision 61):

- The image is **blocked**: it is removed for good, every URL of it answers an "Image removed"
  tile, and nobody can see it in credforge again, not even blurred, platform admins included. The
  same bytes uploaded again, anywhere, are blocked again. Other copies already on the instance are
  checked again (and blocked).
- The **org is suspended** and the **account that uploaded it disabled** (unless it is a platform
  admin's). Their notices give a neutral reason ("while the people who run this site review
  content…") and nothing about what matched. The org's own audit log says only that an image was
  removed and the org suspended; the instance's log has `moderation.known_csam_blocked` with the
  details.
- The **evidence is sealed**: the image as stored, and what credforge knows about the upload (the
  account's name, email address and creation date; the org; when it was uploaded, from which IP
  address and browser; the matcher's list and reference), encrypted to your evidence public key and
  kept in the database table `moderation_evidence`. The app can add evidence but can't read it back,
  change or delete it (its database role isn't allowed to), and no one can change it (a trigger
  refuses). Only then are the image's stored files deleted, so the sealed copy is the only one left.
  The database backups carry it, still sealed.
- **Every platform admin is emailed**, with the evidence id and no image.

The moderation queue lists the item under **Removed**, with "Known child sexual abuse material:
never shown" and its evidence id in place of the image.

### When a person finds it, or a service outside credforge does

If you see, or are told about, an image that may show the sexual abuse or exploitation of a child:

1. **Don't copy, download, forward or show it to anyone**, including colleagues "to check". Don't
   screenshot it. Leave the image blurred.
2. **Block it with credforge's own command**, which does exactly what a match does (seals the
   evidence, then deletes the stored files, suspends the org, disables the uploader), for the image
   and every copy of it on the instance:

   ```bash
   docker compose exec app node dist/cli.js block-known-csam --image-url <the image's URL> --source "<who found it>" [--reference <their reference>]
   ```

   Run it first without `--yes` to see what it would do. `--source` is kept with the evidence:
   "Cloudflare CSAM Scanning Tool" (whose notices give the image's URL), "child-safety report,
   reviewed by <name>", and so on. It needs `CSAM_EVIDENCE_PUBLIC_KEY`, matcher or not.
   Without an evidence key, remove the image in the moderation queue (it is kept, unencrypted, in
   the private files bucket), suspend the org and disable the accounts by hand, and limit who can
   reach the bucket and the database.
3. **Don't warn them first**, and don't erase the org or its accounts: they are what you will be
   asked about.

### Reporting it

Report it to the authority for your jurisdiction through its official channel, as soon as you
can, and keep the report's reference with the case. Examples, as starting points:

- **United States:** providers of an electronic communication service or a remote computing
  service to the public must report to the National Center for Missing & Exploited Children's
  **CyberTipline** as soon as reasonably possible after they learn of apparent child sexual abuse
  material on their service (18 U.S.C. § 2258A; since the REPORT Act of 2024, apparent child sex
  trafficking and enticement too). Knowingly and willfully failing to report is fined (up to
  $600,000 for a first failure by a provider with fewer than 100 million monthly users). Register
  with NCMEC for provider reporting **before** you need it. A report counts as a request to
  **preserve** what it covers for **one year** after it is made (longer if you choose, to fight
  child exploitation), stored securely, with access limited to the people who need it, in line with
  the NIST Cybersecurity Framework: credforge's sealed evidence is built for that. Reports say
  whether anyone at the provider viewed the file; credforge never shows it, so unless someone
  opens the evidence the answer is no. Whether a trained person should look before you report is a
  question for your lawyer.
- **United Kingdom:** the Online Safety Act 2023 requires regulated user-to-user services to report
  child sexual exploitation and abuse content to the **National Crime Agency** (check whether its
  reporting duty is in force and applies to you). The Internet Watch Foundation (iwf.org.uk) takes
  reports too, and can give members hash lists.
- **Canada:** providers of an Internet service to the public must notify the police when they have
  reasonable grounds to believe their service was used for such an offence, **preserve** the
  related data for **21 days** after notifying, and report addresses they are told about to the
  Canadian Centre for Child Protection (Cybertip.ca). They must not disclose a report where that
  could prejudice an investigation.
- **European Union:** hosting services must promptly inform the authorities of a suspected crime
  that threatens someone's life or safety (Digital Services Act, article 18); national laws add
  their own duties. INHOPE's hotlines (inhope.org) take reports in most member states.
- **Australia:** the eSafety Commissioner.
- **Elsewhere:** INHOPE lists national hotlines; your national police can tell you who receives
  these reports.

### Handling the evidence

The evidence leaves the database only with the database owner's rights, and each export is
recorded in the instance's audit log (`moderation.evidence_exported`, with the operating-system
user who ran it):

```bash
docker compose run --rm -T migrate node dist/cli.js export-evidence --id <evidence id> > evidence-<id>.json
```

The file is still sealed: it is safe to move, but treat it as part of the case. Open it only
where your lawyer says the material may be handled, for the report, on the offline computer that
holds the private key (the credforge image needs no database or configuration for this):

```bash
docker run --rm --network none -v "$PWD:/case" credforge:latest node dist/cli.js open-evidence --key /case/evidence-key.pem --passphrase-file /case/passphrase --in /case/evidence-<id>.json --out /case/opened
```

It writes `manifest.json` (what credforge knew about the upload) and the image into a new folder.
Delete the opened copy once the report is made; the sealed evidence stays. Keep the evidence as
long as the law requires, then delete it as the database owner
(`delete from moderation_evidence where id = '…'`), never earlier.

**Look after the person who found it.** Offer time off and support.

## 7. Limits of what credforge can do

- Review is only as quick as your platform admins. With `MODERATION_REVIEW=untrusted`, an
  untrusted org's badges reach people outside it only after review, so nobody outside the org sees
  held content.
- The word list holds text; it can't read images. Images wait for a person, or for your
  classifier, which makes mistakes both ways: check its scores against your own decisions.
- Hash matching only finds **known** material, already in a list. A new image of abuse isn't in
  any list: reports and people still matter.
- Content published before you set up a scanner isn't checked (only what still waits for review
  is). An image that matched is gone from your storage, but not from copies already elsewhere.
- A badge's signed JSON keeps the text it was signed with. Revoking it marks it revoked everywhere;
  nothing can unsend a copy someone already has.
- Images other services already fetched (link previews, email image proxies) stay in their caches.
