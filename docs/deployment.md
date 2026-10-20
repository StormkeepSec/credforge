# Deploying credforge

How https://credforge.app runs, and how to set up the same thing from scratch. Self-hosters can
follow it too: replace `credforge.app`, the region and the bucket names with your own.

**The shape** (design plan §13, decisions 34 and 35):

- One DigitalOcean droplet in `sfo3`: 2 GB RAM, Debian 13, Docker Engine and the Compose plugin.
  Its nginx terminates TLS and forwards to the app on `127.0.0.1:3000`.
- The compose stack (`docker-compose.yml`: `db`, `migrate`, `app`, `worker`, and `backup` for the
  nightly job) lives in `/opt/credforge` with its `.env` and `backup.env`.
- The image is built on your PC and streamed to the droplet over SSH by `deploy/ship.sh`. There is
  no registry, and nothing is built on the droplet.
- Badge images and logos are in the private `credforge-prod` Space, database backups in the
  private `credforge-backups` Space, both in `sfo3`. Email goes out through SendGrid's Web API
  (DigitalOcean blocks outgoing SMTP).

In the commands below, `you` is your user on the droplet and `credforge` is an SSH alias for it
(see 1.2). Commands are run on the droplet unless they say "on your PC" (Git Bash on Windows).

## What has to exist first

| What | Where | Needed for |
|---|---|---|
| The droplet, with a Cloud Firewall | DigitalOcean | everything |
| DNS for `credforge.app` and `www` pointing at it, and a CAA record | your DNS host | TLS, every credential URL |
| `credforge-prod` and `credforge-backups` Spaces, each with its own limited key | DigitalOcean → Spaces | images, backups |
| SendGrid Domain Authentication, DMARC, a Mail Send key, the signed Event Webhook | SendGrid, your DNS host | email |
| A Google OAuth client and a Microsoft Entra app registration | Google Cloud, Microsoft Entra | "Continue with Google / Microsoft" |
| An inbound mail host for `security@`, `abuse@` and DMARC reports (MX records) | your mail provider | SECURITY.md, "Report a problem", DMARC |
| The production `.env` and `backup.env`, and an offline copy of the master key | your password manager | everything |

## 1. Prepare the droplet (once)

### 1.1 Firewall

