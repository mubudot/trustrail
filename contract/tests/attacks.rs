//! Attack demonstrations against the real guard Wasm, never a reimplementation of its checks.
mod common;

use agent_spend_guard::*;
use common::*;
use concordium_smart_contract_testing::*;
use concordium_std::HashSha2256;

fn blocked(label: &str, actual: Error, expected: Error) {
    assert_eq!(actual, expected);
    println!("[BLOCKED] {label:.<65} {actual:?}");
}

fn commit(id: u64, byte: u8) -> CommitParams {
    CommitParams { id, digest: HashSha2256([byte; 32]) }
}

#[test]
fn committed_human_approval_cannot_be_reused_or_refunded() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let id = env.auth(100, PayMode::X402).unwrap().id;
    env.ok(OWNER, "approve", &ap(id));
    blocked("C01 approve an already human-approved auth", env.fails(OWNER, "approve", &ap(id)), Error::WrongStatus);
    env.ok(COSIGNER, "commitPayment", &commit(id, 1));
    blocked("C02 replace a committed digest", env.fails(COSIGNER, "commitPayment", &commit(id, 2)), Error::WrongStatus);
    blocked("C03 approve after commit", env.fails(OWNER, "approve", &ap(id)), Error::WrongStatus);
    for caller in [OWNER, AGENT, COSIGNER] {
        assert_eq!(env.fails(caller, "cancel", &id), Error::WrongStatus);
    }
    println!("[BLOCKED] {:.<65} WrongStatus", "C04 reclaim committed budget via cancel (all callers)");
    assert_eq!(env.authorization(id).auth.commitment, Some(HashSha2256([1; 32])));
    assert_eq!(env.agent().spent_today_now, 100);
    env.auth(100, PayMode::X402).unwrap();
    blocked("C05 spend budget after rejected refund", env.auth(51, PayMode::X402).unwrap_err(), Error::DailyCap);
}

#[test]
fn approval_one_millisecond_before_expiry_does_not_extend_ttl() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let pending = env.auth(60, PayMode::X402).unwrap().id;
    let approved = env.auth(60, PayMode::X402).unwrap().id;
    let boundary = env.auth(10, PayMode::X402).unwrap().id;
    env.tick_ms(policy().auth_ttl_ms - 1);
    env.ok(OWNER, "approve", &ap(approved));
    env.ok(COSIGNER, "commitPayment", &commit(boundary, 3));
    env.tick_ms(1);
    blocked("C06 approve at exact TTL", env.fails(OWNER, "approve", &ap(pending)), Error::Expired);
    blocked("C07 commit at TTL despite just-in-time human approval", env.fails(COSIGNER, "commitPayment", &commit(approved, 4)), Error::Expired);
    assert_eq!(env.authorization(approved).auth.human_proof, Some(HUMAN_PROOF));
    assert_eq!(env.authorization(approved).auth.commitment, None);
    assert_eq!(env.agent().spent_today_now, 130);
    println!("[PASS]    C00 commit one millisecond before TTL remains legitimate");
}

#[test]
fn administrative_pause_blocks_every_payment_entrypoint_until_resumed() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let pending = env.auth(60, PayMode::X402).unwrap().id;
    let approved = env.auth(10, PayMode::X402).unwrap().id;
    env.ok(OWNER, "setAgentPaused", &SetAgentPausedParams { agent: AGENT, paused: true });
    blocked("C08 paused agent cannot authorize", env.auth(1, PayMode::X402).unwrap_err(), Error::AgentPaused);
    blocked("C09 owner cannot approve for paused agent", env.fails(OWNER, "approve", &ap(pending)), Error::AgentPaused);
    blocked("C10 co-signer cannot commit for paused agent", env.fails(COSIGNER, "commitPayment", &commit(approved, 5)), Error::AgentPaused);
    env.ok(OWNER, "setAgentPaused", &SetAgentPausedParams { agent: AGENT, paused: false });
    env.ok(OWNER, "setPaused", &true);
    blocked("C11 paused guard cannot authorize", env.auth(1, PayMode::X402).unwrap_err(), Error::Paused);
    blocked("C12 owner cannot approve while guard paused", env.fails(OWNER, "approve", &ap(pending)), Error::Paused);
    blocked("C13 co-signer cannot commit while guard paused", env.fails(COSIGNER, "commitPayment", &commit(approved, 5)), Error::Paused);
    assert_eq!(env.agent().spent_today_now, 70);
    env.ok(OWNER, "setPaused", &false);
    env.ok(OWNER, "approve", &ap(pending));
    env.ok(COSIGNER, "commitPayment", &commit(approved, 5));
    println!("[PASS]    C14 resume restores legitimate approval and commit");
}

