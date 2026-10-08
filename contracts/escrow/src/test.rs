#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, Symbol,
};

const DEADLINE: u64 = 1_000_000;

fn assert_err<T: core::fmt::Debug>(
    res: Result<T, Result<soroban_sdk::Error, soroban_sdk::InvokeError>>,
    e: Error,
) {
    match res {
        Err(Ok(got)) => assert_eq!(got, soroban_sdk::Error::from_contract_error(e as u32)),
        other => panic!("expected contract error {:?}, got {:?}", e, other),
    }
}


struct Setup {
    env: Env,
    client: Address,
    freelancer: Address,
    arbiter: Address,
    token: TokenClient<'static>,
    escrow: MilestoneEscrowClient<'static>,
}

fn setup(amounts: &[i128]) -> Setup {
    let env = Env::default();
    env.ledger().set_timestamp(100);
    env.mock_all_auths();

    let client = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let arbiter = Address::generate(&env);
    let issuer = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token = TokenClient::new(&env, &sac.address());
    StellarAssetClient::new(&env, &sac.address()).mint(&client, &1_000_000);

    let mut v = Vec::new(&env);
    for a in amounts {
        v.push_back(*a);
    }
    let id = env.register(
        MilestoneEscrow,
        (
            client.clone(),
            freelancer.clone(),
            arbiter.clone(),
            sac.address(),
            v,
            DEADLINE,
        ),
    );
    let escrow = MilestoneEscrowClient::new(&env, &id);
    Setup { env, client, freelancer, arbiter, token, escrow }
}

fn try_deploy(env: &Env, a: &Address, b: &Address, c: &Address, amounts: Vec<i128>, deadline: u64) {
    let tok = Address::generate(env);
    env.register(MilestoneEscrow, (a.clone(), b.clone(), c.clone(), tok, amounts, deadline));
}

// ---------------- happy path ----------------
#[test]
fn full_lifecycle_pays_freelancer_and_closes() {
    let s = setup(&[300, 700]);
    assert_eq!(s.escrow.get_status(), EscrowStatus::AwaitingFunding);

    s.escrow.fund();
    assert_eq!(s.token.balance(&s.escrow.address), 1_000);
    assert_eq!(s.token.balance(&s.client), 999_000);
    assert_eq!(s.escrow.get_status(), EscrowStatus::Active);

    s.escrow.release(&0);
    assert_eq!(s.token.balance(&s.freelancer), 300);
    assert_eq!(s.escrow.get_status(), EscrowStatus::Active);

    s.escrow.release(&1);
    assert_eq!(s.token.balance(&s.freelancer), 1_000);
    assert_eq!(s.token.balance(&s.escrow.address), 0);
    assert_eq!(s.escrow.get_status(), EscrowStatus::Closed);
}

// ---------------- authorization ----------------
#[test]
fn fund_requires_client_signature() {
    let s = setup(&[500]);
    s.escrow.fund();
    let auths = s.env.auths();
    assert_eq!(auths[0].0, s.client);
    assert_eq!(
        auths[0].1.function,
        AuthorizedFunction::Contract((s.escrow.address.clone(), Symbol::new(&s.env, "fund"), ().into_val(&s.env)))
    );
}