In DigitalOcean → Networking → Firewalls, attach a firewall to the droplet with inbound rules
**SSH (22) from your IP only**, **HTTP (80)** and **HTTPS (443)** from anywhere, and the default
outbound rules. If your IP changes and you're locked out, change the rule in the control panel
(or use the droplet's Recovery Console).

### 1.2 Your user and SSH

Log in once as `root` with the SSH key the droplet was created with, and make your own user:

```bash
adduser --gecos "" you                  # its password is for sudo; keep it in your password manager
usermod -aG sudo,docker you             # the docker group is root-equivalent: only for admins
install -d -m 700 -o you -g you /home/you/.ssh
install -m 600 -o you -g you /root/.ssh/authorized_keys /home/you/.ssh/authorized_keys
```

On your PC, add an alias to `~/.ssh/config`, and check that `ssh credforge` logs you in:

```text
Host credforge
    HostName <the droplet's IP>
    User you
    IdentityFile ~/.ssh/id_ed25519
```

Then turn off root and password logins. **Keep your current session open** until a new
`ssh credforge` works, so a mistake can't lock you out:

```bash
sudo tee /etc/ssh/sshd_config.d/10-hardening.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers you
MaxAuthTries 3
X11Forwarding no
EOF
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication) '
```

The file's `10-` prefix matters: sshd keeps the first value it reads, and cloud-init may have
written `50-cloud-init.conf` with `PasswordAuthentication yes`.

### 1.3 Swap

2 GB is enough for PostgreSQL, the app and the worker, but swap keeps a memory spike (a large
CSV batch, `apt upgrade`) from killing a process:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf && sudo sysctl --system
free -h
```

### 1.4 Automatic security updates

```bash
sudo apt update && sudo apt install -y unattended-upgrades apt-listchanges
sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
# Reboot by itself after a kernel update, at a quiet hour (UTC), after the 03:17 backup.
sudo tee /etc/apt/apt.conf.d/52credforge-reboot >/dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "11:00";
EOF
sudo unattended-upgrade --dry-run 2>&1 | tail -3
```

This installs Debian's security and point-release updates. Docker's own packages come from
Docker's repository and are not included: upgrade them by hand when you deploy
(`sudo apt update && sudo apt upgrade`), since that restarts the containers. The containers
restart by themselves after a reboot (`restart: unless-stopped`).

Leave the clock in UTC and synchronized (`timedatectl` should say `System clock synchronized:
yes`): two-step verification codes depend on it.

### 1.5 Docker and the firewall

Ports that Docker publishes bypass `ufw` (Docker writes its own iptables rules ahead of it), so a
host firewall on the droplet would not protect a published port. That's why `docker-compose.yml`
publishes only `127.0.0.1:3000` and never the database, and why the DigitalOcean Cloud Firewall,
which sits outside the droplet, is the boundary. Don't change the port to `"3000:3000"`. After the
first deploy, check what listens:

```bash
sudo ss -tlnp    # public: only :22, :80 and :443; the app only on 127.0.0.1:3000
```

### 1.6 The stack's directory

```bash
sudo install -d -o you -g you -m 750 /opt/credforge
```

## 2. DNS

At the DNS host for `credforge.app` (a short TTL such as 300 helps during the launch):

| Name | Type | Value |
|---|---|---|
| `credforge.app` | A | the droplet's IPv4 address |
| `credforge.app` | AAAA | its IPv6 address, if IPv6 is turned on for the droplet |
| `www.credforge.app` | CNAME | `credforge.app` |
| `credforge.app` | CAA | `0 issue "letsencrypt.org"` |
| `credforge.app` | CAA | `0 issuewild ";"` |
| `credforge.app` | CAA | `0 iodef "mailto:security@credforge.app"` |
| SendGrid's three CNAMEs and `_dmarc` | | step 4 |
| MX (and the SPF TXT your mail host asks for) | | your inbound mail host |

The CAA records allow only Let's Encrypt to issue certificates for the domain, and no wildcard
certificates at all. Check them from your PC with
`curl -s "https://dns.google/resolve?name=credforge.app&type=CAA"`.

## 3. Storage: DigitalOcean Spaces

Follow the README's checklist (*Email and storage for credforge.app*), in `sfo3`:

- `credforge-prod`: File Listing restricted, no CDN, **versioning on**, and a limited access key
  with Read/Write/Delete on this bucket only (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` in `.env`).
- `credforge-backups`: File Listing restricted, and a second limited key on this bucket only
  (`BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` in `backup.env`). No lifecycle rule
  is needed: the backup tool deletes backups past 30 days but always keeps the newest seven.

## 4. Email: SendGrid, first part

