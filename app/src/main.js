import "./style.css";
import { Keypair } from "@stellar/stellar-sdk";
import * as E from "./escrow.js";

const LS = "milestone-escrow-demo-v1";
const app = document.getElementById("app");
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");
const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let S = load();          // persisted demo state
let live = null;         // latest on-chain read
let bal = {};            // balances
let busy = null;         // label of the action in flight
let lastAttack = null;   // last attack-lab result
let setupDraft = { amounts: [100, 200, 50], deadline: "short" };

function load() {
  try { return JSON.parse(localStorage.getItem(LS)) || null; } catch { return null; }
}
function save() { S ? localStorage.setItem(LS, JSON.stringify(S)) : localStorage.removeItem(LS); }
const kp = (role) => Keypair.fromSecret(S.keys[role]);
const pub = (role) => kp(role).publicKey();

function toast(html, kind = "ok") {
  const t = document.getElementById("toast");
  const el = document.createElement("div");
  el.className = `t ${kind}`;
  el.innerHTML = html;
  t.appendChild(el);
  setTimeout(() => el.classList.add("out"), 4200);
  setTimeout(() => el.remove(), 4800);
}

function log(kind, title, detail, hash) {
  S.activity.unshift({ kind, title, detail, hash, at: Date.now() });
  S.activity = S.activity.slice(0, 40);
  save();
}

// ---------------------------------------------------------------- setup
function renderSetup(progress) {
  const total = setupDraft.amounts.reduce((a, b) => a + Number(b || 0), 0);
  const steps = [
    ["wallets", "Create 3 wallets in your browser"],
    ["fund", "Fund them with free testnet XLM"],
    ["deploy", "Deploy a new escrow contract"],
  ];
  const idx = progress ? steps.findIndex((s) => s[0] === progress) : -1;
  app.innerHTML = `
  <div class="setup">
    <div class="card setup-card">
      <div class="card-title"><span class="num">A</span> Configure the deal</div>
      <div class="roles">
        <div class="role"><span class="avatar c">C</span><div><b>Client</b><small>locks and releases funds</small></div></div>
        <div class="role"><span class="avatar f">F</span><div><b>Freelancer</b><small>does the work, gets paid</small></div></div>
        <div class="role"><span class="avatar a">A</span><div><b>Arbiter</b><small>settles disputes only</small></div></div>
      </div>
      <label class="lbl">Milestones (XLM)</label>
      <div class="ms-edit">
        ${setupDraft.amounts.map((a, i) => `
          <div class="ms-row">
            <span class="ms-i">${String(i + 1).padStart(2, "0")}</span>
            <input type="number" min="1" step="1" value="${a}" data-i="${i}" ${progress ? "disabled" : ""}/>
            <span class="unit">XLM</span>
            ${setupDraft.amounts.length > 1 && !progress ? `<button class="x" data-rm="${i}" title="Remove">×</button>` : ""}
          </div>`).join("")}
        ${setupDraft.amounts.length < 5 && !progress ? `<button class="add" id="add-ms">+ Add milestone</button>` : ""}
      </div>
      <label class="lbl">Refund deadline</label>
      <div class="seg">
        <button data-dl="short" class="${setupDraft.deadline === "short" ? "on" : ""}" ${progress ? "disabled" : ""}>3 minutes<small>so you can demo refunds</small></button>
        <button data-dl="long" class="${setupDraft.deadline === "long" ? "on" : ""}" ${progress ? "disabled" : ""}>30 days<small>like a real contract</small></button>
      </div>
      <div class="total-row"><span>Total to lock</span><b>${fmt(total)} XLM</b></div>
      <button class="btn-primary wide" id="launch" ${progress ? "disabled" : ""}>
        ${progress ? `<span class="spin"></span> Working on the chain…` : "Launch escrow on Stellar testnet →"}
      </button>
      <p class="fine">Testnet only. Test XLM has no real value. The wallet keys stay in this browser.</p>
    </div>
    <div class="card steps-card">
      <div class="card-title"><span class="num">B</span> What happens</div>
      <ol class="steps">
        ${steps.map((s, i) => `<li class="${i < idx ? "done" : i === idx ? "now" : ""}"><span class="ring">${i < idx ? "✓" : i + 1}</span>${s[1]}</li>`).join("")}
      </ol>
      <div class="explain">
        <p><b>Then you drive it.</b> Fund the vault as the client, release milestones, open a dispute as the freelancer, settle it as the arbiter, or wait out the deadline and refund.</p>
        <p><b>Then try to break it.</b> The Attack Lab fires real exploit attempts at the contract, and you watch the network refuse each one.</p>
      </div>
    </div>
  </div>`;

  app.querySelectorAll(".ms-row input").forEach((inp) =>
    inp.addEventListener("input", (e) => { setupDraft.amounts[+e.target.dataset.i] = Number(e.target.value); renderTotalOnly(); }));
  app.querySelectorAll("[data-rm]").forEach((b) => b.onclick = () => { setupDraft.amounts.splice(+b.dataset.rm, 1); renderSetup(); });
  app.querySelector("#add-ms")?.addEventListener("click", () => { setupDraft.amounts.push(50); renderSetup(); });
  app.querySelectorAll("[data-dl]").forEach((b) => b.onclick = () => { setupDraft.deadline = b.dataset.dl; renderSetup(); });
  app.querySelector("#launch").onclick = launch;
}
function renderTotalOnly() {
  const total = setupDraft.amounts.reduce((a, b) => a + Number(b || 0), 0);
  const el = app.querySelector(".total-row b");
  if (el) el.textContent = `${fmt(total)} XLM`;
}

