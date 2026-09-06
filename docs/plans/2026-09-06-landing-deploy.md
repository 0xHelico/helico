# Landing: container, VPS, and a deploy on every merge

Issue: #100. Branch `build/landing-deploy`. The user asked for the landing to be deployed to
their VPS with CI/CD, through Coolify and Docker, and for the server's security to be checked
first.

## Security survey, before touching anything

Read-only, over the existing SSH alias, as the unprivileged deploy user. What the box is:
Ubuntu 22.04.5, kernel 5.15, 8 cores, 7.8 GiB, 19 GB free. Coolify 4.3.15 already installed
with a dozen applications, Docker 29, host nginx 1.18 doing TLS for every site, certbot run
as the user against a webroot under the home directory, renewal in cron with a sudo-permitted
nginx reload.

| Check | Result | Action |
|---|---|---|
| SSH password login | Off: a password attempt is refused with `Permission denied (publickey)` | none |
| Root login | `prohibit-password` | none |
| Firewall | ufw active (rules not readable without root) | ask the owner to confirm 8000, 6001-6002, 25, 3010, 3011, 8080, 3000, 4200 are meant to be open |
| fail2ban, unattended-upgrades | active | none |
| Pending reboot | yes, a kernel update is waiting | owner's call; it restarts every container |
| Coolify UI | on `0.0.0.0:8000`, plain HTTP, reachable from the internet | put it behind nginx with TLS on a hostname and close 8000 in ufw (needs root) |
| Coolify realtime | `0.0.0.0:6001-6002` | same treatment as the UI |
| Postfix | listening on the public `:25`, relay for loopback only (not an open relay) | `inet_interfaces = loopback-only` unless mail is meant to come in (needs root) |
| Two Coolify apps | published on `0.0.0.0:3010` and `:3011` instead of `127.0.0.1` | change the port mapping in Coolify if nginx fronts them |
| Bare processes | a Bun API and two Next servers run **as root** on the host, on public `:8080`, `:3000`, `:4200` | move them into Coolify or a systemd unit as a user, bind to 127.0.0.1 behind nginx |
| Deploy user | in `sudo` (password) and `docker` (root-equivalent) groups; passwordless sudo only for nginx site files, `nginx -t`, reload | fine for a single-admin box; the docker group is the real power |
| The laptop's SSH config | `StrictHostKeyChecking no` for this host | **fixed**: removed, the host key was already in `known_hosts`, login re-verified |

Nothing above blocks the deploy. The items marked "needs root" are the owner's to run; the
commands are in the pull request.

## What was done on the server

Within the deploy user's granted rights only:

1. `/etc/nginx/sites-available/helico.site`, first with port 80 and the ACME webroot, so the
   challenge could be answered.
2. `certbot certonly --webroot` as the user, the same way every other site on the box gets
   its certificate; `helico.site` and `www.helico.site` on one certificate, expiring
   2026-12-05, renewed by the existing cron.
3. The full site: 80 → 301 to `https://helico.site`, `www` → 301 to the apex, HSTS, and a
   proxy to `127.0.0.1:3022`, the port the Coolify application will publish. Until that
   application exists the hostname answers 502 over valid TLS.

DNS already pointed `helico.site`, `www`, `app`, `docs` and `api` at the VPS (Cloudflare
nameservers, records not proxied), so nothing to change there.

## The image

`apps/landing/Dockerfile`, built from the repository root because the page reads the vault
source, the contract tests and the blog posts at build time. Stage one: Bun 1.3.14 installs
the workspace and builds the landing. Stage two: `nginx-unprivileged` serves `dist/` on 8080
as a non-root user, with `try_files` for Astro's directory URLs, gzip, a year of `immutable`
cache on `/_astro/`, `must-revalidate` on pages, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy`, a Content-Security-Policy that allows only the site,
inline scripts and styles (Astro inlines both), and Google Fonts; `/healthz` for the
container's health check. `.dockerignore` keeps `.git`, `node_modules`, build outputs and
every `.env` out of the context.

Built and run on the VPS itself on a private port, checked and removed: every route 200,
`/nope` 404, gzip on, immutable on hashed assets, headers present, process user `nginx`,
health `healthy`. The laptop's Docker daemon was not running, which is why the check moved
to the server.

## The deploy

`.github/workflows/landing-deploy.yml`: on every push to `main` touching the landing or what
it reads, build the image and publish it to `ghcr.io/0xhelico/helico-landing` (`latest` and
the commit SHA), then, if the repository variable `COOLIFY_URL` and the secrets
`COOLIFY_APP_UUID` and `COOLIFY_TOKEN` are set, call Coolify's deploy endpoint. Coolify
pulls the image and restarts the container; nginx on the host keeps serving.

The Coolify application itself has to be created once, in the UI or through the API with a
token that only the UI can mint, so that step is the owner's: a Docker-image resource
pointing at `ghcr.io/0xhelico/helico-landing:latest`, port 8080, published on
`127.0.0.1:3022`. The pull request lists the exact fields.

## Prompt, verbatim in translation

- "Deploy the landing page to my VPS (`ssh cuyvps`) and give it CI/CD; later use Coolify and
  Docker, and make sure of the security first."
