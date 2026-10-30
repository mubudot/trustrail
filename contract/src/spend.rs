//! The spending flow: authorize, approve, reject, cancel, recordSettlement.
use crate::*;

/// Release a reservation made on `auth.day` if the agent's counter is still on that day.
pub(crate) fn release_budget(state: &mut State, auth: &Authorization) {
    if let Some(mut rec) = state.agents.get(&auth.agent).map(|r| r.clone()) {
        if rec.generation == auth.generation && rec.day == auth.day {
            rec.spent_today = rec.spent_today.saturating_sub(auth.amount);
            rec.total = rec.total.saturating_sub(auth.amount);
            let _ = state.agents.insert(auth.agent, rec);
        }
    }
}

pub(crate) fn get_auth(state: &State, id: u64) -> ContractResult<Authorization> {
    state.auths.get(&id).map(|a| a.clone()).ok_or(Error::UnknownAuthorization)
}

pub(crate) fn escrow_pay(host: &mut Host<State>, payee: &AccountAddress, amount: u64) -> ContractResult<()> {
    host.invoke_transfer(payee, Amount::from_micro_ccd(amount))?;
    Ok(())
}

/// Called by an agent before it pays. Returns the authorisation id and its status.
#[receive(
    contract = "agent_spend_guard",
    name = "authorize",
    parameter = "AuthorizeParams",
    return_value = "AuthorizeOutcome",
    error = "Error",
    mutable,
    enable_logger
)]
fn authorize(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<AuthorizeOutcome> {
    let p: AuthorizeParams = ctx.parameter_cursor().get()?;
    let agent = sender_account(ctx)?;
    let now = ctx.metadata().slot_time();
    let today = day_of(now);

    let (decision, mut rec) = {
        let state = host.state();
        let rec = state.agents.get(&agent).map(|r| r.clone());
        let d = evaluate(state.paused, rec.as_ref(), &p.payee, &p.asset, p.amount, p.mode, today)?;
        (d, rec.ok_or(Error::NotAgent)?)
    };

    // Escrow liquidity: the contract must be able to pay (pending payments are reserved).
    if p.mode == PayMode::Escrow {
        let free = host.self_balance().micro_ccd.saturating_sub(host.state().escrow_reserved);
        ensure!(free >= p.amount, Error::InsufficientFunds);
    }

    let expires_at = now
        .checked_add(Duration::from_millis(rec.policy.auth_ttl_ms))
        .ok_or(Error::Overflow)?;
    let status = match decision {
        Decision::Approve if p.mode == PayMode::Escrow => AuthStatus::Settled,
        Decision::Approve => AuthStatus::Approved,
        Decision::NeedsApproval => AuthStatus::Pending,
    };

    // Book the budget.
    rec.spent_today = spent_on(&rec, today) + p.amount; // checked in `evaluate`
    rec.day = today;
    rec.total = rec.total.saturating_add(p.amount);

    let state = host.state_mut();
    let id = state.next_auth_id;
    state.next_auth_id = id.checked_add(1).ok_or(Error::Overflow)?;
    let _ = state.agents.insert(agent, rec.clone());
    if status == AuthStatus::Pending && p.mode == PayMode::Escrow {
        state.escrow_reserved = state.escrow_reserved.checked_add(p.amount).ok_or(Error::Overflow)?;
    }
    let _ = state.auths.insert(id, Authorization {
        agent,
        generation: rec.generation,
        payee: p.payee,
        asset: p.asset.clone(),
        amount: p.amount,
        mode: p.mode,
        purpose_hash: p.purpose_hash,
        status,
        created_at: now,
        expires_at,
        day: today,
        settlement: None,
    });

    if status == AuthStatus::Pending {
        logger.log(&Event::PendingApproval {
            id,
            agent,
            payee: p.payee,
            amount: p.amount,
            mode: p.mode,
            purpose_hash: p.purpose_hash,
        })?;
    } else {
        logger.log(&Event::Authorized {
            id,
            agent,
            payee: p.payee,
            amount: p.amount,
            mode: p.mode,
            purpose_hash: p.purpose_hash,
        })?;
    }
    if status == AuthStatus::Settled {
        escrow_pay(host, &p.payee, p.amount)?;
        logger.log(&Event::Settled { id, tx_hash: None })?;
    }
    Ok(AuthorizeOutcome { id, status, expires_at })
}

/// Owner approves a pending authorisation. Escrow payments are executed immediately.
#[receive(
    contract = "agent_spend_guard",
    name = "approve",
    parameter = "u64",
    error = "Error",
    mutable,
    enable_logger
)]
fn approve(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let now = ctx.metadata().slot_time();
    let state = host.state();
    ensure_owner(ctx, state)?;
    ensure!(!state.paused, Error::Paused);
    let mut auth = get_auth(state, id)?;
    ensure!(auth.status == AuthStatus::Pending, Error::WrongStatus);
    ensure!(now < auth.expires_at, Error::Expired);
    let rec = state.agents.get(&auth.agent).map(|r| r.clone()).ok_or(Error::StaleGeneration)?;
    ensure!(rec.generation == auth.generation, Error::StaleGeneration);
    ensure!(!rec.paused, Error::AgentPaused);
    // Re-check the payee is still allowlisted (the owner may have removed it meanwhile).
    ensure!(rec.allowlist.contains(&auth.payee), Error::NotAllowlisted);

    let escrow = auth.mode == PayMode::Escrow;
    auth.status = if escrow { AuthStatus::Settled } else { AuthStatus::Approved };
    let state = host.state_mut();
    if escrow {
        state.escrow_reserved = state.escrow_reserved.saturating_sub(auth.amount);
    }
    let _ = state.auths.insert(id, auth.clone());
    logger.log(&Event::Approved { id })?;
    if escrow {
        escrow_pay(host, &auth.payee, auth.amount)?;
        logger.log(&Event::Settled { id, tx_hash: None })?;
    }
    Ok(())
}