async function launch() {
  const amounts = setupDraft.amounts.map(Number);
  if (amounts.some((a) => !(a > 0)) || amounts.reduce((a, b) => a + b, 0) > 9000) {
    toast("Each milestone must be above 0 and the total at most 9,000 XLM.", "bad"); return;
  }
  try {
    renderSetup("wallets");
    const keys = { client: Keypair.random(), freelancer: Keypair.random(), arbiter: Keypair.random() };
    await new Promise((r) => setTimeout(r, 400));
    renderSetup("fund");
    await Promise.all(Object.values(keys).map((k) => E.fundWithFriendbot(k.publicKey())));
    renderSetup("deploy");
    const deadline = Math.floor(Date.now() / 1000) + (setupDraft.deadline === "short" ? 180 : 30 * 86400);
    const { contractId, hash } = await E.deployEscrow({ client: keys.client, freelancer: keys.freelancer, arbiter: keys.arbiter, amountsXlm: amounts, deadline });
    S = {
      keys: Object.fromEntries(Object.entries(keys).map(([r, k]) => [r, k.secret()])),
      contractId, deadline, activity: [],
    };
    log("ok", "Escrow deployed", `${amounts.length} milestones · ${fmt(amounts.reduce((a, b) => a + b, 0))} XLM · constructor ran at deploy time`, hash);
    save();
    toast(`Contract deployed · <a href="${E.contractLink(contractId)}" target="_blank">${short(contractId)}</a>`);
    await refresh();
  } catch (e) {
    console.error(e);
    toast(`Setup failed: ${esc(E.explainError(e).why)}`, "bad");
    S = null; save(); renderSetup();
  }
}

// ---------------------------------------------------------------- console
async function refresh() {
  if (!S) return renderSetup();
  try {
    const [esc_, c, f, a, v] = await Promise.all([
      E.readEscrow(S.contractId),
      E.xlmBalance(pub("client")), E.xlmBalance(pub("freelancer")), E.xlmBalance(pub("arbiter")),
      E.contractXlm(S.contractId),
    ]);
    live = esc_; bal = { client: c, freelancer: f, arbiter: a, vault: v };
  } catch (e) {
    console.error(e);
    if (!live) { toast("Couldn't read the contract (testnet resets wipe old demos). Starting fresh.", "bad"); S = null; save(); return renderSetup(); }
  }
  renderConsole();
}

function nextHint() {
  if (!live) return "";
  const ms = live.milestones;
  if (live.status === "AwaitingFunding") return "Next: the <b>client</b> funds the vault. Money moves from their wallet into the contract.";
  if (live.status === "Closed") return "Escrow closed. Every milestone is settled and the vault holds nothing. Reset to run it again.";
  if (ms.some((m) => m.state === "Disputed")) return "A milestone is frozen. Only the <b>arbiter</b> can settle it now. Pick a split and resolve.";
  if (pastDeadline() && ms.some((m) => m.state === "Pending")) return "The deadline has passed. <b>Anyone</b> can refund pending milestones, but the money can only go to the client.";
  return "Work delivered? The <b>client</b> releases a milestone. Unhappy? Either party can <b>dispute</b>. Or try the Attack Lab.";
}
const pastDeadline = () => Date.now() / 1000 > S.deadline;

