#!/usr/bin/env bash
# The one command a GitHub runner may run on the VPS.
#
# The deploy key's line in ~/.ssh/authorized_keys forces this script, with no pty and no
# forwarding, so whatever a runner sends arrives as $SSH_ORIGINAL_COMMAND and the only thing it
# can choose is which application to redeploy. The Coolify token stays on the server.
#
# Installed at ~/bin/coolify-deploy. This copy is the source of truth: it is here to be
# reviewed, and it is what the server runs.
#
# It waits for the deploy rather than trusting the queue: a container that never came up used to
# leave the workflow green, which is the failure this repository has already had once on the CRE
# path — a queued job and a successful transaction are not evidence that anything happened.
set -euo pipefail

# Application ids and their addresses live on the server, not in a public repository:
#   landing nfec…  3022  https://helico.site/
#   automation uvvp…  -  -
# one line per application: name, Coolify uuid, published loopback port, a URL that must answer.
# A worker publishes nothing and serves nothing, so both are `-`: it is found by container name,
# and the check is that the new container is still running a little later rather than
# crash-looping.
MAP="$HOME/.config/coolify/apps.map"
TOKEN_FILE="$HOME/.config/coolify/deploy.token"
API="http://127.0.0.1:8000/api/v1"
# Generous on purpose. Ten minutes was enough until a deploy landed on a box at load 31 with a
# `next-build` at 314% CPU, and the image came out after the wait had already called it a failure.
# The cost of waiting too long is a slow pipeline; the cost of giving up too early is a red run for
# a deploy that worked, which teaches everyone to stop reading them.
TIMEOUT_SECONDS=1500

app="${SSH_ORIGINAL_COMMAND:-}"
read -r _ uuid port url < <(awk -v a="$app" '$1 == a {print; exit}' "$MAP") || true
if [ -z "${uuid:-}" ]; then
	echo "unknown app: ${app:-<none>}" >&2
	exit 2
fi

container() {
	if [ "$port" = "-" ]; then
		docker ps -q --filter "name=$uuid" | head -1
	else
		docker ps -q --filter "publish=$port" | head -1
	fi
}

# Give the build room before asking for one.
#
# Coolify builds on this box rather than pulling the image CI already publishes, so every deploy
# is a `bun install` and a compile here. On 9 September the disk was at 84% with 6.8 GB of
# reclaimable build cache, and the VM was stopped mid-build (#103). A full disk does not cause
# that on its own, but building on one is the worst version of it.
#
# Reclaimable cache only: `builder prune` never touches a running container, an image in use, or
# a volume. Other applications share this host and their data is not ours to decide about.
disk() { df --output=pcent / | tr -dc '0-9'; }

used="$(disk)"
if [ "${used:-0}" -ge 70 ]; then
	echo "$app: disk at ${used}%, reclaiming build cache first"
	# Age first, because a warm cache is worth keeping when it costs nothing. It often frees
	# nothing here: this box builds all day, so almost every entry is younger than two days —
	# measured on 9 September, when `until=48h` returned 0B against 7.9 GB of reclaimable cache.
	docker builder prune --force --filter 'until=48h' 2>&1 | tail -1
	if [ "$(disk)" -ge 70 ]; then
		# Everything not in use, then. A cold cache costs one slower build; a full disk costs
		# every application on the host.
		docker builder prune --force 2>&1 | tail -1
	fi
	echo "$app: disk now at $(disk)%"
fi

# And refuse rather than start one that will not fit. A deploy that fails here leaves the running
# container serving; a build that fills the disk takes the box down with every other application
# on it.
used="$(disk)"
if [ "${used:-0}" -ge 92 ]; then
	echo "$app: disk at ${used}%, refusing to build. Free space and deploy again." >&2
	exit 3
fi

before="$(container)"

curl --fail --silent --show-error -X POST \
	-H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
	"$API/deploy?uuid=$uuid&force=false" >/dev/null
echo "$app: deployment queued"

deadline=$((SECONDS + TIMEOUT_SECONDS))
while [ "$SECONDS" -lt "$deadline" ]; do
	sleep 10
	now="$(container)"
	# A new container id is what says the build finished and replaced the old one; the old one
	# answers 200 all the way through a failed deploy.
	[ -n "$now" ] && [ "$now" != "$before" ] || continue
	if [ "$url" = "-" ]; then
		# Nothing to ask, so the question is whether it stayed up rather than crash-looped.
		sleep 15
		if [ "$(docker inspect -f '{{.State.Running}}' "$now" 2>/dev/null)" = "true" ]; then
			echo "$app: a new container has been running for 15s after $((SECONDS))s"
			exit 0
		fi
		echo "$app: the new container did not stay up" >&2
		exit 1
	fi
	code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || true)"
	if [ "$code" = "200" ]; then
		echo "$app: serving from a new container, $url answered 200 after $((SECONDS))s"
		exit 0
	fi
done

# Say which of the two this is. "No new container" reads as broken and is usually still building,
# and Coolify knows the difference: its own deployment row is the answer. Asking costs one call and
# turns a bare failure into one a reader can act on.
state="$(curl --silent --max-time 10 -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
	"$API/deployments" 2>/dev/null | grep -o "\"status\":\"in_progress\"" | head -1 || true)"
if [ -n "$state" ]; then
	echo "$app: no new container within ${TIMEOUT_SECONDS}s, and Coolify still reports a deployment in progress — slow, not stuck. The build will land without another push." >&2
else
	echo "$app: no new container within ${TIMEOUT_SECONDS}s, and Coolify reports no deployment in progress. This one is stuck rather than slow." >&2
fi
exit 1
