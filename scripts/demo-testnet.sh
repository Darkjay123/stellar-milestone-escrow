#!/usr/bin/env bash
# Reproduce the full testnet demo: deploy, fund, release, dispute, resolve.
# Requires stellar-cli >= 28. Uses native XLM via its Stellar Asset Contract;
# swap TOKEN for the USDC SAC address to run the same flow with USDC.
set -euo pipefail
NET=testnet
for k in client freelancer arbiter; do
  stellar keys address $k >/dev/null 2>&1 || stellar keys generate $k --network $NET --fund
done
C=$(stellar keys address client); F=$(stellar keys address freelancer); A=$(stellar keys address arbiter)
TOKEN=$(stellar contract id asset --asset native --network $NET)
stellar contract build
DEADLINE=$(( $(date +%s) + 30*86400 ))
ID=$(stellar contract deploy --wasm target/wasm32v1-none/release/milestone_escrow.wasm \
  --source client --network $NET -- \
  --client $C --freelancer $F --arbiter $A --token $TOKEN \
  --amounts '["1000000000","2000000000"]' --deadline $DEADLINE)
echo "Escrow: $ID"
stellar contract invoke --id $ID --source client     --network $NET -- fund
stellar contract invoke --id $ID --source client     --network $NET -- release --index 0
stellar contract invoke --id $ID --source freelancer --network $NET -- dispute --caller $F --index 1
stellar contract invoke --id $ID --source arbiter    --network $NET -- resolve --index 1 --to_freelancer 1400000000
stellar contract invoke --id $ID --source client     --network $NET --send=no -- get_milestones
