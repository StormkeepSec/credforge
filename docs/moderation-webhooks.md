# Moderation webhooks

credforge can send new images and public text to a service of your choice before they are
published, and read back how likely each is to break your terms. It can also ask a known-CSAM
matcher whether an image is in a list of known child sexual abuse material. Both use the same
signed webhook, so you can connect a hosted moderation service, your own model, or a bridge to a
hash-matching service without changing credforge. This page is the contract. The design is in
design plan §6.5 (decisions 60–61), and what to do with the results is in
[`abuse-handling.md`](abuse-handling.md).

credforge ships no provider choice, thresholds, keys or lists. Everything below is off until you
configure it.

| Webhook | Turn it on | Asked about |
|---|---|---|
| Classifier | `MODERATION_PROVIDER=webhook`, `MODERATION_WEBHOOK_URL`, `MODERATION_WEBHOOK_SECRET`, `MODERATION_WEBHOOK_NAME` | New badge images and issuer logos, and new public text (org, issuer and achievement), per `MODERATION_SCAN` |
| Known-CSAM matcher | `CSAM_MATCHER=webhook`, `CSAM_MATCHER_URL`, `CSAM_MATCHER_SECRET`, `CSAM_MATCHER_NAME`, `CSAM_EVIDENCE_PUBLIC_KEY` | New badge images and issuer logos, before any classifier |

The `…_NAME` is who runs the service, for example "Example Moderation Inc." or "our own model".
The privacy policy names it as a processor, and the moderation queue shows it.

## How credforge calls it

- **When:** the worker runs one check per new image or text version, before the content can be
  published. Until the check has run, the content is held: public pages show the version cleared
  last or a placeholder. With a matcher set up, an image isn't shown to anyone until the matcher
  has passed it, platform admins and the org's own members included.
- **Order:** the matcher first. If it reports a match, the image goes nowhere else.
- **Method:** `POST` to your URL, with a JSON body (`content-type: application/json`). Redirects
  aren't followed. Each request times out after 30 seconds.
- **Retries:** anything but a `2xx` answer with a valid body, including a timeout, fails the
  attempt. The worker tries again after 30 seconds, then 1, 2 and 4 minutes. After 5 failed
  attempts it gives up, and the item waits in the moderation queue for a person ("Check again"
  runs it once more). Because it is retried, your service should treat the same `id` arriving
  twice as one check.
- **Transport:** use `https://`. In production credforge accepts `http://` only to a host on a
  private network, such as a compose service name (`http://moderation:8080/check`) or a
  10.x/172.16–31.x/192.168.x address.
- **What is sent:** the content and what kind it is. No org, account, email or IP address.

### Headers

| Header | Value |
|---|---|
| `credforge-signature` | `t={unix seconds},v1={hex HMAC-SHA256}` (below) |
| `credforge-request-id` | The request's `id`, a UUID |
| `user-agent` | `credforge (+{PUBLIC_BASE_URL})` |

### The signature

`v1` is the lowercase hex HMAC-SHA256 of `{t}.{raw body}`, keyed with the shared secret (UTF-8).
To verify a request, your service should:

1. Read the raw body before parsing it.
2. Compute the HMAC of `{t}.{raw body}` with the secret and compare it with `v1` in constant time.
3. Refuse a request whose `t` is more than 5 minutes from your clock (a replay).

Generate the secret with `openssl rand -hex 32`. It must be at least 32 characters. Use a
different secret for each webhook.

```js
// Node: verifying a credforge webhook request.
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, header, rawBody, now = Date.now()) {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=')));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(expected, given);
}
```

A test vector: secret `credforge-test-secret-0123456789abcdef`, `t=1792600000`, body
`{"version":1,"id":"x"}` gives
`v1=1634bd3b20d96369b096ff1d13186b53466bc25de7b45c38e70bf0aa2e0992c4`.

## The classifier

### Request: an image

```json
{
  "version": 1,
  "id": "7d1c2a51-1111-4c3e-9a8a-3d5e6f708192",
  "type": "image",
  "subject": "badge_image",
  "image": {
    "mimeType": "image/png",
    "width": 512,
    "height": 512,
    "data": "iVBORw0KGgo…"
  }
}
```

`subject` is `badge_image` or `issuer_logo`. `data` is base64 of credforge's 512 × 512 PNG
rendering of the image (the badge centered on transparency), so it is never an SVG and never more
than a few hundred kilobytes.

### Request: text