#[test]
fn release_requires_client_signature_exactly() {
    let s = setup(&[500]);
    s.escrow.fund();
    s.escrow.release(&0);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.client.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.escrow.address.clone(),
                    Symbol::new(&s.env, "release"),
                    (0u32,).into_val(&s.env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
}

#[test]
fn freelancer_cannot_release_to_themselves() {
    let s = setup(&[500]);
    s.escrow.fund();
    // Only the freelancer signs: release must fail auth.
    let res = s
        .escrow
        .mock_auths(&[MockAuth {
            address: &s.freelancer,
            invoke: &MockAuthInvoke {
                contract: &s.escrow.address,
                fn_name: "release",
                args: (0u32,).into_val(&s.env),
                sub_invokes: &[],
            },
        }])
        .try_release(&0);
    assert!(res.is_err());
    assert_eq!(s.token.balance(&s.freelancer), 0);
}

#[test]
fn client_cannot_resolve_dispute_in_own_favour() {
    let s = setup(&[500]);
    s.escrow.fund();
    s.escrow.dispute(&s.freelancer, &0);
    let res = s
        .escrow
        .mock_auths(&[MockAuth {
            address: &s.client,
            invoke: &MockAuthInvoke {
                contract: &s.escrow.address,
                fn_name: "resolve",
                args: (0u32, 0i128).into_val(&s.env),
                sub_invokes: &[],
            },
        }])
        .try_resolve(&0, &0);
    assert!(res.is_err());
    assert_eq!(s.token.balance(&s.escrow.address), 500);
}

#[test]
fn stranger_cannot_dispute() {
    let s = setup(&[500]);
    s.escrow.fund();
    let stranger = Address::generate(&s.env);
    let res = s.escrow.try_dispute(&stranger, &0);
    assert_err(res, Error::NotAParty);
}

// ---------------- state machine / double spend ----------------
#[test]
fn cannot_fund_twice() {
    let s = setup(&[500]);
    s.escrow.fund();
    assert_err(s.escrow.try_fund(), Error::AlreadyFunded);
    assert_eq!(s.token.balance(&s.escrow.address), 500);
}

#[test]
fn cannot_release_same_milestone_twice() {
    let s = setup(&[500, 500]);
    s.escrow.fund();
    s.escrow.release(&0);
    assert_err(s.escrow.try_release(&0), Error::MilestoneNotPending);
    assert_eq!(s.token.balance(&s.freelancer), 500);
}

#[test]
fn cannot_release_before_funding() {
    let s = setup(&[500]);
    assert_err(s.escrow.try_release(&0), Error::NotFunded);
}

#[test]
fn unknown_milestone_rejected() {
    let s = setup(&[500]);
    s.escrow.fund();
    assert_err(s.escrow.try_release(&7), Error::MilestoneNotFound);
}

#[test]
fn disputed_milestone_is_frozen() {
    let s = setup(&[500]);
    s.escrow.fund();
    s.escrow.dispute(&s.client, &0);
    assert_err(s.escrow.try_release(&0), Error::MilestoneNotPending);
    s.env.ledger().set_timestamp(DEADLINE + 1);
    assert_err(s.escrow.try_refund(&0), Error::MilestoneNotPending);
}

// ---------------- disputes ----------------
#[test]
fn arbiter_split_pays_both_sides_and_closes() {
    let s = setup(&[1_000]);
    s.escrow.fund();
    s.escrow.dispute(&s.freelancer, &0);
    s.escrow.resolve(&0, &700);
    // only the arbiter signed the resolution, nobody else
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, s.arbiter);
    assert_eq!(s.token.balance(&s.freelancer), 700);
    assert_eq!(s.token.balance(&s.client), 999_300);
    assert_eq!(s.token.balance(&s.escrow.address), 0);
    assert_eq!(s.escrow.get_status(), EscrowStatus::Closed);
}

#[test]
fn arbiter_cannot_pay_more_than_milestone() {
    let s = setup(&[1_000, 1_000]);
    s.escrow.fund();
    s.escrow.dispute(&s.client, &0);
    assert_err(s.escrow.try_resolve(&0, &1_001), Error::InvalidAmount);
    assert_err(s.escrow.try_resolve(&0, &-1), Error::InvalidAmount);
}

#[test]
fn cannot_resolve_undisputed_milestone() {
    let s = setup(&[1_000]);
    s.escrow.fund();
    assert_err(s.escrow.try_resolve(&0, &500), Error::MilestoneNotDisputed);
}

// ---------------- deadline refunds ----------------
#[test]
fn refund_blocked_before_deadline() {
    let s = setup(&[500]);
    s.escrow.fund();
    s.env.ledger().set_timestamp(DEADLINE);
    assert_err(s.escrow.try_refund(&0), Error::DeadlineNotReached);
}

#[test]
fn refund_after_deadline_only_pays_client() {
    let s = setup(&[300, 700]);
    s.escrow.fund();
    s.escrow.release(&0);
    s.env.ledger().set_timestamp(DEADLINE + 1);
    s.escrow.refund(&1); // permissionless: money can only go to client
    assert_eq!(s.token.balance(&s.client), 999_700);
    assert_eq!(s.token.balance(&s.freelancer), 300);
    assert_eq!(s.escrow.get_status(), EscrowStatus::Closed);
    assert_err(s.escrow.try_refund(&1), Error::NotFunded);
}

// ---------------- constructor validation ----------------
#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_same_party_twice() {
    let env = Env::default();
    let a = Address::generate(&env);
    let c = Address::generate(&env);
    try_deploy(&env, &a, &a, &c, vec![&env, 100], DEADLINE);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn rejects_no_milestones() {
    let env = Env::default();
    let (a, b, c) = (Address::generate(&env), Address::generate(&env), Address::generate(&env));
    try_deploy(&env, &a, &b, &c, Vec::new(&env), DEADLINE);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn rejects_too_many_milestones() {
    let env = Env::default();
    let (a, b, c) = (Address::generate(&env), Address::generate(&env), Address::generate(&env));
    let mut v = Vec::new(&env);
    for _ in 0..21 {
        v.push_back(1i128);
    }
    try_deploy(&env, &a, &b, &c, v, DEADLINE);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn rejects_zero_amount() {
    let env = Env::default();
    let (a, b, c) = (Address::generate(&env), Address::generate(&env), Address::generate(&env));
    try_deploy(&env, &a, &b, &c, vec![&env, 100, 0], DEADLINE);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn rejects_total_overflow() {
    let env = Env::default();
    let (a, b, c) = (Address::generate(&env), Address::generate(&env), Address::generate(&env));
    try_deploy(&env, &a, &b, &c, vec![&env, i128::MAX, 1], DEADLINE);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn rejects_past_deadline() {
    let env = Env::default();
    env.ledger().set_timestamp(500);
    let (a, b, c) = (Address::generate(&env), Address::generate(&env), Address::generate(&env));
    try_deploy(&env, &a, &b, &c, vec![&env, 100], 500);
}
