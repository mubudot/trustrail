//! The pure, deterministic spending policy. No host access: unit-testable natively.
use crate::*;

/// Outcome of evaluating a request against a policy.
#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Decision {
    Approve,
    NeedsApproval,
}

pub fn day_of(ts: Timestamp) -> u64 { ts.timestamp_millis() / DAY_MS }

pub fn validate_policy(p: &SpendPolicy, allowlist: &[AccountAddress]) -> ContractResult<()> {
    ensure!(p.per_tx_cap > 0 && p.daily_cap >= p.per_tx_cap, Error::InvalidPolicy);
    ensure!((MIN_TTL_MS..=MAX_TTL_MS).contains(&p.auth_ttl_ms), Error::InvalidPolicy);
    if let Asset::Plt(id) = &p.asset {
        ensure!(!id.is_empty() && id.len() <= MAX_TOKEN_ID_LEN, Error::InvalidPolicy);
    }
    ensure!(allowlist.len() <= MAX_ALLOWLIST, Error::AllowlistTooLong);
    for (i, a) in allowlist.iter().enumerate() {
        ensure!(!allowlist[..i].contains(a), Error::InvalidPolicy);
    }
    Ok(())
}

/// Spent amount that applies on `today` (counter resets on a new UTC day).
pub fn spent_on(agent: &AgentRecord, today: u64) -> u64 {
    if agent.day == today {
        agent.spent_today
    } else {
        0
    }
}

/// The deterministic check. Order matters: the first failing rule is reported.
pub fn evaluate(
    contract_paused: bool,
    agent: Option<&AgentRecord>,
    payee: &AccountAddress,
    asset: &Asset,
    amount: u64,
    mode: PayMode,
    today: u64,
) -> ContractResult<Decision> {
    ensure!(!contract_paused, Error::Paused);
    let agent = agent.ok_or(Error::NotAgent)?;
    ensure!(!agent.paused, Error::AgentPaused);
    ensure!(*asset == agent.policy.asset, Error::AssetMismatch);
    ensure!(mode == PayMode::X402 || *asset == Asset::Ccd, Error::EscrowOnlyCcd);
    ensure!(amount > 0, Error::ZeroAmount);
    ensure!(agent.allowlist.contains(payee), Error::NotAllowlisted);
    ensure!(amount <= agent.policy.per_tx_cap, Error::PerTxCap);
    let spent = spent_on(agent, today);
    let after = spent.checked_add(amount).ok_or(Error::Overflow)?;
    ensure!(after <= agent.policy.daily_cap, Error::DailyCap);
    if amount > agent.policy.approval_threshold {
        Ok(Decision::NeedsApproval)
    } else {
        Ok(Decision::Approve)
    }
}