```json
{
  "version": 1,
  "id": "0b8f4a6e-2222-4d1f-8b7c-1a2b3c4d5e6f",
  "type": "text",
  "subject": "achievement",
  "text": {
    "fields": [
      { "name": "name", "value": "Intro to Network Defense" },
      { "name": "description", "value": "Recognizes foundational skills…" },
      { "name": "criteriaNarrative", "value": "Completed all six labs." }
    ],
    "joined": "Intro to Network Defense\n\nRecognizes foundational skills…\n\nCompleted all six labs."
  }
}
```

`subject` is `organization`, `issuer` or `achievement`. `fields` lists the public fields that have
a value: an organization's `name`; an issuer's `name`, `description`, `website`, `email`; an
achievement's `name`, `description`, `criteriaNarrative`, `criteriaUrl`, `tags` (comma-separated)
and `alignments` (one per line). `joined` is the same text in one string, for models that read one.

### Answer

```json
{ "categories": { "sexual": 0.02, "hate": 0.71, "violence": 0.0 } }
```

- One score per category, from 0 to 1: how likely the content is to belong to it. Use your
  provider's own category names (lowercase letters, digits, `_ . / -`, up to 64 characters, such
  as `sexual/minors` or `hate_speech`); the operator's thresholds refer to them.
- `null` scores are ignored. Up to 100 categories. Anything else (a score outside 0–1, a missing
  `categories` object, a body over 64 KB) fails the check.
- An empty object means nothing was found.

### What credforge does with the scores

The operator's thresholds decide, per category:

| Setting | Meaning |
|---|---|
| `MODERATION_HOLD_THRESHOLD` | A score at or over it holds the item for a platform admin, with its scores. Default 0.5, a generic midpoint to adjust for your provider. |
| `MODERATION_REMOVE_THRESHOLD` | A score at or over it removes the item at once, as a platform admin's **Remove** does (audited, owners emailed with the reason). Unset (the default): nothing is removed automatically. |
| `MODERATION_CATEGORY_THRESHOLDS` | Per category: `category=hold` or `category=hold:remove`, comma-separated; `off` turns either off. For example `sexual/minors=0.05:0.5,violence=0.8,harassment=off`. |

Content under every hold threshold is published, unless something else holds it: the review
policy (`MODERATION_REVIEW`), the word list or a report. Then it waits for a person, with its
scores shown in the queue.

## The known-CSAM matcher

credforge ships no hash-matching implementation. PhotoDNA, Thorn's Safer and similar services
give access only to vetted organizations, under their own terms. Run a small bridge of your own
that holds your credentials, verifies the signature above and asks the service. Cloudflare's CSAM
Scanning Tool works differently: it scans images as Cloudflare serves them and emails you a URL.
For those, use `cli.js block-known-csam` (see `abuse-handling.md`, section 6).

### Request

```json
{
  "version": 1,
  "id": "4e5f6a7b-3333-4e2a-9c8d-7e6f5a4b3c2d",
  "type": "csam_match",
  "subject": "badge_image",
  "image": {
    "mimeType": "image/png",
    "width": 1024,
    "height": 1024,
    "sha256": "9f2c…",
    "data": "iVBORw0KGgo…"
  }
}
```

`data` is the stored original: every raster upload is decoded and re-encoded as PNG (metadata
removed, at most 2048 px). For an SVG it is the 512 px PNG rendering. `sha256` is the stored
file's SHA-256 (the content address in its URLs), not a perceptual hash: compute what your service
needs from `data`.

### Answer

```json
{ "matched": false }
```

```json
{ "matched": true, "list": "Example hash list", "reference": "match-123" }
```

`list` and `reference` are optional and kept with the evidence, for the report to the
authorities. An answer without a boolean `matched` fails the check: the image stays held, unseen.

### On a match

At once, in one transaction: the image is removed for good (its URLs answer an "Image removed"
tile), the org is suspended and the account that uploaded it disabled, with neutral reasons. The
image as stored and what credforge knows about its upload are sealed to `CSAM_EVIDENCE_PUBLIC_KEY`
and kept in the database. Then the stored image files are deleted. Every other copy of the same
image on the instance is checked again. Platform admins are emailed. Nobody, platform admins
included, can see the image in credforge again. What to do next is in `abuse-handling.md`,
section 6.

## OpenAI instead of a webhook

`MODERATION_PROVIDER=openai` with `MODERATION_OPENAI_API_KEY` uses OpenAI's moderation endpoint
(`omni-moderation-latest` unless `MODERATION_OPENAI_MODEL` says otherwise) as the classifier,
without a webhook. It is free of charge and scores images and text with the same 0–1 categories
(`sexual`, `hate`, `harassment`, `violence`, `self-harm`, `illicit` and their subcategories). Some
categories score text only (`sexual/minors` among them); those are left out for images. Content is
sent to OpenAI under its API terms: the privacy policy names it.
