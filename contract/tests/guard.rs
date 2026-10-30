//! End-to-end tests of the deployed Wasm in an in-memory chain.
//! Run `scripts/build-wasm.sh` first (it builds the guard and the test-only registry).
mod common;

use agent_spend_guard::*;
use common::*;
use concordium_smart_contract_testing::*;
use concordium_std::{to_bytes, HashSha2256};

fn badge7(env: &Env) -> Option<BadgeRef> { Some(BadgeRef { registry: env.registry.unwrap(), token_id: 7 }) }

#[test]
fn only_owner_administers() {
    let mut env = setup(false, OWNER);
    let p = RegisterAgentParams { agent: AGENT, wallet: WALLET, badge: None, policy: policy(), allowlist: vec![PAYEE] };
    assert_eq!(env.fails(STRANGER, "registerAgent", &p), Error::NotOwner);
    env.register(None).unwrap();
    assert_eq!(env.register(None).map(|_| ()).map_err(|e| err_of(&e).unwrap()), Err(Error::AlreadyRegistered));
    assert_eq!(env.fails(AGENT, "setPaused", &true), Error::NotOwner);
    assert_eq!(env.fails(AGENT, "withdraw", &Amount::from_micro_ccd(1)), Error::NotOwner);
    assert_eq!(env.fails(AGENT, "setAllowlist", &SetAllowlistParams { agent: AGENT, allowlist: vec![STRANGER] }), Error::NotOwner);
}

#[test]
fn x402_flow_commit_then_settle() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let out = env.auth(40, PayMode::X402).unwrap();
    assert_eq!(out.status, AuthStatus::Approved);
    assert_eq!(env.agent().spent_today_now, 40);
    let s = SettleParams { id: out.id, tx_hash: HashSha2256([5u8; 32]) };
    // no settlement without the co-signer's commitment
    assert_eq!(env.fails(AGENT, "recordSettlement", &s), Error::WrongStatus);
    let c = CommitParams { id: out.id, digest: HashSha2256([6u8; 32]) };
    assert_eq!(env.fails(AGENT, "commitPayment", &c), Error::NotPermitted);
    assert_eq!(env.fails(STRANGER, "commitPayment", &c), Error::NotPermitted);
    env.ok(COSIGNER, "commitPayment", &c);
    // single use: a second commitment (e.g. a restarted co-signer) is refused on chain
    assert_eq!(env.fails(COSIGNER, "commitPayment", &c), Error::WrongStatus);
    // a committed payment can no longer be cancelled for a refund
    assert_eq!(env.fails(AGENT, "cancel", &out.id), Error::WrongStatus);
    assert_eq!(env.fails(STRANGER, "recordSettlement", &s), Error::NotPermitted);
    env.ok(AGENT, "recordSettlement", &s);
    let a = env.authorization(out.id);
    assert_eq!(a.auth.status, AuthStatus::Settled);
    assert_eq!(a.auth.commitment, Some(HashSha2256([6u8; 32])));
    assert_eq!(a.auth.settlement, Some(HashSha2256([5u8; 32])));
    assert_eq!(env.fails(AGENT, "recordSettlement", &s), Error::WrongStatus); // no double settle
    // one transaction cannot settle two authorisations
    let out2 = env.auth(10, PayMode::X402).unwrap();
    env.ok(COSIGNER, "commitPayment", &CommitParams { id: out2.id, digest: HashSha2256([7u8; 32]) });
    let s2 = SettleParams { id: out2.id, tx_hash: HashSha2256([5u8; 32]) };
    assert_eq!(env.fails(AGENT, "recordSettlement", &s2), Error::DuplicateSettlement);
    assert_eq!(env.agent().spent_today_now, 50);
}