function countdown() {
  const s = Math.floor(S.deadline - Date.now() / 1000);
  if (s <= 0) return `<span class="cd open">Refunds unlocked</span>`;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const txt = d ? `${d}d ${h}h ${m}m` : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `<span class="cd">Refunds unlock in <b>${txt}</b></span>`;
}

function vaultRing() {
  const ms = live.milestones, total = ms.reduce((a, m) => a + m.amount, 0) || 1;
  const R = 70, C = 2 * Math.PI * R;
  let off = 0;
  const seg = (amt, cls) => {
    const len = (amt / total) * C;
    const s = `<circle r="${R}" cx="90" cy="90" class="seg ${cls}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}"/>`;
    off += len; return s;
  };
  const by = (st) => ms.filter((m) => m.state === st).reduce((a, m) => a + m.amount, 0);
  const funded = live.status !== "AwaitingFunding";
  return `
    <svg viewBox="0 0 180 180" class="ring-svg">
      <circle r="${R}" cx="90" cy="90" class="track"/>
      ${funded ? seg(by("Released") + by("Resolved"), "paid") + seg(by("Refunded"), "refunded") + seg(by("Disputed"), "disputed") + seg(by("Pending"), "locked") : ""}
    </svg>
    <div class="ring-center">
      <small>${funded ? "in the vault" : "awaiting funding"}</small>
      <b>${fmt(bal.vault ?? 0)}</b><span>XLM</span>
    </div>`;
}

function party(role, label, letter, desc) {
  return `
  <div class="party">
    <span class="avatar ${letter.toLowerCase()}">${letter}</span>
    <div class="p-meta">
      <div class="p-top"><b>${label}</b><a href="${E.accountLink(pub(role))}" target="_blank" class="addr">${short(pub(role))} ↗</a></div>
      <small>${desc}</small>
    </div>
    <div class="p-bal"><b>${fmt(bal[role] ?? 0)}</b><span>XLM</span></div>
  </div>`;
}

function milestoneCard(m, i) {
  const funded = live.status === "Active";
  const dis = busy ? "disabled" : "";
  const badge = { Pending: "pending", Released: "ok", Resolved: "ok", Disputed: "warn", Refunded: "blue" }[m.state];
  let actions = "";
  if (funded && m.state === "Pending") {
    actions = `
      <button class="act primary" data-act="release" data-i="${i}" ${dis}>Release<small>client signs</small></button>
      <button class="act" data-act="dispute-f" data-i="${i}" ${dis}>Dispute<small>freelancer</small></button>
      <button class="act" data-act="dispute-c" data-i="${i}" ${dis}>Dispute<small>client</small></button>
      ${pastDeadline() ? `<button class="act blue" data-act="refund" data-i="${i}" ${dis}>Refund<small>anyone</small></button>` : ""}`;
  } else if (funded && m.state === "Disputed") {
    actions = `
      <div class="resolver">
        <div class="split-lbl"><span>Freelancer <b id="sf-${i}">70%</b></span><span>Client <b id="sc-${i}">30%</b></span></div>
        <input type="range" min="0" max="100" value="70" class="split" data-i="${i}"/>
        <button class="act warn" data-act="resolve" data-i="${i}" ${dis}>Resolve as arbiter<small>arbiter signs</small></button>
      </div>`;
  }
  const label = { Released: "Paid to freelancer", Resolved: "Split by arbiter", Refunded: "Refunded to client", Disputed: "Frozen for arbiter", Pending: funded ? "Locked in vault" : "Not funded yet" }[m.state];
  return `
  <div class="ms ${badge}">
    <div class="ms-head">
      <span class="ms-i">M${i + 1}</span>
      <div class="ms-amt"><b>${fmt(m.amount)}</b> XLM</div>
      <span class="badge ${badge}">${m.state}</span>
    </div>
    <div class="ms-sub">${label}</div>
    ${actions ? `<div class="ms-actions">${actions}</div>` : ""}
  </div>`;
}

