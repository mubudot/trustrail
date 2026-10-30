//! Native unit tests of the pure policy logic (no Wasm needed).
use super::*;

const B: AccountAddress = AccountAddress([2u8; 32]);
const C: AccountAddress = AccountAddress([3u8; 32]);

fn policy() -> SpendPolicy {
    SpendPolicy { asset: Asset::Ccd, per_tx_cap: 100, daily_cap: 250, approval_threshold: 50, auth_ttl_ms: 60_000 }
}

fn rec() -> AgentRecord {
    AgentRecord {
        badge: None,
        wallet: AccountAddress([9u8; 32]),
        policy: policy(),
        allowlist: vec![B],
        paused: false,
        generation: 1,
        day: 10,
        spent_today: 0,
        total: 0,
    }
}

fn ev(r: Option<&AgentRecord>, payee: AccountAddress, amount: u64, today: u64) -> ContractResult<Decision> {
    evaluate(false, r, &payee, &Asset::Ccd, amount, PayMode::X402, today)
}

#[test]
fn approve_under_threshold() { assert_eq!(ev(Some(&rec()), B, 50, 10), Ok(Decision::Approve)); }

#[test]
fn needs_approval_over_threshold() { assert_eq!(ev(Some(&rec()), B, 51, 10), Ok(Decision::NeedsApproval)); }

#[test]
fn rule_order_and_codes() {
    let r = rec();
    assert_eq!(evaluate(true, Some(&r), &B, &Asset::Ccd, 1, PayMode::X402, 10), Err(Error::Paused));
    assert_eq!(ev(None, B, 1, 10), Err(Error::NotAgent));
    let mut p = rec();
    p.paused = true;
    assert_eq!(ev(Some(&p), B, 1, 10), Err(Error::AgentPaused));
    assert_eq!(
        evaluate(false, Some(&r), &B, &Asset::Plt("EURR".into()), 1, PayMode::X402, 10),
        Err(Error::AssetMismatch)
    );
    assert_eq!(ev(Some(&r), B, 0, 10), Err(Error::ZeroAmount));
    assert_eq!(ev(Some(&r), C, 1, 10), Err(Error::NotAllowlisted));
    assert_eq!(ev(Some(&r), B, 101, 10), Err(Error::PerTxCap));
    // not allowlisted wins over per-tx cap
    assert_eq!(ev(Some(&r), C, 101, 10), Err(Error::NotAllowlisted));
}

#[test]
fn daily_cap_and_rollover() {
    let mut r = rec();
    r.spent_today = 200;
    assert_eq!(ev(Some(&r), B, 50, 10), Ok(Decision::Approve));
    assert_eq!(ev(Some(&r), B, 51, 10), Err(Error::DailyCap));
    // next UTC day: counter resets
    assert_eq!(ev(Some(&r), B, 51, 11), Ok(Decision::NeedsApproval));
    assert_eq!(spent_on(&r, 11), 0);
}

#[test]
fn overflow_is_an_error_not_a_wrap() {
    let mut r = rec();
    r.policy.per_tx_cap = u64::MAX;
    r.policy.daily_cap = u64::MAX;
    r.spent_today = u64::MAX;
    assert_eq!(ev(Some(&r), B, 1, 10), Err(Error::Overflow));
}

#[test]
fn escrow_is_ccd_only() {
    let mut r = rec();
    r.policy.asset = Asset::Plt("EURR".into());
    assert_eq!(
        evaluate(false, Some(&r), &B, &Asset::Plt("EURR".into()), 1, PayMode::Escrow, 10),
        Err(Error::EscrowOnlyCcd)
    );
    assert_eq!(
        evaluate(false, Some(&r), &B, &Asset::Plt("EURR".into()), 1, PayMode::X402, 10),
        Ok(Decision::Approve)
    );
}

#[test]
fn policy_validation() {
    assert_eq!(validate_policy(&policy(), &[B]), Ok(()));
    let mut p = policy();
    p.per_tx_cap = 0;
    assert_eq!(validate_policy(&p, &[]), Err(Error::InvalidPolicy));
    let mut p = policy();
    p.daily_cap = 99;
    assert_eq!(validate_policy(&p, &[]), Err(Error::InvalidPolicy));
    let mut p = policy();
    p.auth_ttl_ms = MAX_TTL_MS + 1;
    assert_eq!(validate_policy(&p, &[]), Err(Error::InvalidPolicy));
    let mut p = policy();
    p.asset = Asset::Plt(String::new());
    assert_eq!(validate_policy(&p, &[]), Err(Error::InvalidPolicy));
    assert_eq!(validate_policy(&policy(), &[B, B]), Err(Error::InvalidPolicy));
    let many: Vec<AccountAddress> = (0..33u8).map(|i| AccountAddress([i; 32])).collect();
    assert_eq!(validate_policy(&policy(), &many), Err(Error::AllowlistTooLong));
}

#[test]
fn day_boundaries() {
    assert_eq!(day_of(Timestamp::from_timestamp_millis(DAY_MS - 1)), 0);
    assert_eq!(day_of(Timestamp::from_timestamp_millis(DAY_MS)), 1);
}

// ---- shared vectors (spec/policy_vectors.json), also run by the JS client tests ----

fn acct(i: u64) -> AccountAddress { AccountAddress([i as u8; 32]) }

fn asset_of(s: &str) -> Asset {
    match s.strip_prefix("PLT:") {
        Some(id) => Asset::Plt(id.into()),
        None => Asset::Ccd,
    }
}

#[test]
fn shared_policy_vectors() {
    let doc: serde_json::Value =
        serde_json::from_str(include_str!("../../spec/policy_vectors.json")).expect("vectors parse");
    let base = &doc["base_agent"];
    let mut n = 0;
    for v in doc["vectors"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let mut a = base.clone();
        if let Some(p) = v.get("agent_patch") {
            for (k, val) in p.as_object().unwrap() {
                a[k] = val.clone();
            }
        }
        let record = AgentRecord {
            badge:       None,
            wallet:      acct(99),
            policy:      SpendPolicy {
                asset:              asset_of(a["asset"].as_str().unwrap()),
                per_tx_cap:         a["per_tx_cap"].as_u64().unwrap(),
                daily_cap:          a["daily_cap"].as_u64().unwrap(),
                approval_threshold: a["approval_threshold"].as_u64().unwrap(),
                auth_ttl_ms:        60_000,
            },
            allowlist:   a["allowlist"].as_array().unwrap().iter().map(|x| acct(x.as_u64().unwrap())).collect(),
            paused:      a["paused"].as_bool().unwrap(),
            generation:  1,
            day:         a["day"].as_u64().unwrap(),
            spent_today: a["spent_today"].as_u64().unwrap(),
            total:       0,
        };
        let agent = if v.get("agent").map(|x| x.is_null()).unwrap_or(false) { None } else { Some(&record) };
        let mode = if v["mode"].as_str() == Some("Escrow") { PayMode::Escrow } else { PayMode::X402 };
        let got = evaluate(
            v["contract_paused"].as_bool().unwrap_or(false),
            agent,
            &acct(v["payee"].as_u64().unwrap()),
            &asset_of(v["asset"].as_str().unwrap_or("CCD")),
            v["amount"].as_u64().unwrap(),
            mode,
            v["today"].as_u64().unwrap_or(10),
        );
        let got = match got {
            Ok(d) => format!("{:?}", d),
            Err(e) => format!("{:?}", e),
        };
        assert_eq!(got, v["expect"].as_str().unwrap(), "vector `{}`", name);
        n += 1;
    }
    assert!(n >= 10);
}
