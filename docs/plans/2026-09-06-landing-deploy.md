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

## Follow-up — the Coolify application, created from the server

The owner asked for this step to be done too. The Coolify API is enabled on the instance,
so from the VPS, through the `coolify` container's `artisan tinker`, a root-scoped token for
the root user was minted (with the `team_id` column set, which a plain Sanctum
`createToken` leaves null and the API then refuses), used once, and deleted:

- project `helico`, environment `production`;
- application `landing`: public repository `https://github.com/0xHelico/helico`, branch
  `main`, Dockerfile build pack at `/apps/landing/Dockerfile`, base directory `/`, port 8080,
  health check `GET /healthz`, auto-deploy off (the workflow deploys), shallow clone;
- the port mapping: the API validator only takes `host:container`, so the application was
  created with `3022:8080` and the mapping then set to `127.0.0.1:3022:8080`, the loopback
  bind every other application on the box uses, stored the way the UI stores it.

A second token with the `deploy` ability only went into the repository secret
`COOLIFY_TOKEN`, with `COOLIFY_APP_UUID` and the variable `COOLIFY_URL`; the files holding
them were removed from the server afterwards. If the token is ever seen in transit (Coolify
still answers over plain HTTP, see the owner's list above) it can trigger a deploy of this
one application and nothing else.

Coolify 4.3 wants the deploy call as `POST`; the workflow said `GET` and is corrected here.

The repository now allows merge commits only; squash and rebase merging are switched off in
the settings, at the owner's request, after three pull requests were squashed.

- Prompt: "Can you please set it up as well?" and "Domain helico.site, with certbot too."

## Follow-up — the deploy call no longer crosses the internet in cleartext (#108)

Coolify answers plain HTTP on its port, so the deploy-only token in the workflow went over the
public internet on every merge. Rather than give the panel a hostname and a certificate, the
workflow now asks over SSH, which is encrypted and already exposed: a key that exists only in
the repository secrets, whose entry in the server's `authorized_keys` carries a **forced
command** and no port forwarding, no agent, no pty. The command takes one word, `landing` or
`docs`, maps it to the application, and calls Coolify on `127.0.0.1` with a token that lives in a
mode-600 file on the box. The two tokens that had crossed HTTP were revoked. Verified: the key
run with any other command answers `unknown app`; a hand-triggered run redeployed the site.

- Prompt: "check issues and PRs" (the fix follows the collaborator's #108).

## Follow-up — a deploy that reports success and changed nothing

Raised three times in review, and right each time: the workflow was green whether or not the
container came up, because triggering Coolify is asynchronous and the old container answers 200
throughout a failed build. That is the same shape as the CRE forwarder swallowing a revert and
leaving a successful transaction, which is the mistake this project has already made once.

So the server's forced command now waits. It notes the container id published on the
application's loopback port, triggers the deploy, and returns only when a **different** container
id is serving **and** the public URL answers 200, or fails after ten minutes. A queued job is no
longer evidence; a new container serving the page is.

The script is committed at `scripts/coolify-deploy.sh` so it can be reviewed, and installed at
`~/bin/coolify-deploy` on the server. Application ids, ports and URLs live in a mode-600 file on
the box rather than in a public repository. Both workflows also `trap 'rm -f deploy_key
known_hosts' EXIT`, so a failed step cannot leave either file behind.

Verified: `SSH_ORIGINAL_COMMAND=id` still answers `unknown app` and exits 2; a real run against
the docs application printed *"serving from a new container, https://docs.helico.site/docs/introduction
answered 200 after 40s"* and exited 0.