function renderConsole() {
  if (!live) return;
  const funded = live.status !== "AwaitingFunding";
  const dis = busy ? "disabled" : "";
  app.innerHTML = `
  <div class="console">
    <div class="console-bar">
      <div class="cb-left">
        <span class="status ${live.status.toLowerCase()}"><span class="dot"></span>${{ AwaitingFunding: "Awaiting funding", Active: "Active", Closed: "Closed" }[live.status]}</span>
        <a class="mono" href="${E.contractLink(S.contractId)}" target="_blank">${short(S.contractId)} ↗</a>
        <span id="cd">${countdown()}</span>
      </div>
      <div class="cb-right">
        ${busy ? `<span class="busy"><span class="spin"></span>${esc(busy)}</span>` : ""}
        <button class="btn-ghost sm" id="refresh" ${dis}>↻ Refresh</button>
        <button class="btn-ghost sm danger" id="reset" ${dis}>New escrow</button>
      </div>
    </div>

    <div class="hint">${nextHint()}</div>

    <div class="grid-main">
      <div class="col">
        <div class="card">
          <div class="card-title">Parties</div>
          ${party("client", "Client", "C", "Locks funds, approves work")}
          ${party("freelancer", "Freelancer", "F", "Delivers, gets paid per milestone")}
          ${party("arbiter", "Arbiter", "A", "Can only split disputed milestones")}
        </div>
        <div class="card vault">
          <div class="card-title">The vault <span class="muted">· a smart contract, not a person</span></div>
          <div class="ring-wrap">${vaultRing()}</div>
          <div class="legend"><span class="paid">Paid out</span><span class="locked">Locked</span><span class="disputed">Disputed</span><span class="refunded">Refunded</span></div>
          ${!funded ? `<button class="btn-primary wide" data-act="fund" ${dis}>Fund the vault as client · ${fmt(live.milestones.reduce((a, m) => a + m.amount, 0))} XLM</button>` : ""}
        </div>
      </div>

      <div class="col">
        <div class="card">
          <div class="card-title">Milestones</div>
          <div class="ms-list">${live.milestones.map(milestoneCard).join("")}</div>
        </div>

        <div class="card attack">
          <div class="card-title"><span class="skull">⚠</span> Attack Lab <span class="muted">· real exploit attempts, sent to the network</span></div>
          <div class="atk-grid">
            <button data-atk="selfpay" ${dis}><b>Freelancer pays themselves</b><small>calls release() without the client's signature</small></button>
            <button data-atk="double" ${dis}><b>Double payment</b><small>releases an already-paid milestone again</small></button>
            <button data-atk="outsider" ${dis}><b>Arbiter hijacks a deal</b><small>tries to open a dispute it isn't a party to</small></button>
            <button data-atk="early" ${dis}><b>Early refund</b><small>pulls funds back before the deadline</small></button>
            <button data-atk="refund2" ${dis}><b>Fund twice</b><small>re-runs fund() to corrupt accounting</small></button>
            <button data-atk="overpay" ${dis}><b>Arbiter overpays</b><small>resolves for more than the milestone holds</small></button>
          </div>
          ${lastAttack ? `
          <div class="atk-result ${lastAttack.blocked ? "blocked" : "skip"}">
            <div class="ar-head">${lastAttack.blocked ? "🛡 Blocked by the contract" : "ℹ"} <span class="mono">${esc(lastAttack.code)}</span></div>
            <div class="ar-title">${esc(lastAttack.title)}</div>
            <div class="ar-why">${esc(lastAttack.why)}</div>
          </div>` : ""}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">On-chain activity <span class="muted">· every row is a real Stellar transaction</span></div>
      <div class="feed">
        ${S.activity.length ? S.activity.map((a) => `
          <div class="row ${a.kind}">
            <span class="mark">${a.kind === "ok" ? "✓" : "✕"}</span>
            <div class="rw"><b>${esc(a.title)}</b><small>${esc(a.detail || "")}</small></div>
            <span class="when">${new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            ${a.hash ? `<a href="${E.txLink(a.hash)}" target="_blank" class="mono tx">${a.hash.slice(0, 8)}… ↗</a>` : `<span class="mono tx none">rejected</span>`}
          </div>`).join("") : `<div class="empty">Nothing yet. Fund the vault to start.</div>`}
      </div>
    </div>
  </div>`;
  wire();
}

function wire() {
  app.querySelector("#refresh")?.addEventListener("click", () => refresh());
  app.querySelector("#reset")?.addEventListener("click", () => {
    if (!confirm("Start a brand-new escrow? (The current one stays on-chain.)")) return;
    S = null; live = null; lastAttack = null; save(); renderSetup();
  });
  app.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act, +b.dataset.i)));
  app.querySelectorAll("[data-atk]").forEach((b) => b.addEventListener("click", () => attack(b.dataset.atk)));
  app.querySelectorAll(".split").forEach((r) => r.addEventListener("input", () => {
    const i = r.dataset.i; app.querySelector(`#sf-${i}`).textContent = r.value + "%"; app.querySelector(`#sc-${i}`).textContent = 100 - r.value + "%";
  }));
}

