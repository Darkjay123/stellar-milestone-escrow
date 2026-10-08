//! # Milestone Escrow (Soroban)
//!
//! A client locks a stablecoin (any Stellar Asset Contract token, e.g. USDC)
//! for a freelancer, split into milestones. The client releases each milestone
//! when the work is delivered. Either party can freeze a milestone with a
//! dispute, and only the arbiter can settle it, with any split it decides.
//! After the deadline, any milestone that is still pending can be refunded to the client.
//!
//! Security properties (each one is covered by a test):
//! * Set up atomically at deploy time through `__constructor`, so nobody can
//!   front-run initialisation (a common escrow exploit on other chains).
//! * Every action that moves money calls `require_auth()` on the right party.
//! * A strict state machine per milestone, so no milestone is ever paid twice.
//! * State is written before the token transfer (checks, then effects, then
//!   interactions).
//! * Checked arithmetic throughout, plus `overflow-checks = true` in release builds.
//! * Funding checks the contract's actual balance change, so a token that
//!   charges a transfer fee can't leave the escrow short.
//! * The milestone count is capped, so storage and gas stay bounded.
//! * There is no admin key, no upgrade path and no way to sweep funds.
//!   Money only ever goes to the freelancer or the client.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, Env, Vec,
};

pub const MAX_MILESTONES: u32 = 20;
/// Instance TTL management: bump to ~30 days whenever it drops below ~7 days.
const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidParties = 1,
    NoMilestones = 2,
    TooManyMilestones = 3,
    InvalidAmount = 4,
    Overflow = 5,
    DeadlineInPast = 6,
    NotFunded = 7,
    AlreadyFunded = 8,
    MilestoneNotFound = 9,
    MilestoneNotPending = 10,
    MilestoneNotDisputed = 11,
    NotAParty = 12,
    DeadlineNotReached = 13,
    BalanceMismatch = 14,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Config,
    Milestones,
    Status,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub client: Address,
    pub freelancer: Address,
    pub arbiter: Address,
    pub token: Address,
    /// Unix timestamp (seconds) after which pending milestones are refundable.
    pub deadline: u64,
    pub total: i128,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MilestoneState {
    Pending,
    Released,
    Disputed,
    Resolved,
    Refunded,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Milestone {
    pub amount: i128,
    pub state: MilestoneState,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    AwaitingFunding,
    Active,
    Closed,
}

// ---------- events (indexable by explorers / backends) ----------
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Funded {
    #[topic]
    pub client: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Released {
    #[topic]
    pub index: u32,
    pub to: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Disputed {
    #[topic]
    pub index: u32,
    pub by: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Resolved {
    #[topic]
    pub index: u32,
    pub to_freelancer: i128,
    pub to_client: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Refunded {
    #[topic]
    pub index: u32,
    pub amount: i128,
}

#[contract]
pub struct MilestoneEscrow;

// ---------- internal helpers ----------
fn bump(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn config(env: &Env) -> Config {
    env.storage().instance().get(&DataKey::Config).unwrap()
}

fn milestones(env: &Env) -> Vec<Milestone> {
    env.storage().instance().get(&DataKey::Milestones).unwrap()
}

fn status(env: &Env) -> EscrowStatus {
    env.storage().instance().get(&DataKey::Status).unwrap()
}

fn require_active(env: &Env) {
    if status(env) != EscrowStatus::Active {
        panic_with_error!(env, Error::NotFunded);
    }
}

fn load_milestone(env: &Env, ms: &Vec<Milestone>, index: u32) -> Milestone {
    match ms.get(index) {
        Some(m) => m,
        None => panic_with_error!(env, Error::MilestoneNotFound),
    }
}

/// Persist an updated milestone and close the escrow once every milestone is final.
fn store_milestone(env: &Env, mut ms: Vec<Milestone>, index: u32, m: Milestone) {
    ms.set(index, m);
    let all_final = ms
        .iter()
        .all(|m| m.state != MilestoneState::Pending && m.state != MilestoneState::Disputed);
    env.storage().instance().set(&DataKey::Milestones, &ms);
    if all_final {
        env.storage()
            .instance()
            .set(&DataKey::Status, &EscrowStatus::Closed);
    }
}

#[contractimpl]
impl MilestoneEscrow {
    /// Runs exactly once, atomically with deployment. No separate `init`
    /// call exists, so there's nothing anyone can front-run.
    pub fn __constructor(
        env: Env,
        client: Address,
        freelancer: Address,
        arbiter: Address,
        token: Address,
        amounts: Vec<i128>,
        deadline: u64,
    ) {
        if client == freelancer || client == arbiter || freelancer == arbiter {
            panic_with_error!(&env, Error::InvalidParties);
        }
        let n = amounts.len();
        if n == 0 {
            panic_with_error!(&env, Error::NoMilestones);
        }
        if n > MAX_MILESTONES {
            panic_with_error!(&env, Error::TooManyMilestones);
        }
        if deadline <= env.ledger().timestamp() {
            panic_with_error!(&env, Error::DeadlineInPast);
        }

        let mut total: i128 = 0;
        let mut ms: Vec<Milestone> = Vec::new(&env);
        for amount in amounts.iter() {
            if amount <= 0 {
                panic_with_error!(&env, Error::InvalidAmount);
            }
            total = match total.checked_add(amount) {
                Some(t) => t,
                None => panic_with_error!(&env, Error::Overflow),
            };
            ms.push_back(Milestone {
                amount,
                state: MilestoneState::Pending,
            });
        }

        let cfg = Config {
            client,
            freelancer,
            arbiter,
            token,
            deadline,
            total,
        };
        let s = env.storage().instance();
        s.set(&DataKey::Config, &cfg);
        s.set(&DataKey::Milestones, &ms);
        s.set(&DataKey::Status, &EscrowStatus::AwaitingFunding);
        bump(&env);
    }

    /// Client deposits the full total. Checks the contract's real balance change.
    pub fn fund(env: Env) {
        let cfg = config(&env);
        cfg.client.require_auth();
        if status(&env) != EscrowStatus::AwaitingFunding {
            panic_with_error!(&env, Error::AlreadyFunded);
        }
        // Effect before interaction: mark Active first. If the transfer
        // fails, the whole transaction reverts, including this write.
        env.storage()
            .instance()
            .set(&DataKey::Status, &EscrowStatus::Active);

        let tok = token::Client::new(&env, &cfg.token);
        let me = env.current_contract_address();
        let before = tok.balance(&me);
        tok.transfer(&cfg.client, &me, &cfg.total);
        let after = tok.balance(&me);
        let received = match after.checked_sub(before) {
            Some(r) => r,
            None => panic_with_error!(&env, Error::Overflow),
        };
        if received != cfg.total {
            panic_with_error!(&env, Error::BalanceMismatch);
        }

        Funded {
            client: cfg.client,
            amount: cfg.total,
        }
        .publish(&env);
        bump(&env);
    }

    /// Client approves delivered work, paying that milestone to the freelancer.
    pub fn release(env: Env, index: u32) {
        let cfg = config(&env);
        cfg.client.require_auth();
        require_active(&env);

        let ms = milestones(&env);
        let mut m = load_milestone(&env, &ms, index);
        if m.state != MilestoneState::Pending {
            panic_with_error!(&env, Error::MilestoneNotPending);
        }
        m.state = MilestoneState::Released;
        let amount = m.amount;
        store_milestone(&env, ms, index, m);

        token::Client::new(&env, &cfg.token).transfer(
            &env.current_contract_address(),
            &cfg.freelancer,
            &amount,
        );
        Released {
            index,
            to: cfg.freelancer,
            amount,
        }
        .publish(&env);
        bump(&env);
    }

    /// Client or freelancer freezes a pending milestone for the arbiter.
    /// Once a milestone is disputed it can't be released or refunded on deadline.
    pub fn dispute(env: Env, caller: Address, index: u32) {
        let cfg = config(&env);
        if caller != cfg.client && caller != cfg.freelancer {
            panic_with_error!(&env, Error::NotAParty);
        }
        caller.require_auth();
        require_active(&env);

        let ms = milestones(&env);
        let mut m = load_milestone(&env, &ms, index);
        if m.state != MilestoneState::Pending {
            panic_with_error!(&env, Error::MilestoneNotPending);
        }
        m.state = MilestoneState::Disputed;
        store_milestone(&env, ms, index, m);

        Disputed { index, by: caller }.publish(&env);
        bump(&env);
    }

    /// Arbiter settles a disputed milestone: `to_freelancer` goes to the
    /// freelancer, the remainder goes back to the client. No funds can go anywhere else.
    pub fn resolve(env: Env, index: u32, to_freelancer: i128) {
        let cfg = config(&env);
        cfg.arbiter.require_auth();
        require_active(&env);

        let ms = milestones(&env);
        let mut m = load_milestone(&env, &ms, index);
        if m.state != MilestoneState::Disputed {
            panic_with_error!(&env, Error::MilestoneNotDisputed);
        }
        if to_freelancer < 0 || to_freelancer > m.amount {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let to_client = m.amount - to_freelancer; // safe: 0 <= to_freelancer <= amount
        m.state = MilestoneState::Resolved;
        store_milestone(&env, ms, index, m);

        let tok = token::Client::new(&env, &cfg.token);
        let me = env.current_contract_address();
        if to_freelancer > 0 {
            tok.transfer(&me, &cfg.freelancer, &to_freelancer);
        }
        if to_client > 0 {
            tok.transfer(&me, &cfg.client, &to_client);
        }
        Resolved {
            index,
            to_freelancer,
            to_client,
        }
        .publish(&env);
        bump(&env);
    }

    /// After the deadline, refund a still-pending milestone to the client.
    /// Anyone can call this (a keeper/bot can do it), because the money can only
    /// go to the client.
    pub fn refund(env: Env, index: u32) {
        let cfg = config(&env);
        require_active(&env);
        if env.ledger().timestamp() <= cfg.deadline {
            panic_with_error!(&env, Error::DeadlineNotReached);
        }

        let ms = milestones(&env);
        let mut m = load_milestone(&env, &ms, index);
        if m.state != MilestoneState::Pending {
            panic_with_error!(&env, Error::MilestoneNotPending);
        }
        m.state = MilestoneState::Refunded;
        let amount = m.amount;
        store_milestone(&env, ms, index, m);

        token::Client::new(&env, &cfg.token).transfer(
            &env.current_contract_address(),
            &cfg.client,
            &amount,
        );
        Refunded { index, amount }.publish(&env);
        bump(&env);
    }

    // ---------- read-only views ----------
    pub fn get_config(env: Env) -> Config {
        config(&env)
    }

    pub fn get_milestones(env: Env) -> Vec<Milestone> {
        milestones(&env)
    }

    pub fn get_status(env: Env) -> EscrowStatus {
        status(&env)
    }
}

#[cfg(test)]
mod test;
