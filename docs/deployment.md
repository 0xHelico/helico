# Deployment

Three applications on one VPS, behind one nginx, managed by Coolify. This file exists because
the interesting part is not how they are built — it is **where**.

## Where each image is built

| | Image built in Actions | Pushed to GHCR | Workflow |
|---|---|---|---|
| `apps/app` | yes | `ghcr.io/0xhelico/helico-app` | `.github/workflows/app-deploy.yml` |
| `apps/landing` | yes | `ghcr.io/0xhelico/helico-landing` | `.github/workflows/landing-deploy.yml` |
| `apps/be` | yes | `ghcr.io/0xhelico/helico-be` | `.github/workflows/be-deploy.yml` |

Each workflow builds, pushes, and then asks the VPS to redeploy over SSH with a key restricted to
a single forced command. The Coolify API token never leaves the box (#108).

## Why the builds are not on the VPS

On 7 September the machine was hard-killed twice inside half an hour, and the second time it
stayed down for 41 minutes until somebody pressed the button.

What the journal did **not** contain is what makes this diagnosable: no shutdown sequence, no OOM
kill, no kernel panic, no I/O error, no watchdog. Memory was 2.1 GB of 7.8 GB with no swap in use.
A guest cannot power itself off without leaving a trace, so the VM was stopped from outside — it
is a KVM guest on Proxmox.

Both deaths followed buildkit builds by three to eight minutes, alongside
`healthcheck failed actualDuration=15.8s timeout=15s` and `copy stream failed`. That is I/O
starvation, not an application fault.

The important part is that **it is a loop, not two incidents**: a reboot makes Coolify rebuild its
applications, and the rebuild kills the box again. Boot 12:55 → builds 13:06 → dead 13:15. The
machine had been up continuously from 30 August to 7 September; what changed was that heavy builds
started running on it.

Full findings in #103.

## The half that is not in this repository

**Building the image in Actions accomplishes nothing on its own.** If a Coolify application is
still configured with a Git source, Coolify rebuilds it on the VPS when asked to redeploy, and the
published image is simply ignored — two builds instead of one, with the harmful one unchanged.

So each application in Coolify has to be switched to a **Docker Image** source:

| Field | Value |
|---|---|
| Source | Docker Image |
| Image | `ghcr.io/0xhelico/helico-app:latest` (or `-landing`, `-be`) |
| Registry | `ghcr.io`, with a read-only PAT if the packages are private |

Two things to carry across when switching, because they do not follow the source change:

- **`apps/be` has a volume.** `VOLUME /data` holds the SQLite file. A new application pointed at
  the image without that volume starts with an empty database.
- **`apps/app` bakes `NEXT_PUBLIC_*` at build time**, not at run time. They are build arguments in
  `apps/app/Dockerfile` with defaults, so a value set only in Coolify's environment **will not
  reach the browser bundle**. The ones the app reads are `NEXT_PUBLIC_ACCOUNT_FACTORY` (a
  default in code, since a deployed address is public) and `NEXT_PUBLIC_BE_API_URL`. Setting
  either means rebuilding, not restarting.

## How to tell whether the move actually happened

The point of the change is that **no build runs on the VPS**. After switching a source, redeploy
and watch:

```bash
# On the VPS, during a redeploy. Nothing should appear.
journalctl -f | grep -i buildkit
```

If buildkit still runs, the application is still on a Git source whatever the workflow does.

## Verifying an image before trusting it

Both of these were run against `apps/be` before this was written, and neither is expensive:

```bash
docker build -f apps/be/Dockerfile -t helico-be:check .
docker run -d --name be-check -p 18787:8787 helico-be:check
curl -s http://127.0.0.1:18787/healthz     # {"status":"ok"}
curl -s http://127.0.0.1:18787/api/posts   # content is in the image, not just the binary
docker rm -f be-check
```

The second request is the one worth keeping. `apps/be` copies `content/` in a second stage, and
`.dockerignore` excludes `*.md` with an exception for exactly that directory — so a healthy
`/healthz` and an empty `/api/posts` is a plausible outcome that a health check alone would miss.

## What is still open

The VPS is a KVM guest on Proxmox. If the hypervisor stops the VM under I/O pressure, and some of
that pressure belongs to a neighbour rather than to us, then moving our builds off helps without
making the box reliable. Whether this machine is dedicated or shared is not recorded anywhere, and
it changes what can honestly be promised about a live demo.