async function run(label, fn) {
  busy = label; renderConsole();
  try { await fn(); }
  catch (e) { console.error(e); const x = E.explainError(e); toast(`${esc(x.name)}: ${esc(x.why)}`, "bad"); }
  finally { busy = null; await refresh(); }
}

async function act(kind, i) {
  const m = live.milestones[i];
  if (kind === "fund") return run("Client is funding the vault…", async () => {
    const h = await E.invoke(S.contractId, kp("client"), "fund");
    log("ok", "Vault funded by client", `${fmt(live.milestones.reduce((a, m) => a + m.amount, 0))} XLM locked · balance change verified on-chain`, h);
    toast("Vault funded ✓");
  });
  if (kind === "release") return run(`Releasing M${i + 1}…`, async () => {
    const h = await E.invoke(S.contractId, kp("client"), "release", { index: i });
    log("ok", `M${i + 1} released`, `${fmt(m.amount)} XLM → freelancer · client signed`, h);
    toast(`M${i + 1} paid to freelancer ✓`);
  });
  if (kind === "dispute-f" || kind === "dispute-c") {
    const role = kind === "dispute-f" ? "freelancer" : "client";
    return run(`${role} is disputing M${i + 1}…`, async () => {
      const h = await E.invoke(S.contractId, kp(role), "dispute", { caller: pub(role), index: i });
      log("ok", `M${i + 1} disputed by ${role}`, "Milestone frozen. Only the arbiter can settle it now.", h);
      toast(`M${i + 1} frozen for the arbiter`);
    });
  }
  if (kind === "resolve") {
    const pct = +app.querySelector(`.split[data-i="${i}"]`).value;
    const toF = BigInt(Math.round(m.amount * 1e7)) * BigInt(pct) / 100n;
    return run(`Arbiter resolving M${i + 1}…`, async () => {
      const h = await E.invoke(S.contractId, kp("arbiter"), "resolve", { index: i, to_freelancer: toF });
      log("ok", `M${i + 1} resolved ${pct}/${100 - pct}`, `${fmt(Number(toF) / 1e7)} XLM → freelancer · ${fmt(m.amount - Number(toF) / 1e7)} XLM → client`, h);
      toast(`Dispute settled ${pct}/${100 - pct} ✓`);
    });
  }
  if (kind === "refund") return run(`Refunding M${i + 1}…`, async () => {
    const h = await E.invoke(S.contractId, kp("freelancer"), "refund", { index: i });
    log("ok", `M${i + 1} refunded`, `${fmt(m.amount)} XLM → client · called by the freelancer's wallet, but the funds can only go to the client`, h);
    toast(`M${i + 1} refunded to client ✓`);
  });
}

async function attack(kind) {
  const ms = live.milestones;
  const pending = ms.findIndex((m) => m.state === "Pending");
  const paid = ms.findIndex((m) => m.state === "Released" || m.state === "Resolved" || m.state === "Refunded");
  const disputed = ms.findIndex((m) => m.state === "Disputed");
  const active = live.status === "Active";
  const plans = {
    selfpay: { need: active && pending >= 0, msg: "Needs a funded escrow with a pending milestone.", title: `Freelancer tries to release M${pending + 1} to themselves`, fn: () => E.invoke(S.contractId, kp("freelancer"), "release", { index: pending }) },
    double: { need: active && paid >= 0, msg: "Release a milestone first, then try paying it again.", title: `Client tries to pay M${paid + 1} a second time`, fn: () => E.invoke(S.contractId, kp("client"), "release", { index: paid }) },
    outsider: { need: active && pending >= 0, msg: "Needs a funded escrow with a pending milestone.", title: `Arbiter tries to open a dispute on M${pending + 1}`, fn: () => E.invoke(S.contractId, kp("arbiter"), "dispute", { caller: pub("arbiter"), index: pending }) },
    early: { need: active && pending >= 0 && !pastDeadline(), msg: pastDeadline() ? "The deadline has already passed, so a refund is legitimate now." : "Needs a funded escrow with a pending milestone.", title: `Refund M${pending + 1} before the deadline`, fn: () => E.invoke(S.contractId, kp("freelancer"), "refund", { index: pending }) },
    refund2: { need: live.status !== "AwaitingFunding", msg: "Fund the vault first, then try funding it again.", title: "Client calls fund() a second time", fn: () => E.invoke(S.contractId, kp("client"), "fund") },
    overpay: { need: active && disputed >= 0, msg: "Open a dispute first, then try to overpay it as the arbiter.", title: `Arbiter resolves M${disputed + 1} for ${fmt((ms[disputed]?.amount || 0) * 2)} XLM (2× what it holds)`, fn: () => E.invoke(S.contractId, kp("arbiter"), "resolve", { index: disputed, to_freelancer: BigInt(Math.round((ms[disputed]?.amount || 0) * 2e7)) }) },
  };
  const p = plans[kind];
  if (!p.need) { lastAttack = { blocked: false, code: "setup", title: "Not available yet", why: p.msg }; return renderConsole(); }
  busy = "Firing exploit at the contract…"; renderConsole();
  try {
    const h = await p.fn();
    lastAttack = { blocked: false, code: "!!", title: p.title, why: "This went through. Check the contract." };
    log("ok", p.title, "UNEXPECTED: went through", h);
  } catch (e) {
    const x = E.explainError(e);
    lastAttack = { blocked: true, code: x.code > 0 ? `Error(Contract, #${x.code}) ${x.name}` : x.name, title: p.title, why: x.why };
    log("bad", `Attack blocked: ${p.title}`, x.code > 0 ? `Error #${x.code} ${x.name}: ${x.why}` : x.why, null);
  } finally { busy = null; await refresh(); }
}

