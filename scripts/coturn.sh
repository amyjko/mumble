#!/usr/bin/env bash
# A local TURN server, so the relay path can be tested at all (AR-TRANSPORT-8).
#
# Every other media test runs on loopback, where a direct path always wins and
# the relay code never executes. `iceTransportPolicy: 'relay'` forces the issue
# — but only if there is something to relay through.
#
# NATIVE rather than Docker, and that is not a preference. On macOS, Docker's
# published UDP ports rewrite source addresses and host networking routes into
# the VM, so neither reaches a browser on the host; measured both, neither
# worked. Running the same binary the same way everywhere also means CI
# exercises the path a developer just debugged, rather than a second
# configuration nobody looks at.
set -euo pipefail

SECRET="mumble-local-turn-secret"
PORT=3478

# Install it rather than telling somebody to. A prerequisite documented in prose
# is a step that drifts: the local instruction and the CI one were separate, and
# CI's silently installed a SERVICE that owned :3478 and broke the suite. One
# script both use cannot drift from itself.
#
# Not an npm devDependency, which was the obvious idea and does not work: the
# pure-JS TURN servers on npm do not relay. `turn-server` authenticates our REST
# credentials correctly and reports an allocation with a relay address, then
# never binds a relay socket — measured, one UDP listener and nothing else — so
# ICE gets a candidate pointing at nothing. A relay layer needs something that
# actually relays.
if ! command -v turnserver >/dev/null 2>&1; then
	echo "coturn not found; installing it (one-time)..." >&2
	if command -v brew >/dev/null 2>&1; then
		brew install coturn >&2
	elif command -v apt-get >/dev/null 2>&1; then
		sudo apt-get update >&2 && sudo apt-get install -y coturn >&2
	else
		echo "No brew or apt-get. Install coturn manually and re-run." >&2
		exit 1
	fi
fi

if ! command -v turnserver >/dev/null 2>&1; then
	echo "coturn still not on PATH after install." >&2
	exit 1
fi

# Idempotent: re-running must not leave two servers fighting over a port.
pkill -f "turnserver.*${SECRET}" 2>/dev/null || true

# Debian's coturn package starts a SYSTEM service on install, which owns 3478
# with the distro's default config — no shared secret, no loopback peers. Ours
# then fails to bind and the relay tests fail for reasons that look nothing like
# a port conflict. Stop it if it is there.
if command -v systemctl >/dev/null 2>&1; then
	sudo systemctl stop coturn 2>/dev/null || true
fi
sleep 1

turnserver -n --log-file=stdout \
	--use-auth-secret --static-auth-secret="${SECRET}" \
	--realm=mumble.test --no-tls --no-dtls --fingerprint \
	--listening-port="${PORT}" --min-port=49160 --max-port=49180 \
	--listening-ip=127.0.0.1 --relay-ip=127.0.0.1 \
	`# THE flag. Without it coturn refuses to relay to a loopback peer and` \
	`# every check fails at 'checking' with nothing logged to say why — which` \
	`# reads exactly like a broken credential and is not one.` \
	--allow-loopback-peers \
	`# Belt and braces: some builds ship default denied-peer ranges that include` \
	`# loopback, and --allow-loopback-peers alone does not clear them.` \
	--allowed-peer-ip=127.0.0.1 \
	`# Required BY SOME BUILDS alongside --allow-loopback-peers: Ubuntu's coturn` \
	`# refuses to start with "allow_loopback_peers and empty cli password cannot` \
	`# be used together", while Homebrew's starts happily. Setting one satisfies` \
	`# both. The CLI is bound to loopback on a throwaway password and this whole` \
	`# server exists for a test.` \
	--cli-password=mumble-local \
	>/tmp/mumble-coturn.log 2>&1 &
TURN_PID=$!

# Wait for the listener rather than sleeping a guessed interval.
#
# The liveness check is NOT optional. An earlier version grepped only for the
# readiness line and reported success while the process was already dying on
# "Address already in use" — so CI ran the whole relay suite against somebody
# else's TURN server and failed with an assertion two layers away from the
# cause. A start script that cannot fail is not a start script.
for _ in $(seq 1 30); do
	if ! kill -0 "${TURN_PID}" 2>/dev/null; then
		echo "coturn exited during startup; see below" >&2
		tail -20 /tmp/mumble-coturn.log >&2 || true
		exit 1
	fi
	# A bind failure is the one that actually happens, and it is not portable to
	# detect by watching the process: Ubuntu's coturn treats it as fatal and
	# exits, macOS's logs it and carries on serving nothing useful. Reading the
	# log catches both. CI ran an entire relay suite against the distro's own
	# TURN server before this existed, and failed with an assertion two layers
	# from the cause.
	if grep -qE "Address already in use|Fatal final failure" /tmp/mumble-coturn.log 2>/dev/null; then
		echo "coturn could not bind ${PORT} — something else is already on it." >&2
		echo "  Debian installs a coturn SERVICE on apt-install: sudo systemctl stop coturn" >&2
		exit 1
	fi
	if grep -q "Relay ports initialization done" /tmp/mumble-coturn.log 2>/dev/null; then
		# Readiness is claimed before binding completes, so give the bind a beat
		# and confirm the process survived it.
		sleep 1
		if ! kill -0 "${TURN_PID}" 2>/dev/null; then
			echo "coturn died after reporting ready (port taken?); see below" >&2
			tail -20 /tmp/mumble-coturn.log >&2 || true
			exit 1
		fi
		echo "coturn listening on 127.0.0.1:${PORT} (pid ${TURN_PID}, log: /tmp/mumble-coturn.log)"
		exit 0
	fi
	sleep 0.2
done

echo "coturn did not start; see /tmp/mumble-coturn.log" >&2
tail -20 /tmp/mumble-coturn.log >&2 || true
exit 1