#[test]
fn commit_rechecks_live_controls() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let a = env.auth(10, PayMode::X402).unwrap();
    let c = |id| CommitParams { id, digest: HashSha2256([1; 32]) };
    env.ok(OWNER, "setPaused", &true);
    assert_eq!(env.fails(COSIGNER, "commitPayment", &c(a.id)), Error::Paused);
    env.ok(OWNER, "setPaused", &false);
    env.ok(OWNER, "setAgentPaused", &SetAgentPausedParams { agent: AGENT, paused: true });
    assert_eq!(env.fails(COSIGNER, "commitPayment", &c(a.id)), Error::AgentPaused);
    env.ok(OWNER, "setAgentPaused", &SetAgentPausedParams { agent: AGENT, paused: false });
    env.ok(OWNER, "setAllowlist", &SetAllowlistParams { agent: AGENT, allowlist: vec![] });
    assert_eq!(env.fails(COSIGNER, "commitPayment", &c(a.id)), Error::NotAllowlisted);
    // an approved, never-committed authorisation can be cancelled and is refunded
    env.ok(AGENT, "cancel", &a.id);
    assert_eq!(env.agent().spent_today_now, 0);
}

#[test]
fn wallet_must_be_a_separate_non_payee_account() {
    let mut env = setup(false, OWNER);
    for wallet in [AGENT, OWNER, PAYEE] {
        let p = RegisterAgentParams { agent: AGENT, wallet, badge: None, policy: policy(), allowlist: vec![PAYEE] };
        assert_eq!(env.fails(OWNER, "registerAgent", &p), Error::InvalidWallet);
    }
    env.register(None).unwrap();
    assert_eq!(env.agent().record.wallet, WALLET);
    let p = SetAllowlistParams { agent: AGENT, allowlist: vec![PAYEE, WALLET] };
    assert_eq!(env.fails(OWNER, "setAllowlist", &p), Error::InvalidWallet);
}

#[test]
fn caps_and_allowlist_enforced_on_chain() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    assert_eq!(env.auth(101, PayMode::X402), Err(Error::PerTxCap));
    let p = AuthorizeParams { payee: STRANGER, asset: Asset::Ccd, amount: 1, mode: PayMode::X402, purpose_hash: HashSha2256([0; 32]) };
    assert_eq!(env.fails(AGENT, "authorize", &p), Error::NotAllowlisted);
    assert_eq!(env.fails(STRANGER, "authorize", &AuthorizeParams { payee: PAYEE, ..p.clone() }), Error::NotAgent);
    for _ in 0..5 {
        env.auth(50, PayMode::X402).unwrap();
    }
    assert_eq!(env.auth(1, PayMode::X402), Err(Error::DailyCap));
    env.tick_ms(DAY_MS);
    assert_eq!(env.auth(50, PayMode::X402).unwrap().status, AuthStatus::Approved);
}

#[test]
fn pending_needs_owner_and_reserves_budget() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let out = env.auth(100, PayMode::X402).unwrap();
    assert_eq!(out.status, AuthStatus::Pending);
    assert_eq!(env.agent().spent_today_now, 100);
    // agent cannot approve itself, cannot settle a pending one
    assert_eq!(env.fails(AGENT, "approve", &ap(out.id)), Error::NotOwner);
    let s = SettleParams { id: out.id, tx_hash: HashSha2256([1; 32]) };
    assert_eq!(env.fails(AGENT, "recordSettlement", &s), Error::WrongStatus);
    // reject releases budget
    env.ok(OWNER, "reject", &out.id);
    assert_eq!(env.agent().spent_today_now, 0);
    assert_eq!(env.fails(OWNER, "approve", &ap(out.id)), Error::WrongStatus);
    // approve path
    let out2 = env.auth(90, PayMode::X402).unwrap();
    env.ok(OWNER, "approve", &ap(out2.id));
    assert_eq!(env.authorization(out2.id).auth.status, AuthStatus::Approved);
}

#[test]
fn expiry_blocks_approval_and_settlement() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let pending = env.auth(60, PayMode::X402).unwrap();
    let approved = env.auth(10, PayMode::X402).unwrap();
    env.tick_ms(60_000);
    assert!(env.authorization(pending.id).expired);
    assert_eq!(env.fails(OWNER, "approve", &ap(pending.id)), Error::Expired);
    // the co-signer cannot commit after expiry
    let c = CommitParams { id: approved.id, digest: HashSha2256([1; 32]) };
    assert_eq!(env.fails(COSIGNER, "commitPayment", &c), Error::Expired);
    // fail closed: expired reservations still count until cancelled
    assert_eq!(env.agent().spent_today_now, 70);
    env.ok(AGENT, "cancel", &pending.id);
    assert_eq!(env.agent().spent_today_now, 10);
    assert_eq!(env.fails(STRANGER, "cancel", &approved.id), Error::NotPermitted);
}

