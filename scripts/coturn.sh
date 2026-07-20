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

if ! command -v turnserver >/dev/null 2>&1; then
	echo "coturn is not installed." >&2
	echo "  macOS:  brew install coturn" >&2
	echo "  Debian: sudo apt-get install -y coturn" >&2
	exit 1
fi

# Idempotent: re-running must not leave two servers fighting over a port.
pkill -f "turnserver.*${SECRET}" 2>/dev/null || true
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
	>/tmp/mumble-coturn.log 2>&1 &

# Wait for the listener rather than sleeping a guessed interval.
for _ in $(seq 1 30); do
	if grep -q "Relay ports initialization done" /tmp/mumble-coturn.log 2>/dev/null; then
		echo "coturn listening on 127.0.0.1:${PORT} (log: /tmp/mumble-coturn.log)"
		exit 0
	fi
	sleep 0.2
done

echo "coturn did not start; see /tmp/mumble-coturn.log" >&2
tail -20 /tmp/mumble-coturn.log >&2 || true
exit 1
