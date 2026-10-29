# Deploying the monitor

Written for whoever sets this up or keeps it running.

**What goes where**

| Piece | Host | Cost |
|---|---|---|
| Dashboard (React build) | Netlify | free |
| API + scheduler + Chromium | Oracle Cloud VM | free (Always Free tier) |
| Database + sign-in | Supabase | free |

The backend has to be one always-on process: the scheduler is an in-memory
timer, the Reddit rate limiter spaces requests ≥700 ms apart in process memory,
and html mode keeps a Chromium warm between checks. That is why it is a VM and
not a serverless function.

**Before you start you need:** an Oracle Cloud account, a Supabase project with
the migrations in `supabase/` already run, a GitHub repo with this code pushed,
and a domain name (a free one works — see step 2).

---

## 1. Create the VM

In the Oracle console: **Compute → Instances → Create instance**.

- **Shape:** change it to **Ampere / VM.Standard.A1.Flex**, 2 OCPU and 12 GB RAM.
  That sits inside the Always Free allowance (4 OCPU / 24 GB total) and leaves
  Chromium plenty of room. The other always-free shape, `E2.1.Micro`, has 1 GB
  and will be killed by the kernel the moment Chromium starts — don't use it.
- **Image:** Ubuntu 22.04 or 24.04.
- **SSH keys:** upload your public key, or let Oracle generate one and save it.

If you get *"Out of host capacity"*, that is Oracle's free ARM pool being full
in that availability domain. Try the other availability domains, or another
region. It often succeeds on a retry later in the day.

SSH in once it is running:

```bash
ssh ubuntu@<your-vm-public-ip>
```

### Open the firewall — both of them

This is the step that eats afternoons. **Oracle VMs have two independent
firewalls and you must open both.**

**(a) Cloud side.** In the console, open your instance → click its **subnet** →
click the **security list** → **Add ingress rules**. Add two, both with source
CIDR `0.0.0.0/0`, IP protocol TCP, destination port `80` and `443`.

**(b) The VM's own iptables.** Ubuntu images on Oracle ship with everything but
SSH blocked locally:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

(On an Oracle Linux image it is firewalld instead:
`sudo firewall-cmd --permanent --add-port=80/tcp --add-port=443/tcp && sudo firewall-cmd --reload`)

### Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Log out and back in so the group membership applies.

---

## 2. Point a domain at the VM

The dashboard is served over HTTPS, and a browser will not let an HTTPS page
call a plain-HTTP API. So the backend needs a real certificate, and that needs
a hostname — a bare IP will not do.

- **If you own a domain:** add an `A` record, e.g. `api.yourdomain.com` → your
  VM's public IP.
- **If you don't:** [duckdns.org](https://duckdns.org) gives you a free
  subdomain such as `yourname.duckdns.org`. Sign in, create one, and set its IP
  to the VM's.

Check it resolves before continuing: `dig +short api.yourdomain.com`

---

## 3. Deploy the backend

```bash
git clone https://github.com/<you>/<your-repo>.git
cd <your-repo>
```

Create `server/.env` (this file is gitignored and must never be committed):

```bash
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
SUPABASE_ANON_KEY=<anon key>

REDDIT_MODE=html
CHECK_INTERVAL_MINUTES=60

# Teammates are invited from the dashboard (Settings -> Team access), so this
# list is just the owners: the people who may invite and remove others.
AUTH_ADMIT_INVITED=true
AUTH_ALLOWED_EMAILS=you@example.com
# Filled in at step 5, once Netlify has given you a URL.
ALLOWED_ORIGINS=
```

Create `.env` next to `docker-compose.yml` for the proxy:

```bash
API_DOMAIN=api.yourdomain.com
ACME_EMAIL=you@example.com
```

Start it:

```bash
docker compose up -d --build
```

The first build takes several minutes — it downloads Chromium. Then check it
from your laptop:

```bash
curl https://api.yourdomain.com/api/health
# {"ok":true,"service":"reddit-monitor"}
```

If that works you have a valid certificate and both firewalls are open. If it
hangs, the firewall is the cause nine times out of ten — recheck step 1.