#[test]
fn escrow_pays_from_contract_and_reserves_liquidity() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    // contract holds 1 CCD from init (1_000_000 microCCD); test amounts are microCCD
    let before = env.balance(PAYEE);
    let out = env.auth(30, PayMode::Escrow).unwrap();
    assert_eq!(out.status, AuthStatus::Settled);
    assert_eq!(env.balance(PAYEE), before + Amount::from_micro_ccd(30));
    let pend = env.auth(80, PayMode::Escrow).unwrap();
    assert_eq!(pend.status, AuthStatus::Pending);
    let v: ContractView = env.view("view", &());
    assert_eq!(v.escrow_reserved, 80);
    // owner cannot withdraw reserved liquidity
    let free = v.balance.micro_ccd - 80;
    assert_eq!(env.fails(OWNER, "withdraw", &Amount::from_micro_ccd(free + 1)), Error::InsufficientFunds);
    env.ok(OWNER, "approve", &ap(pend.id));
    assert_eq!(env.balance(PAYEE), before + Amount::from_micro_ccd(110));
    let v: ContractView = env.view("view", &());
    assert_eq!(v.escrow_reserved, 0);
    env.ok(OWNER, "withdraw", &v.balance);
}

#[test]
fn escrow_refuses_without_funds() {
    let mut env = setup(false, OWNER);
    let p = RegisterAgentParams {
        agent: AGENT,
        wallet: WALLET,
        badge: None,
        policy: SpendPolicy { per_tx_cap: 5_000_000, daily_cap: 5_000_000, approval_threshold: 5_000_000, ..policy() },
        allowlist: vec![PAYEE],
    };
    env.ok(OWNER, "registerAgent", &p);
    assert_eq!(env.auth(2_000_000, PayMode::Escrow), Err(Error::InsufficientFunds));
    env.deposit(1_000_000);
    assert_eq!(env.auth(2_000_000, PayMode::Escrow).unwrap().status, AuthStatus::Settled);
}

#[test]
fn pause_controls() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    // agent may pause itself (kill switch) but not unpause
    env.ok(AGENT, "setAgentPaused", &SetAgentPausedParams { agent: AGENT, paused: true });
    assert_eq!(env.auth(1, PayMode::X402), Err(Error::AgentPaused));
    assert_eq!(env.fails(AGENT, "setAgentPaused", &SetAgentPausedParams { agent: AGENT, paused: false }), Error::NotOwner);
    env.ok(OWNER, "setAgentPaused", &SetAgentPausedParams { agent: AGENT, paused: false });
    env.ok(OWNER, "setPaused", &true);
    assert_eq!(env.auth(1, PayMode::X402), Err(Error::Paused));
}

#[test]
fn remove_and_reregister_invalidates_old_authorizations() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let pend = env.auth(60, PayMode::X402).unwrap();
    let appr = env.auth(10, PayMode::X402).unwrap();
    env.ok(OWNER, "removeAgent", &AGENT);
    env.register(None).unwrap();
    assert_eq!(env.agent().record.generation, 2);
    assert_eq!(env.fails(OWNER, "approve", &ap(pend.id)), Error::StaleGeneration);
    let c = CommitParams { id: appr.id, digest: HashSha2256([1; 32]) };
    assert_eq!(env.fails(COSIGNER, "commitPayment", &c), Error::StaleGeneration);
    assert_eq!(env.agent().spent_today_now, 0);
}

#[test]
fn approval_rechecks_allowlist() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let pend = env.auth(60, PayMode::X402).unwrap();
    env.ok(OWNER, "setAllowlist", &SetAllowlistParams { agent: AGENT, allowlist: vec![] });
    assert_eq!(env.fails(OWNER, "approve", &ap(pend.id)), Error::NotAllowlisted);
}

#[test]
fn preview_matches_authorize_without_state_change() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let req = AuthorizeParams { payee: PAYEE, asset: Asset::Ccd, amount: 60, mode: PayMode::X402, purpose_hash: HashSha2256([0; 32]) };
    let d: Decision = env.view("preview", &PreviewParams { agent: AGENT, request: req });
    assert_eq!(d, Decision::NeedsApproval);
    assert_eq!(env.agent().spent_today_now, 0);
}