#[receive(
    contract = "agent_spend_guard",
    name = "reject",
    parameter = "u64",
    error = "Error",
    mutable,
    enable_logger
)]
fn reject(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    ensure_owner(ctx, host.state())?;
    let mut auth = get_auth(host.state(), id)?;
    ensure!(auth.status == AuthStatus::Pending, Error::WrongStatus);
    auth.status = AuthStatus::Rejected;
    let state = host.state_mut();
    if auth.mode == PayMode::Escrow {
        state.escrow_reserved = state.escrow_reserved.saturating_sub(auth.amount);
    }
    release_budget(state, &auth);
    let _ = state.auths.insert(id, auth);
    logger.log(&Event::Rejected { id })?;
    Ok(())
}

/// Agent or owner withdraws an authorisation that has not been paid.
#[receive(
    contract = "agent_spend_guard",
    name = "cancel",
    parameter = "u64",
    error = "Error",
    mutable,
    enable_logger
)]
fn cancel(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let by = sender_account(ctx)?;
    let mut auth = get_auth(host.state(), id)?;
    ensure!(by == host.state().owner || by == auth.agent, Error::NotPermitted);
    ensure!(matches!(auth.status, AuthStatus::Pending | AuthStatus::Approved), Error::WrongStatus);
    let was_pending = auth.status == AuthStatus::Pending;
    auth.status = AuthStatus::Cancelled;
    let state = host.state_mut();
    if was_pending && auth.mode == PayMode::Escrow {
        state.escrow_reserved = state.escrow_reserved.saturating_sub(auth.amount);
    }
    release_budget(state, &auth);
    let _ = state.auths.insert(id, auth);
    logger.log(&Event::Cancelled { id, by })?;
    Ok(())
}

/// Agent or co-signer writes the x402 settlement transaction hash. Requires an `Approved`,
/// unexpired x402 authorisation of the current agent generation.
#[receive(
    contract = "agent_spend_guard",
    name = "recordSettlement",
    parameter = "SettleParams",
    error = "Error",
    mutable,
    enable_logger
)]
fn record_settlement(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let p: SettleParams = ctx.parameter_cursor().get()?;
    let by = sender_account(ctx)?;
    let now = ctx.metadata().slot_time();
    let state = host.state();
    let mut auth = get_auth(state, p.id)?;
    ensure!(by == auth.agent || Some(by) == state.cosigner, Error::NotPermitted);
    ensure!(auth.mode == PayMode::X402, Error::WrongStatus);
    ensure!(auth.status == AuthStatus::Approved, Error::WrongStatus);
    // A settlement is recorded after the transfer finalised; allow a short grace period after
    // expiry for the facilitator round-trip (the co-signer refuses to sign after expiry).
    let grace = auth.expires_at.checked_add(Duration::from_millis(10 * 60 * 1000)).ok_or(Error::Overflow)?;
    ensure!(now < grace, Error::Expired);
    let gen_ok = state.agents.get(&auth.agent).map(|r| r.generation == auth.generation).unwrap_or(false);
    ensure!(gen_ok, Error::StaleGeneration);
    auth.status = AuthStatus::Settled;
    auth.settlement = Some(p.tx_hash);
    let _ = host.state_mut().auths.insert(p.id, auth);
    logger.log(&Event::Settled { id: p.id, tx_hash: Some(p.tx_hash) })?;
    Ok(())
}