Confirm sign-in is actually enforced:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.yourdomain.com/api/accounts
# 401
```

A `401` is correct and is what you want to see.

---

## 4. Turn on GitHub sign-in

Two places have to agree, which is the usual source of "redirect_uri_mismatch".

**(a) GitHub** → *Settings → Developers → OAuth Apps → New OAuth App*. The
**Redirect URI** (older wording: "Authorization callback URL") must be exactly:

```
https://<your-project-ref>.supabase.co/auth/v1/callback
```

Register it, copy the **Client ID**, then **Generate a new client secret** and
copy that too — GitHub shows the secret only once.

**(b) Supabase** → *Authentication → Sign In / Providers → GitHub*: enable it
and paste the client ID and secret. Then under *Authentication → URL
Configuration* set **Site URL** to your Netlify URL and add it to **Redirect
URLs** as well, or sign-in will bounce to the wrong address.

> GitHub is used because it needs no cloud console and no payment method. Any
> provider Supabase supports works the same way — only the client code's
> provider name would change.

---

## 5. Deploy the dashboard to Netlify

Netlify → **Add new site → Import an existing project** → pick your repo.
`netlify.toml` already sets the build command and publish directory, so leave
those alone.

Under **Site configuration → Environment variables**, add three:

| Variable | Value |
|---|---|
| `VITE_API_BASE` | `https://api.yourdomain.com/api` |
| `VITE_SUPABASE_URL` | `https://xxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | your anon key |

These are read at build time, so **trigger a redeploy after adding them** or
they will not take effect. The anon key being public is fine and by design —
every table has row-level security on with no browser policies, so it grants no
data access on its own.

---

## 6. Connect the two and verify

Back on the VM, fill in the origin you just got and restart:

```bash
# in server/.env
ALLOWED_ORIGINS=https://your-site.netlify.app

docker compose up -d api    # recreates the container so the new value is read
```

Then open your Netlify URL. You should get the sign-in screen, ask for a
sign-in link by email (or use GitHub), and land in the dashboard with your
accounts loaded.

If the dashboard loads but data does not, open the browser console. A CORS
error means `ALLOWED_ORIGINS` does not exactly match your Netlify origin
(no trailing slash). A 403 means that address has no access — see below.

### Adding a teammate

Settings -> Team access -> invite them by email. They get a sign-in link, and
that is the whole of it: no `.env` edit, no redeploy, no restart. Removing them
there revokes access on their next request.

This works because `AUTH_ADMIT_INVITED=true` admits anyone Supabase reports as
invited (`invited_at`), which a self-signup never has — so leaving public
sign-ups enabled in Supabase does not open the workspace.

`AUTH_ALLOWED_EMAILS` still admits the addresses listed in it. Keep your own
there: owners are defined by that list, only owners can invite or remove, and
it is the way back in if the Supabase user list is ever lost.

> **Set up custom SMTP before inviting more than one or two people.** Supabase's
> built-in email sender allows only a few messages an hour and is not meant for
> production, so invites simply stop arriving. Project Settings ->
> Authentication -> SMTP. An invite refused for this reason returns 429 and says
> so.

---

## Running it

```bash
docker compose logs -f api      # follow the API log
docker compose up -d api        # apply an .env change (see note below)
git pull && docker compose up -d --build   # deploy new code
docker compose ps               # check both containers are up
```

> **Use `up -d`, not `restart`, after editing `server/.env`.** Environment
> variables are read when a container is *created*, so `docker compose restart`
> reuses the old values and your change silently does nothing. `up -d` recreates
> the container when the config has changed. Confirm it took with:
> `docker compose exec api printenv ALLOWED_ORIGINS`

**Things worth knowing**

- **Never run more than one `api` container.** No `--scale`, no second VM
  pointing at the same database. The Reddit rate limiter and the "already
  checking this account" guard live in process memory, so a second instance
  doubles your request rate at Reddit and runs duplicate checks — the exact
  bot-like pattern this tool exists to avoid.
- **Oracle reclaims idle Always Free VMs.** They look at CPU, network and
  memory over a 7-day window. This service is light, so if you get a reclaim
  warning, the usual fix is to upgrade the account to Pay As You Go — Always
  Free resources stay free on that account type and become exempt from
  reclamation.
- **Netlify deploy previews get their own URLs** (`deploy-preview-3--site…`)
  which are not in `ALLOWED_ORIGINS`, so data will not load there. That is
  expected; use the production URL, or add preview origins if you need them.
- **Certificates renew themselves.** Caddy handles it, as long as port 80 stays
  open — it is needed for the renewal challenge, not just the first issue.
- **Backups:** all real data is in Supabase, not on the VM. The VM holds only
  the code and the certificates, both reproducible.
