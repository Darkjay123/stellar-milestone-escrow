# Stellar Milestone Escrow (Soroban)

A security-first milestone escrow on Stellar. A client locks funds (any Stellar Asset Contract token: USDC, EURC, XLM) for a freelancer, split into milestones. The client releases each milestone when the work is delivered. Either party can freeze a milestone with a dispute, and only a neutral arbiter can settle it, with any split it decides. After the deadline, any milestone still pending can be refunded to the client.

It's built for the way work and money actually move across Africa: remote contractors, cross-border clients, and stablecoin payouts. Neither side has to trust the other with the full amount upfront.

**Live on Stellar testnet. 22 tests passing. No admin keys.**

## Live testnet proof

Escrow contract (full lifecycle): [`CDUMAKBB2QHG4JWG6ZMBYGIHLBG6D34ZCLZ2NMM3V32TVB5LL2DHXJBN`](https://stellar.expert/explorer/testnet/contract/CDUMAKBB2QHG4JWG6ZMBYGIHLBG6D34ZCLZ2NMM3V32TVB5LL2DHXJBN)

| Step | Who signs | Transaction |
|---|---|---|
| Deploy + constructor (2 milestones: 100 + 200 XLM) | client | [74b54240…](https://stellar.expert/explorer/testnet/tx/74b542402dc2152ded0ccd251656e859558f7f8e7b9757d62b0a518709030617) |
| `fund` (300 XLM locked) | client | [b63b4dd2…](https://stellar.expert/explorer/testnet/tx/b63b4dd2ac73a799b8e95b3c78b1829328f397c76c19a22d0d09a109ea66385a) |
| `release(0)` (100 XLM to freelancer) | client | [c8597fbb…](https://stellar.expert/explorer/testnet/tx/c8597fbbaf096eb6d0b7fd81fcd83b02bce47bc4998a7d431c967239eae8e696) |
| `dispute(1)` | freelancer | [4b573d4b…](https://stellar.expert/explorer/testnet/tx/4b573d4bcda0c31d591135570de2b90e4cf922f90ce70ccfce1d7dac11ecafae) |
| `resolve(1, 70%)` (140 XLM to freelancer, 60 back to client) | arbiter | [e3eb27e3…](https://stellar.expert/explorer/testnet/tx/e3eb27e3d51280971d416a672fcbfb1c0e8899374994cc4762f2b9a6d3d1a4e6) |

Final on-chain state: `Closed`, milestones `[Released, Resolved]`, contract balance 0.

Refund escrow (deadline path): [`CDVHL3Y4ISLXLI4T5MZJY56DOAQMIPTHY4XTADEWPJCWHA5FG3JLO27F`](https://stellar.expert/explorer/testnet/contract/CDVHL3Y4ISLXLI4T5MZJY56DOAQMIPTHY4XTADEWPJCWHA5FG3JLO27F), funded in [84feaffb…](https://stellar.expert/explorer/testnet/tx/84feaffbf4de5f2b5538773b90a055d2603575f23834a3af7d8fbee050f36f10). After the deadline passed, the freelancer's account triggered `refund(0)` in [d3ea9ff6…](https://stellar.expert/explorer/testnet/tx/d3ea9ff65c208f0e28360f451fd355e2b6bde7efdd95d7b12bf5c51254c88f47). Anyone can call it, but the 50 XLM can only go back to the client. Final state: `Closed`.

Attacks rejected live on testnet (the network refused them in simulation, so they never reached the ledger):
- Refund before the deadline → `Error(Contract, #13) DeadlineNotReached`
- Freelancer tries to release funds to themselves → rejected, because the client's signature is required
- Arbiter tries to open a dispute (it isn't a party to the deal) → `Error(Contract, #12) NotAParty`

## Roles and lifecycle

```
AwaitingFunding --fund (client)--> Active --(all milestones final)--> Closed

Milestone:  Pending --release (client)--------------------> Released
            Pending --dispute (client|freelancer)--> Disputed --resolve (arbiter, any split)--> Resolved
            Pending --refund (anyone, after deadline)-----> Refunded (to client only)
```

| Function | Who must sign | What it does |
|---|---|---|
| `__constructor(client, freelancer, arbiter, token, amounts, deadline)` | deployer | Sets up the escrow atomically when it's deployed |
| `fund()` | client | Pulls the full total into the escrow and checks the real balance change |
| `release(index)` | client | Pays one milestone to the freelancer |
| `dispute(caller, index)` | client or freelancer | Freezes a pending milestone |
| `resolve(index, to_freelancer)` | arbiter | Splits a disputed milestone between the two parties, and nowhere else |
| `refund(index)` | anyone, after the deadline | Returns a pending milestone to the client |
| `get_config / get_milestones / get_status` | none | Read-only views |

## Security model

| Threat | Mitigation | Test |
|---|---|---|
| Someone front-runs initialisation and sets themselves as recipient | Set up by `__constructor`, atomic with deploy, so no `init` function exists | (the API has no init call) |
| A party moves money without consent | `require_auth()` on the exact party for every money-moving call | `fund_requires_client_signature`, `release_requires_client_signature_exactly`, `freelancer_cannot_release_to_themselves`, `client_cannot_resolve_dispute_in_own_favour` |
| A milestone gets paid twice | Per-milestone state machine, written before the transfer | `cannot_release_same_milestone_twice`, `cannot_fund_twice`, `disputed_milestone_is_frozen` |
| Arbiter steals or overpays | Arbiter can only split a disputed milestone's own amount between the two parties | `arbiter_cannot_pay_more_than_milestone`, `cannot_resolve_undisputed_milestone` |
| Outsider interferes | Only the client or freelancer can dispute | `stranger_cannot_dispute` |
| Funds locked forever if the client disappears | Permissionless refund after the deadline, and it can only pay the client | `refund_after_deadline_only_pays_client`, `refund_blocked_before_deadline` |
| Integer overflow | `checked_add` on totals, `overflow-checks = true` in release builds | `rejects_total_overflow` |
| Fee-on-transfer token leaves escrow short | `fund` checks the contract's real balance change | (enforced in `fund`) |
| Storage or gas blow-up | Capped at 20 milestones, small instance storage, TTL extended on every call | `rejects_too_many_milestones` |
| Admin rug | No admin, no upgrade function, no sweep. Funds can only reach the client or freelancer | (by construction) |
| Bad configuration | Distinct parties, amounts > 0, deadline in the future | `rejects_same_party_twice`, `rejects_zero_amount`, `rejects_no_milestones`, `rejects_past_deadline` |

Every money-moving action emits an event (`Funded`, `Released`, `Disputed`, `Resolved`, `Refunded`) for indexers, backends and notifications, for example a WhatsApp alert when a milestone is paid.

## Known limitations and next steps

- If the arbiter disappears, a disputed milestone stays frozen. Next step: an arbiter timeout that falls back to a pre-agreed split.
- No partial release within a milestone. Use smaller milestones instead.
- Not audited. Before mainnet funds go through it, get an independent review (e.g. OpenZeppelin or Certora's Stellar programs) and run fuzzing.
- Frontend (Freighter wallet + `@stellar/stellar-sdk`) and an off-ramp to naira through a SEP-24 anchor are the natural next layer.

## Run it

```bash
# tests
cargo test
# build the optimized WASM
stellar contract build
# full testnet demo (generates and funds keys with Friendbot)
./scripts/demo-testnet.sh
```

Built with soroban-sdk 28 (Protocol 28 "Adapter") and stellar-cli 28.1.

---
Built by John Enechukwu ([@The_Real_EJC](https://x.com/The_Real_EJC)) · Web3 builder focused on how money moves in Africa.