#[test]
fn stale_generation_cancellation_cannot_steal_new_generations_budget() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let pending = env.auth(60, PayMode::X402).unwrap().id;
    let approved = env.auth(10, PayMode::X402).unwrap().id;
    env.ok(OWNER, "removeAgent", &AGENT);
    blocked("C15 removed agent cannot authorize", env.auth(1, PayMode::X402).unwrap_err(), Error::NotAgent);
    env.register(None).unwrap();
    let fresh = env.auth(100, PayMode::X402).unwrap().id;
    blocked("C16 stale human approval after generation bump", env.fails(OWNER, "approve", &ap(pending)), Error::StaleGeneration);
    blocked("C17 stale commit after generation bump", env.fails(COSIGNER, "commitPayment", &commit(approved, 6)), Error::StaleGeneration);
    env.ok(OWNER, "cancel", &pending);
    env.ok(AGENT, "cancel", &approved);
    assert_eq!(env.agent().record.generation, 2);
    assert_eq!(env.agent().spent_today_now, 100, "old-generation cancellation cannot refund new reservations");
    env.ok(OWNER, "approve", &ap(fresh));
    env.ok(COSIGNER, "commitPayment", &commit(fresh, 6));
    println!("[PASS]    C18 new generation retains budget and can commit its own auth");
}

#[test]
fn nonexistent_nft_registration_is_atomic_and_does_not_bump_generation() {
    let mut env = setup(true, OWNER);
    let badge = Some(BadgeRef { registry: env.registry.unwrap(), token_id: 7 });
    env.register(badge).unwrap();
    env.ok(OWNER, "removeAgent", &AGENT);
    let missing = Some(BadgeRef { registry: env.registry.unwrap(), token_id: 999 });
    let err = env.register(missing).expect_err("nonexistent NFT has balanceOf = 0");
    blocked("C19 register using NFT with balanceOf = 0", err_of(&err).unwrap(), Error::BadgeNotOwned);
    blocked("C20 failed NFT registration leaves agent absent", env.auth(1, PayMode::X402).unwrap_err(), Error::NotAgent);
    env.register(badge).unwrap();
    assert_eq!(env.agent().record.generation, 2, "failed registration must not mutate generation");
}

#[test]
fn badge_loss_recheck_invalidates_existing_approval_and_commit_paths() {
    let mut env = setup(true, OWNER);
    let badge = Some(BadgeRef { registry: env.registry.unwrap(), token_id: 7 });
    env.register(badge).unwrap();
    let pending = env.auth(60, PayMode::X402).unwrap().id;
    let approved = env.auth(10, PayMode::X402).unwrap().id;
    env.chain.contract_update(Signer::with_one_key(), OWNER, Address::Account(OWNER), ENERGY, UpdateContractPayload {
        amount: Amount::zero(), address: env.registry.unwrap(),
        receive_name: OwnedReceiveName::new_unchecked("mock_registry.burn".into()),
        message: OwnedParameter::from_serial(&7u64).unwrap(),
    }).unwrap();
    assert!(!env.ok(STRANGER, "recheckBadge", &AGENT).parse_return_value::<bool>().unwrap());
    blocked("C21 badge loss prevents existing human approval", env.fails(OWNER, "approve", &ap(pending)), Error::AgentPaused);
    blocked("C22 badge loss prevents existing approved commit", env.fails(COSIGNER, "commitPayment", &commit(approved, 7)), Error::AgentPaused);
    assert_eq!(env.agent().spent_today_now, 70);
}

#[test]
fn bypassed_client_checks_preserve_caps_allowlist_and_auth_counter() {
    let mut env = setup(false, OWNER);
    env.register(None).unwrap();
    let committed = env.auth(100, PayMode::X402).unwrap().id;
    env.ok(OWNER, "approve", &ap(committed));
    env.ok(COSIGNER, "commitPayment", &commit(committed, 8));
    let pending = env.auth(100, PayMode::X402).unwrap().id;
    let approved = env.auth(50, PayMode::X402).unwrap().id;
    blocked("C23 skip preflight: per-tx cap", env.auth(101, PayMode::X402).unwrap_err(), Error::PerTxCap);
    blocked("C24 mixed pending/approved/committed daily cap", env.auth(1, PayMode::X402).unwrap_err(), Error::DailyCap);
    env.ok(OWNER, "setAllowlist", &SetAllowlistParams { agent: AGENT, allowlist: vec![] });
    blocked("C25 skip preflight: payee not allowlisted", env.auth(1, PayMode::X402).unwrap_err(), Error::NotAllowlisted);
    blocked("C26 removed payee cannot receive human approval", env.fails(OWNER, "approve", &ap(pending)), Error::NotAllowlisted);
    blocked("C27 removed payee cannot receive committed transfer", env.fails(COSIGNER, "commitPayment", &commit(approved, 9)), Error::NotAllowlisted);
    let view: ContractView = env.view("view", &());
    assert_eq!(view.next_auth_id, 3, "failed requests must not allocate authorisations");
    assert_eq!(env.agent().spent_today_now, 250);
    assert_eq!(env.authorization(pending).auth.status, AuthStatus::Pending);
    assert_eq!(env.authorization(approved).auth.status, AuthStatus::Approved);
}
