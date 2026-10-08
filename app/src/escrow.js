// Core Stellar logic for the demo. Works in the browser and in Node.
import {
  contract, rpc, Keypair, Networks, Contract, TransactionBuilder,
  nativeToScVal, scValToNative, BASE_FEE, Account,
} from "@stellar/stellar-sdk";

export const RPC_URL = "https://soroban-testnet.stellar.org";
export const HORIZON = "https://horizon-testnet.stellar.org";
export const PASSPHRASE = Networks.TESTNET;
export const WASM_HASH = "ca88d6d5706e67f5db6f65d3a82d0e99c083eb5e4c847f56d878935c5be0adfd";
export const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const SHOWCASE_ID = "CDUMAKBB2QHG4JWG6ZMBYGIHLBG6D34ZCLZ2NMM3V32TVB5LL2DHXJBN";
export const STROOPS = 10_000_000n;

export const ERRORS = {
  1: ["InvalidParties", "Client, freelancer and arbiter must be different accounts."],
  2: ["NoMilestones", "An escrow needs at least one milestone."],
  3: ["TooManyMilestones", "Capped at 20 milestones to keep gas bounded."],
  4: ["InvalidAmount", "Amount out of range."],
  5: ["Overflow", "Arithmetic overflow blocked."],
  6: ["DeadlineInPast", "Deadline must be in the future."],
  7: ["NotFunded", "Escrow isn't active."],
  8: ["AlreadyFunded", "Escrow was already funded. You can't fund it twice."],
  9: ["MilestoneNotFound", "No such milestone."],
  10: ["MilestoneNotPending", "This milestone has already been settled or is frozen. Double payment blocked."],
  11: ["MilestoneNotDisputed", "Only disputed milestones can be resolved."],
  12: ["NotAParty", "Only the client or freelancer can open a dispute."],
  13: ["DeadlineNotReached", "Refunds unlock only after the deadline."],
  14: ["BalanceMismatch", "Funding didn't deliver the exact amount."],
};

export const server = new rpc.Server(RPC_URL);

export function explainError(e) {
  const msg = String(e?.message ?? e);
  const m = msg.match(/Error\(Contract, #(\d+)\)/);
  if (m && ERRORS[m[1]]) {
    const [name, why] = ERRORS[m[1]];
    return { code: Number(m[1]), name, why };
  }
  if (/non-invoker|needsNonInvokerSigningBy|signatures? from|requires? signatures/i.test(msg) || /Auth, InvalidAction/i.test(msg)) {
    return { code: 0, name: "Unauthorized", why: "The contract needs the right party's signature. This wallet can't sign for them." };
  }
  return { code: -1, name: "Error", why: msg.slice(0, 220) };
}

export async function fundWithFriendbot(pub) {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(pub)}`);
  if (!r.ok) {
    const t = await r.text();
    if (!/createAccountAlreadyExist|already funded/i.test(t)) throw new Error("Friendbot failed: " + t.slice(0, 160));
  }
}

export async function xlmBalance(pub) {
  const r = await fetch(`${HORIZON}/accounts/${pub}`);
  if (!r.ok) return 0;
  const j = await r.json();
  const b = j.balances.find((x) => x.asset_type === "native");
  return b ? Number(b.balance) : 0;
}

// Read-only contract call through simulation (no signature, no fee).
export async function readCall(contractId, method, ...args) {
  const src = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return scValToNative(sim.result.retval);
}

export async function contractXlm(contractId) {
  const v = await readCall(XLM_SAC, "balance", nativeToScVal(contractId, { type: "address" }));
  return Number(v) / 1e7;
}

export async function readEscrow(contractId) {
  const [config, milestones, status] = await Promise.all([
    readCall(contractId, "get_config"),
    readCall(contractId, "get_milestones"),
    readCall(contractId, "get_status"),
  ]);
  const norm = (v) => (Array.isArray(v) ? v[0] : v); // enums come back as ["Pending"]
  return {
    config,
    status: norm(status),
    milestones: milestones.map((m) => ({ amount: Number(m.amount) / 1e7, state: norm(m.state) })),
  };
}

function opts(kp) {
  return {
    networkPassphrase: PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: kp.publicKey(),
    ...contract.basicNodeSigner(kp, PASSPHRASE),
  };
}

export async function deployEscrow({ client, freelancer, arbiter, amountsXlm, deadline }) {
  const tx = await contract.Client.deploy(
    {
      client: client.publicKey(),
      freelancer: freelancer.publicKey(),
      arbiter: arbiter.publicKey(),
      token: XLM_SAC,
      amounts: amountsXlm.map((a) => BigInt(Math.round(a * 1e7))),
      deadline: BigInt(deadline),
    },
    { ...opts(client), wasmHash: WASM_HASH },
  );
  const sent = await tx.signAndSend();
  const id = sent.result.options.contractId;
  return { contractId: id, hash: sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash };
}

const clientCache = new Map();
async function clientFor(contractId, kp) {
  const key = contractId + kp.publicKey();
  if (!clientCache.has(key)) clientCache.set(key, await contract.Client.from({ ...opts(kp), contractId }));
  return clientCache.get(key);
}

// Invoke a contract method signed by `kp`. Returns the tx hash.
export async function invoke(contractId, kp, method, args = {}) {
  const c = await clientFor(contractId, kp);
  const tx = await c[method](args);
  if (tx.simulation && rpc.Api.isSimulationError(tx.simulation)) throw new Error(tx.simulation.error);
  const need = tx.needsNonInvokerSigningBy();
  if (need.length) throw new Error("needsNonInvokerSigningBy " + need.join(","));
  const sent = await tx.signAndSend();
  return sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash;
}

export const txLink = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`;
export const contractLink = (id) => `https://stellar.expert/explorer/testnet/contract/${id}`;
export const accountLink = (id) => `https://stellar.expert/explorer/testnet/account/${id}`;
