#!/bin/bash
# Resumable, hang-proof devnet deploy.
#
# Strategy: write the program into a buffer we control the keypair for
# (`solana program write-buffer --buffer`). If an attempt hangs (dead RPC
# connection — observed with both public devnet and Helius) a watchdog kills
# it and the NEXT attempt RESUMES the same buffer, writing only the missing
# chunks. Attempts alternate RPC endpoints. Once the buffer is complete, a
# single `deploy --buffer` transaction activates it under the pinned
# program id. No SOL is stranded between attempts.
#
# Usage: HELIUS_RPC_URL="https://devnet.helius-rpc.com/?api-key=..." \
#        ./scripts/deploy-devnet.sh
set -u
cd "$(dirname "$0")/.."

PROGRAM_SO=target/deploy/amm.so
PROGRAM_KEYPAIR=target/deploy/amm-keypair.json
PROGRAM_ID=H59qQz8DXzUWWc3L528iTCFL36ozwBhJc4tHzuwL2JuY
BUFFER_KEYPAIR="${BUFFER_KEYPAIR:-$HOME/.config/solana/amm-deploy-buffer.json}"
PUBLIC_RPC=https://api.devnet.solana.com
ATTEMPTS="${ATTEMPTS:-30}"
ATTEMPT_TIMEOUT_SECS="${ATTEMPT_TIMEOUT_SECS:-150}"

RPCS=("$PUBLIC_RPC")
[ -n "${HELIUS_RPC_URL:-}" ] && RPCS=("$HELIUS_RPC_URL" "$PUBLIC_RPC")

if [ ! -f "$BUFFER_KEYPAIR" ]; then
  solana-keygen new --no-bip39-passphrase -s -o "$BUFFER_KEYPAIR" >/dev/null
  echo "buffer keypair: $BUFFER_KEYPAIR (new)"
else
  echo "buffer keypair: $BUFFER_KEYPAIR (existing — will resume)"
fi

# portable watchdog (macOS has no `timeout`)
run_with_timeout() {
  local secs=$1; shift
  "$@" &
  local pid=$!
  ( sleep "$secs" && kill "$pid" 2>/dev/null ) &
  local killer=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$killer" 2>/dev/null
  wait "$killer" 2>/dev/null
  return $rc
}

wrote=1
for i in $(seq 1 "$ATTEMPTS"); do
  RPC="${RPCS[$(( (i - 1) % ${#RPCS[@]} ))]}"
  echo "--- write-buffer attempt $i/$ATTEMPTS via ${RPC%%\?*} (timeout ${ATTEMPT_TIMEOUT_SECS}s)"
  run_with_timeout "$ATTEMPT_TIMEOUT_SECS" \
    solana program write-buffer "$PROGRAM_SO" \
      --buffer "$BUFFER_KEYPAIR" \
      --url "$RPC" \
      --use-rpc \
      --with-compute-unit-price 150000 \
      --max-sign-attempts 10
  wrote=$?
  [ $wrote -eq 0 ] && { echo "buffer complete after attempt $i"; break; }
  echo "attempt $i ended (rc=$wrote) — resuming same buffer"
  sleep 3
done

if [ $wrote -ne 0 ]; then
  echo "FAILED: buffer incomplete after $ATTEMPTS attempts (progress IS saved — rerun to continue)"
  exit 1
fi

echo "--- finalizing: deploy from buffer under pinned program id"
for RPC in "${RPCS[@]}"; do
  if solana program deploy \
      --buffer "$BUFFER_KEYPAIR" \
      --program-id "$PROGRAM_KEYPAIR" \
      --url "$RPC" \
      --use-rpc \
      --with-compute-unit-price 150000 \
      --max-sign-attempts 20; then
    echo "--- verify"
    solana program show "$PROGRAM_ID" --url "$PUBLIC_RPC"
    exit 0
  fi
  echo "finalize via ${RPC%%\?*} failed — trying next RPC"
done
echo "FAILED to finalize (buffer is complete and safe — rerun to retry finalize only)"
exit 1