#[test]
fn badge_must_be_held_by_owner() {
    // badge #7 held by the owner: registration works
    let mut env = setup(true, OWNER);
    assert_eq!(env.register(None).map(|_| ()).map_err(|e| err_of(&e).unwrap()), Err(Error::BadgeRequired));
    let wrong = Some(BadgeRef { registry: env.guard, token_id: 7 });
    assert_eq!(env.register(wrong).map(|_| ()).map_err(|e| err_of(&e).unwrap()), Err(Error::WrongRegistry));
    let b = badge7(&env);
    env.register(b).unwrap();
    let ok: bool = {
        let r = env.ok(STRANGER, "recheckBadge", &AGENT);
        r.parse_return_value().unwrap()
    };
    assert!(ok);

    // badge #7 held by someone else: refused
    let mut env2 = setup(true, STRANGER);
    let b2 = badge7(&env2);
    assert_eq!(env2.register(b2).map(|_| ()).map_err(|e| err_of(&e).unwrap()), Err(Error::BadgeNotOwned));
}

#[test]
fn losing_the_badge_pauses_the_agent() {
    let mut env = setup(true, OWNER);
    let b = badge7(&env);
    env.register(b).unwrap();
    env.chain
        .contract_update(Signer::with_one_key(), OWNER, Address::Account(OWNER), ENERGY, UpdateContractPayload {
            amount:       Amount::zero(),
            address:      env.registry.unwrap(),
            receive_name: OwnedReceiveName::new_unchecked("mock_registry.burn".into()),
            message:      OwnedParameter::from_serial(&7u64).unwrap(),
        })
        .unwrap();
    let r = env.ok(STRANGER, "recheckBadge", &AGENT);
    assert!(!r.parse_return_value::<bool>().unwrap());
    assert!(env.agent().record.paused);
    assert_eq!(env.auth(1, PayMode::X402), Err(Error::AgentPaused));
}

#[test]
fn events_form_an_audit_trail() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let p = AuthorizeParams { payee: PAYEE, asset: Asset::Ccd, amount: 60, mode: PayMode::X402, purpose_hash: HashSha2256([7; 32]) };
    let r = env.ok(AGENT, "authorize", &p);
    let evs: Vec<_> = r.events().flat_map(|(_, e)| e.to_vec()).collect();
    assert_eq!(evs.len(), 1);
    let expected = to_bytes(&Event::PendingApproval {
        id: 0,
        agent: AGENT,
        payee: PAYEE,
        amount: 60,
        mode: PayMode::X402,
        purpose_hash: HashSha2256([7; 32]),
    });
    assert_eq!(evs[0].as_ref(), expected.as_slice());
}

#[test]
fn approval_records_the_human_proof() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let small = env.auth(10, PayMode::X402).unwrap();
    assert_eq!(env.authorization(small.id).auth.human_proof, None, "auto-approved: no human involved");
    let big = env.auth(90, PayMode::X402).unwrap();
    let r = env.ok(OWNER, "approve", &ap(big.id));
    let a = env.authorization(big.id).auth;
    assert_eq!(a.status, AuthStatus::Approved);
    assert_eq!(a.human_proof, Some(HUMAN_PROOF));
    let evs: Vec<_> = r.events().flat_map(|(_, e)| e.to_vec()).collect();
    assert_eq!(evs[0].as_ref(), to_bytes(&Event::Approved { id: big.id, human_proof: HUMAN_PROOF }).as_slice());
}

#[test]
fn audit_head_can_be_anchored_by_accountable_parties_only() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let p = AnchorAuditParams { head: HashSha2256([3; 32]), count: 12 };
    for who in [OWNER, AGENT, COSIGNER] {
        let r = env.ok(who, "anchorAudit", &p);
        let evs: Vec<_> = r.events().flat_map(|(_, e)| e.to_vec()).collect();
        assert_eq!(evs[0].as_ref(), to_bytes(&Event::AuditAnchored { by: who, head: p.head, count: 12 }).as_slice());
    }
    assert_eq!(env.fails(STRANGER, "anchorAudit", &p), Error::NotPermitted);
    assert_eq!(env.fails(PAYEE, "anchorAudit", &p), Error::NotPermitted);
}