In SendGrid (the README's checklist has the details):

1. **Domain Authentication** for `credforge.app`, with automated security on; add the three CNAME
   records and click Verify.
2. **DMARC**: `_dmarc.credforge.app` TXT `v=DMARC1; p=none; rua=mailto:dmarc@credforge.app` (an
   address your inbound mail host receives). Move to `p=quarantine` once the reports show only
   SendGrid sending for the domain.
3. A **restricted API key** with only *Mail Send* → `SENDGRID_API_KEY`.

The signed Event Webhook is set up after the first deploy (step 10): SendGrid's test needs the
endpoint to be live.

## 5. Write the production configuration

On your PC, make `credforge.env` from `.env.example` **outside the repository** (for example in
an encrypted folder), and fill it in. Generate the secrets in Git Bash:

```bash
openssl rand -hex 24      # POSTGRES_PASSWORD
openssl rand -hex 24      # POSTGRES_APP_PASSWORD
openssl rand -hex 32      # AUTH_SECRET
openssl rand -base64 32   # CREDFORGE_MASTER_KEY
```

The values credforge.app uses besides the secrets: `PUBLIC_BASE_URL=https://credforge.app`,
`EMAIL_TRANSPORT=sendgrid`, `EMAIL_FROM=credforge <awards@credforge.app>`, `STORAGE_DRIVER=s3`
with `S3_ENDPOINT=https://sfo3.digitaloceanspaces.com`, `S3_REGION=sfo3`,
`S3_BUCKET=credforge-prod`, `SIGNUP_MODE=approval`, `REQUIRE_MFA_FOR_ADMINS=true`,
`TRUST_PROXY=true`, `LANDING_PAGE=true`, `ABUSE_EMAIL=abuse@credforge.app`,
`SECURITY_EMAIL=security@credforge.app`, `OPERATOR_NAME` (who runs the instance, as `/privacy`
and `/terms` name it), and `LEGAL_PAGES_DRAFT=true` until you have reviewed those two pages (they
say "Draft for review" until then; Google's consent screen links to them). Leave
`SENDGRID_WEBHOOK_PUBLIC_KEY` and the Google and Microsoft settings empty for now.

⚠️ **`PUBLIC_BASE_URL` is permanent**: every credential embeds it, and the app refuses to start
if it changes. Get it right before the first start.

Do the same for `backup.env` from `backup.env.example`. Then copy both to the droplet so that
they are never readable by anyone else, not even for a moment:

```bash
# on your PC
ssh credforge 'umask 077 && cat > /opt/credforge/.env' < credforge.env
ssh credforge 'umask 077 && cat > /opt/credforge/backup.env' < credforge-backup.env
ssh credforge 'stat -c "%a %n" /opt/credforge/.env /opt/credforge/backup.env'   # 600 both
```

To change a value later, edit it on the droplet (`nano /opt/credforge/.env`) and run
`docker compose up -d`: Compose recreates the containers whose configuration changed.

### Back up the keys offline, now

**`CREDFORGE_MASTER_KEY` is the one secret that can't be replaced.** It encrypts every issuer's
signing key and every database backup. Without it nothing new can be signed, revocations stop
working, and the backups can't be decrypted. `AUTH_SECRET` encrypts everyone's two-step
verification secrets and can't change either.

Keep `credforge.env` and `credforge-backup.env` in your password manager, and the master key and
`AUTH_SECRET` also on paper (or a USB stick) somewhere safe away from your PC. Never put them in a
Space, the repository, email or chat. The other secrets can be rotated.

## 6. nginx and TLS

DNS must already point at the droplet. Install nginx and certbot, get the certificate through
Debian's default site, then put `deploy/nginx.conf.example` in its place (the file's header has
the same steps):

```bash
sudo apt install -y nginx certbot
sudo certbot certonly --webroot -w /var/www/html -d credforge.app -d www.credforge.app \
  --deploy-hook "systemctl reload nginx" -m security@credforge.app --agree-tos --no-eff-email
```

```bash
# on your PC: copy the example to the droplet
scp deploy/nginx.conf.example credforge:/tmp/credforge.app.conf
```

```bash
sudo install -m 644 /tmp/credforge.app.conf /etc/nginx/sites-available/credforge.app
sudo ln -s /etc/nginx/sites-available/credforge.app /etc/nginx/sites-enabled/credforge.app
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run
```

What the example does: redirects `http://` and `www.` to `https://credforge.app` (except
certbot's challenges, so renewals keep working); TLS 1.2 and 1.3; HSTS for two years (it hides the
app's own HSTS header so there's one); `client_max_body_size 10m`; passes `Host`,
`X-Forwarded-For` and `X-Forwarded-Proto`; a coarse flood guard (20 requests a second per
address, bursts up to 200, since whole schools share one address) that **never applies to
`/status/`** (the 1EdTech validator fetches the status list about 10 times per check), the images
or the static files; caches the content-addressed badge images and logos for 30 days in
`/var/cache/nginx/credforge-images`; and closes connections for any other host name. Until the app
runs, `https://credforge.app` answers 502.

`X-Forwarded-For` is **overwritten** with the client's address, not appended to: the app trusts
the first address in it (`TRUST_PROXY=true`), so a client must not be able to send its own.

## 7. First deploy

On your PC, from the repository (Docker Desktop running):

```bash
deploy/ship.sh credforge
```

It checks the droplet (Docker and Compose versions, `/opt/credforge`, `.env` with mode 600, disk
space), builds `credforge:<date>-<commit>` for `linux/amd64`, streams it with
`docker save | gzip | ssh credforge docker load`, copies `docker-compose.yml`, the backup scripts
and units, then tags the image `credforge:latest` on the droplet. It starts `db` and runs
`migrate` on its own, which creates the schema and the app's restricted role; only when that
succeeds does `docker compose up -d` (re)create `app` and `worker`, so a failed migration leaves a
running version running. It waits until the app is healthy and `/readyz` answers, prints
`docker compose ps`, and keeps the three newest images for rollbacks. It never reads `.env`.
`deploy/ship.sh --help` lists its options; with uncommitted changes the tag ends in `-dirty`. The
image is about 470 MB unpacked, about 105 MB to send.

Then check from your PC:

```bash
curl -sS https://credforge.app/readyz
curl -sSI https://credforge.app/ | grep -i strict-transport
```

## 8. The first platform admin

In **your own** SSH session (the command prints a one-time link to set the password, which is a
credential: don't paste it anywhere):

```bash
cd /opt/credforge
docker compose exec app node dist/cli.js create-platform-admin --email you@credforge.app
```

Open the link, set a password, and set up two-step verification. Platform admins approve new
organizations in **Platform** (`SIGNUP_MODE=approval`).

## 9. Sign-in with Google and Microsoft

Design plan §6.4 explains why each setting matters. Once both are set up, add their values to
`.env` and run `docker compose up -d`; the buttons appear on `/login` and `/signup`.

**Google Cloud** (console.cloud.google.com, a project named credforge → Google Auth Platform):

1. **Branding:** app name `credforge`, a support email, the logo (optional: a logo means Google
   reviews the branding), home page `https://credforge.app`, privacy policy
   `https://credforge.app/privacy`, terms `https://credforge.app/terms`, authorized domain
   `credforge.app`, a developer contact address.
2. **Audience:** External, then **Publish app** (to production). With only the basic scopes, no
   Google security review is needed.
3. **Data access:** only `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`.
4. **Clients → Create client:** Web application, name `credforge.app`, authorized redirect URI
   `https://credforge.app/api/auth/callback/google` (no JavaScript origins needed) →
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
5. Brand verification (Google shows the name and logo on the consent screen) needs proof that you
   own `credforge.app`: verify it in Google Search Console as a Domain property (a TXT record).

**Microsoft Entra** (entra.microsoft.com → App registrations → New registration):

1. Name `credforge`; supported account types **Accounts in any organizational directory and
   personal Microsoft accounts**; redirect URI, platform **Web**:
   `https://credforge.app/api/auth/callback/microsoft`.
2. **Overview** → Application (client) ID → `MICROSOFT_CLIENT_ID`; `MICROSOFT_TENANT_ID=common`.
3. **Certificates & secrets** → New client secret → its **Value** → `MICROSOFT_CLIENT_SECRET`.
   Secrets expire (24 months at most): put the date in your calendar, and rotate by adding a new
   secret, deploying it, then deleting the old one.
4. **Token configuration** → Add optional claim → ID → **`xms_edov`** (and `email`). Without
   `xms_edov` credforge sends its own confirmation email before a Microsoft account can be used.
5. **API permissions:** Microsoft Graph delegated `openid`, `profile` and `email` only (remove
   `User.Read` if it was added; credforge reads nothing from Graph).
6. **Branding & properties:** home page, terms and privacy URLs as for Google. Publisher
   verification (it needs a Microsoft Partner Network ID) removes the "unverified" label; it's
   optional.

Test both with a new account in a private window: sign up with Google, then with Microsoft (a
work or school account and a personal one), and check that an owner is asked for the second
factor after signing in with either.

## 10. Finish SendGrid: the signed Event Webhook

1. SendGrid → Settings → Mail Settings → **Event Webhooks** → Create: POST URL
   `https://credforge.app/api/webhooks/sendgrid`; events *Processed*, *Dropped*, *Deferred*,
   *Delivered*, *Bounced* and *Spam Reports*; turn on **Signed Event Webhook Requests**; save.
2. Copy its **verification key** into `.env` as `SENDGRID_WEBHOOK_PUBLIC_KEY` and run
   `docker compose up -d`. Without that key the endpoint doesn't exist (404).
3. Back in SendGrid, **Test Your Integration**. SendGrid sends sample events with a valid
   signature; `docker compose logs --since 5m app | grep "SendGrid"` shows a `SendGrid events` line
   with how many were received (the sample message IDs match no email, so none are applied). A
   `bad or missing signature` line means the key in `.env` isn't this webhook's.
4. Award a badge to yourself and watch it reach *Delivered* on the badge's screen.

## 11. Backups

`docs/restore-drill.md` has the details: `backup.env` (already copied in step 5), then the
nightly timer:

```bash
cd /opt/credforge
sudo cp deploy/systemd/credforge-backup.service deploy/systemd/credforge-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now credforge-backup.timer
sudo systemctl start credforge-backup.service && journalctl -u credforge-backup -n 20
bash deploy/restore.sh list
```

Also turn on DigitalOcean's weekly droplet backups (or take a snapshot before risky changes): they
bring back the whole machine, nginx and certificates included. Practise a restore after the first
deploy, as `docs/restore-drill.md` describes.

## 12. Check real credentials with the 1EdTech validator

The release gate (design plan §15): at https://vc.1ed.tech, choose Open Badges 3.0 and give it
URLs (it fetches them):

1. A credential page URL, `https://credforge.app/credentials/<id>`: no errors or warnings.
2. The same credential's `…/badge.png` and, for SVG artwork, `…/badge.svg`: the same.
3. A revoked credential: reported as revoked ("Credential has been revoked"), nothing else.

Each check fetches the credential once, the issuer's `url` once and the status list about ten
times; `docker compose logs app` should show 200s for all of them.

## Upgrades and rollbacks

- **Deploy a new version:** commit, then `deploy/ship.sh credforge` from your PC. `migrate` runs
  before the new `app` and `worker` start; if it fails, the script prints its output, the old
  containers keep running and `credforge:latest` points at the old image again.
- **Roll back** to an image the droplet still has (`docker image ls credforge`, or
  `/opt/credforge/deploy-history.log`): `deploy/ship.sh --no-build --tag <tag> credforge`.
  Migrations only go forward: rolling back across a release that changed the database can fail.
  Then restore the backup taken before the upgrade instead (`docs/restore-drill.md`).
- **Server-side changes to the compose file** go in `/opt/credforge/docker-compose.override.yml`
  (Compose reads it automatically). `ship.sh` overwrites `docker-compose.yml` on every deploy.
- **Rotating a Spaces or SendGrid key:** create the new key, put it in `.env`, run
  `docker compose up -d`, check, then delete the old key.

## Day to day

```bash
cd /opt/credforge
docker compose ps
docker compose logs -f --since 10m app worker
docker compose exec app node dist/cli.js help            # platform admins, status lists, …
systemctl list-timers credforge-backup.timer
df -h / && docker system df
sudo certbot certificates
```

- Logs are JSON (pino), rotated by Docker at 5 × 10 MB per container, and carry no secrets or
  personal data (design plan §14).
- The worker sends every email, issues CSV batches and re-signs status lists: if it's down,
  nothing is lost, and it catches up when it starts.
- After an abuse report (phishing, impersonation), a platform admin suspends the organization in
  **Platform** (its public pages then say so), and if its badges must stop verifying,
  `docker compose exec app node dist/cli.js revoke-org-credentials --org <id> --reason "…"`
  (without `--yes` it only counts them). Images stay cached in nginx; empty the cache with
  `sudo rm -rf /var/cache/nginx/credforge-images/*` if one has to disappear.
- A request to delete a recipient's data (to the privacy address) goes to the organization that
  awarded the badge: its owners and admins use **Erase this person's data** on one of the badges.
  If the organization doesn't answer, or is suspended,
  `docker compose exec app node dist/cli.js erase-recipient --org <id> --email <address>` shows
  what it would erase, and `--yes` erases it (design plan §12.1). Each erasure leaves a small
  record under `erasures/` in the `credforge-prod` bucket: keep it, so restores re-apply erasures.
- Someone who can't get past two-step verification (you included): see
  [Lost access to two-step verification](#lost-access-to-two-step-verification) below. The last
  resort is `docker compose exec app node dist/cli.js reset-two-factor --email <address>`, never
  editing the database by hand.

## Troubleshooting

| Symptom | Look at |
|---|---|
| `ship.sh` stops at the checks | It names the problem: the docker group (log out and in again after `usermod`), `/opt/credforge`, `.env`'s mode, disk space |
| `https://credforge.app` answers 502 | `docker compose ps`; `docker compose logs app migrate` |
| The app won't start | The first log line names the setting that is missing or malformed |
| Emails don't arrive | `docker compose logs worker`; SendGrid → Activity; Domain Authentication still verified |
| A 429 from nginx | Someone is hitting the flood guard; raise `burst` in the nginx file if it's legitimate |
| Sign-in with Google or Microsoft fails | The redirect URI must match exactly (`https`, no trailing slash); `docker compose logs app` |
| Certificate renewal fails | `sudo certbot renew --dry-run`; the port 80 server must still serve `/.well-known/acme-challenge/` from `/var/www/html` |
| Two-step codes refused, or "too many failed verification attempts" | [Lost access to two-step verification](#lost-access-to-two-step-verification), next |

### Lost access to two-step verification

Go through these in order. Resetting is the last step, because it also removes the protection.

1. **Locked out after wrong codes.** One sign-in accepts 5 wrong codes; after that, sign in with
   the password again. After **10 wrong codes in a row** (across sign-ins, authenticator and
   backup codes together) the account's two-step verification is **locked for 15 minutes**, even
   for the right code. Wait 15 minutes; the lock clears itself, and the next right code resets the
   count. Separately, each address may try 10 codes a minute (`AUTH_RATE_LIMIT`).
2. **The right authenticator entry.** Entries added since decision 55 are named after the site,
   `credforge (credforge.app)` (a development copy's are `credforge (localhost)`). Older ones are
   all just `credforge`, so an entry from a development or test instance looks exactly like the
   production one: try each `credforge` entry, then rename the one that works (most apps allow
   it).
3. **A backup code.** On the code screen choose **Use a backup code instead**. Each of the ten
   codes saved when two-step verification was turned on works once, and only on the site that
   issued them. Once in, make new ones under **Account settings → New backup codes**.
4. **The clock.** A code is only valid for its 30 seconds; credforge also accepts the one before
   and the one after. The phone must set its time automatically. On the droplet,
   `timedatectl` must say `System clock synchronized: yes` (Debian's `systemd-timesyncd`; the
   containers use the host's clock). Off by more than about a minute, every code fails.
5. **`AUTH_SECRET` must never change.** It encrypts every two-step secret and backup code, and
   signs sessions. With a different `AUTH_SECRET` everyone is signed out and **nobody** can pass
   two-step verification. Don't reset everyone: put the original value back from your offline copy
   (step 5 of the setup), run `docker compose up -d`, and the old entries and codes work again.
   Only if the original is truly lost, reset each account that had two-step verification on.
6. **Reset it** (the last resort), in your own SSH session:

   ```bash
   cd /opt/credforge
   docker compose exec app node dist/cli.js reset-two-factor --email you@credforge.app
   ```

   It deletes the account's two-step secret and backup codes (which also clears a lock), turns
   two-step verification off and ends all of its sessions. The password and Google or Microsoft
   sign-in stay. It writes `user.two_factor_reset` to the audit log (the address, how many
   sessions ended and whether it was locked; no secrets), which editing the database by hand
   would bypass. An address without an account is refused; one without two-step verification is
   left as it was. Then sign in: with `REQUIRE_MFA_FOR_ADMINS=true`, owners, admins and platform
   admins go straight to setting it up again. Scan the new QR code, delete the old entry from the
   authenticator app, and save the new backup codes.

   **For someone else, first make sure it's really them** through a channel you already trust
   (not just an email from the address): a reset is exactly what someone who has stolen a password
   would ask for.