setInterval(() => { const el = document.getElementById("cd"); if (el && S) el.innerHTML = countdown(); }, 1000);

// ---------------------------------------------------------------- showcase
async function showcase() {
  const box = document.getElementById("showcase");
  const txs = [
    ["Deploy + constructor", "client", "74b542402dc2152ded0ccd251656e859558f7f8e7b9757d62b0a518709030617"],
    ["Fund · 300 XLM locked", "client", "b63b4dd2ac73a799b8e95b3c78b1829328f397c76c19a22d0d09a109ea66385a"],
    ["Release M1 · 100 XLM", "client", "c8597fbbaf096eb6d0b7fd81fcd83b02bce47bc4998a7d431c967239eae8e696"],
    ["Dispute M2", "freelancer", "4b573d4bcda0c31d591135570de2b90e4cf922f90ce70ccfce1d7dac11ecafae"],
    ["Resolve M2 · 70/30 split", "arbiter", "e3eb27e3d51280971d416a672fcbfb1c0e8899374994cc4762f2b9a6d3d1a4e6"],
  ];
  try {
    const [d, v] = await Promise.all([E.readEscrow(E.SHOWCASE_ID), E.contractXlm(E.SHOWCASE_ID)]);
    box.innerHTML = `
      <div class="sc-top">
        <div><small class="muted">Contract</small><a class="mono" href="${E.contractLink(E.SHOWCASE_ID)}" target="_blank">${E.SHOWCASE_ID} ↗</a></div>
        <span class="status ${d.status.toLowerCase()}"><span class="dot"></span>${d.status}</span>
      </div>
      <div class="sc-grid">
        <div class="kv"><small>Total escrowed</small><b>${fmt(Number(d.config.total) / 1e7)} XLM</b></div>
        <div class="kv"><small>Vault balance now</small><b>${fmt(v)} XLM</b></div>
        <div class="kv"><small>Milestones</small><b>${d.milestones.map((m) => `<span class="badge ${{ Released: "ok", Resolved: "ok", Refunded: "blue", Disputed: "warn", Pending: "pending" }[m.state]}">${fmt(m.amount)} · ${m.state}</span>`).join(" ")}</b></div>
        <div class="kv"><small>Token</small><b>XLM (Stellar Asset Contract)</b></div>
      </div>
      <div class="sc-tx">${txs.map(([t, who, h], i) => `
        <a class="txrow" href="${E.txLink(h)}" target="_blank"><span class="tn">${i + 1}</span><b>${t}</b><span class="who">${who} signed</span><span class="mono">${h.slice(0, 10)}… ↗</span></a>`).join("")}
      </div>
      <div class="fine">Read live from Stellar testnet through Soroban RPC just now.</div>`;
  } catch (e) {
    box.innerHTML = `<div class="skeleton">Couldn't reach Stellar RPC right now. <a href="${E.contractLink(E.SHOWCASE_ID)}" target="_blank">Open it on the explorer ↗</a></div>`;
  }
}

S ? refresh() : renderSetup();
showcase();
