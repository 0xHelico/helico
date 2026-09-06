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
# one line per application: name, Coolify uuid, published loopback port, a URL that must answer.
MAP="$HOME/.config/coolify/apps.map"
TOKEN_FILE="$HOME/.config/coolify/deploy.token"
API="http://127.0.0.1:8000/api/v1"
TIMEOUT_SECONDS=600

app="${SSH_ORIGINAL_COMMAND:-}"
read -r _ uuid port url < <(awk -v a="$app" '$1 == a {print; exit}' "$MAP") || true
if [ -z "${uuid:-}" ]; then
	echo "unknown app: ${app:-<none>}" >&2
	exit 2
fi

before="$(docker ps -q --filter "publish=$port" | head -1)"

curl --fail --silent --show-error -X POST \
	-H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
	"$API/deploy?uuid=$uuid&force=false" >/dev/null
echo "$app: deployment queued"

deadline=$((SECONDS + TIMEOUT_SECONDS))
while [ "$SECONDS" -lt "$deadline" ]; do
	sleep 10
	now="$(docker ps -q --filter "publish=$port" | head -1)"
	# A new container id is what says the build finished and replaced the old one; the old one
	# answers 200 all the way through a failed deploy.
	[ -n "$now" ] && [ "$now" != "$before" ] || continue
	code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || true)"
	if [ "$code" = "200" ]; then
		echo "$app: serving from a new container, $url answered 200 after $((SECONDS))s"
		exit 0
	fi
done

echo "$app: no new container answering $url within ${TIMEOUT_SECONDS}s" >&2
exit 1
