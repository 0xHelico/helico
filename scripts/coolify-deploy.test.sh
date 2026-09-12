#!/usr/bin/env bash
# The branches of `coolify-deploy.sh`'s timeout message, against the real function.
#
# Why this file exists: that message had two branches and the first was unreachable. It grepped
# `/deployments` for `in_progress`, and the deploy token carries `deploy` without `read`, so the
# endpoint answers `Missing required permissions` and the grep never matched — every timeout since
# it was written printed "Coolify reports no deployment in progress", whatever Coolify thought. On
# 12 September that was true by luck; a slow build would have printed the same words.
#
# So the thing to test is not the wording. It is that **each branch can be reached**, including
# the one that fires in production today.
#
#   bash scripts/coolify-deploy.test.sh
set -uo pipefail

# shellcheck source=./coolify-deploy.sh
COOLIFY_DEPLOY_SOURCE_ONLY=1 . "$(dirname "$0")/coolify-deploy.sh"

fail=0
want() {
	local expect="$1" body="$2" got
	got="$(timeout_reason "$body")"
	case "$got" in
		*"$expect"*) printf '  ok  %-22s <- %s\n' "$expect" "${body:0:44}" ;;
		*) printf 'FAIL  %-22s <- %s\n      got: %s\n' "$expect" "${body:0:44}" "$got"; fail=1 ;;
	esac
}

# curl failed, or the API returned nothing at all.
want "could not be reached"     ""
# What it actually answers today, and the reason the old branch was dead.
want "lacks the"                '{"message":"Missing required permissions: read"}'
# What it answers with the `read` scope granted and a build still running.
want "slow, not stuck"          '[{"status":"in_progress","uuid":"abc"}]'
# And with the scope granted and nothing running: the only case the old code ever printed.
want "stuck rather than slow"   '[{"status":"finished","uuid":"abc"}]'
want "stuck rather than slow"   '[]'

if [ "$fail" -ne 0 ]; then
	echo "a branch of the timeout message is unreachable or says the wrong thing" >&2
	exit 1
fi
echo "every branch of the timeout message is reachable"
