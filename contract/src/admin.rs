//! Owner administration: init, agent registry, policy, pause, funds, badge re-check.
use crate::*;

#[init(contract = "agent_spend_guard", parameter = "InitParams", event = "Event", payable)]
fn init(ctx: &InitContext, state_builder: &mut StateBuilder, _amount: Amount) -> InitResult<State> {
    let params: InitParams = ctx.parameter_cursor().get()?;
    Ok(State {
        owner:           ctx.init_origin(),
        registry:        params.registry,
        cosigner:        params.cosigner,
        paused:          false,
        agents:          state_builder.new_map(),
        generations:     state_builder.new_map(),
        auths:           state_builder.new_map(),
        next_auth_id:    0,
        escrow_reserved: 0,
    })
}

#[receive(
    contract = "agent_spend_guard",
    name = "registerAgent",
    parameter = "RegisterAgentParams",
    error = "Error",
    mutable,
    enable_logger
)]
fn register_agent(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let p: RegisterAgentParams = ctx.parameter_cursor().get()?;
    ensure_owner(ctx, host.state())?;
    ensure!(host.state().agents.get(&p.agent).is_none(), Error::AlreadyRegistered);
    validate_policy(&p.policy, &p.allowlist)?;
    check_badge(host, &p.badge)?;
    let today = day_of(ctx.metadata().slot_time());
    let state = host.state_mut();
    let generation = state.generations.get(&p.agent).map(|g| *g).unwrap_or(0) + 1;
    let _ = state.generations.insert(p.agent, generation);
    let _ = state.agents.insert(p.agent, AgentRecord {
        badge: p.badge,
        policy: p.policy,
        allowlist: p.allowlist,
        paused: false,
        generation,
        day: today,
        spent_today: 0,
        total: 0,
    });
    logger.log(&Event::AgentRegistered { agent: p.agent, generation, badge: p.badge })?;
    Ok(())
}

#[receive(
    contract = "agent_spend_guard",
    name = "removeAgent",
    parameter = "AccountAddress",
    error = "Error",
    mutable,
    enable_logger
)]
fn remove_agent(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let agent: AccountAddress = ctx.parameter_cursor().get()?;
    ensure_owner(ctx, host.state())?;
    let state = host.state_mut();
    let rec = state.agents.get(&agent).map(|r| r.clone()).ok_or(Error::NotAgent)?;
    state.agents.remove(&agent);
    logger.log(&Event::AgentRemoved { agent, generation: rec.generation })?;
    Ok(())
}

#[receive(
    contract = "agent_spend_guard",
    name = "updatePolicy",
    parameter = "UpdatePolicyParams",
    error = "Error",
    mutable,
    enable_logger
)]
fn update_policy(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let p: UpdatePolicyParams = ctx.parameter_cursor().get()?;
    ensure_owner(ctx, host.state())?;
    let state = host.state_mut();
    let mut rec = state.agents.get(&p.agent).map(|r| r.clone()).ok_or(Error::NotAgent)?;
    validate_policy(&p.policy, &rec.allowlist)?;
    // Changing the asset would make the day's counter meaningless: refuse it (remove + re-register).
    ensure!(p.policy.asset == rec.policy.asset, Error::AssetMismatch);
    rec.policy = p.policy.clone();
    let _ = state.agents.insert(p.agent, rec);
    logger.log(&Event::PolicyUpdated { agent: p.agent, policy: p.policy })?;
    Ok(())
}

#[receive(
    contract = "agent_spend_guard",
    name = "setAllowlist",
    parameter = "SetAllowlistParams",
    error = "Error",
    mutable,
    enable_logger
)]
fn set_allowlist(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let p: SetAllowlistParams = ctx.parameter_cursor().get()?;
    ensure_owner(ctx, host.state())?;
    let state = host.state_mut();
    let mut rec = state.agents.get(&p.agent).map(|r| r.clone()).ok_or(Error::NotAgent)?;
    validate_policy(&rec.policy, &p.allowlist)?;
    rec.allowlist = p.allowlist.clone();
    let _ = state.agents.insert(p.agent, rec);
    logger.log(&Event::AllowlistUpdated { agent: p.agent, allowlist: p.allowlist })?;
    Ok(())
}

#[receive(
    contract = "agent_spend_guard",
    name = "setAgentPaused",
    parameter = "SetAgentPausedParams",
    error = "Error",
    mutable,
    enable_logger
)]
fn set_agent_paused(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let p: SetAgentPausedParams = ctx.parameter_cursor().get()?;
    let state = host.state_mut();
    let mut rec = state.agents.get(&p.agent).map(|r| r.clone()).ok_or(Error::NotAgent)?;
    // The owner can pause and unpause. The agent itself may only pause (a "kill switch").
    let is_owner = ctx.sender().matches_account(&state.owner);
    let is_self_pause = ctx.sender().matches_account(&p.agent) && p.paused;
    ensure!(is_owner || is_self_pause, Error::NotOwner);
    rec.paused = p.paused;
    let _ = state.agents.insert(p.agent, rec);
    logger.log(&Event::AgentPausedSet { agent: p.agent, paused: p.paused })?;
    Ok(())
}

#[receive(
    contract = "agent_spend_guard",
    name = "setPaused",
    parameter = "bool",
    error = "Error",
    mutable,
    enable_logger
)]
fn set_paused(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let paused: bool = ctx.parameter_cursor().get()?;
    ensure_owner(ctx, host.state())?;
    host.state_mut().paused = paused;
    logger.log(&Event::ContractPausedSet { paused })?;
    Ok(())
}

#[receive(
    contract = "agent_spend_guard",
    name = "setCosigner",
    parameter = "Option<AccountAddress>",
    error = "Error",
    mutable,
    enable_logger
)]
fn set_cosigner(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let cosigner: Option<AccountAddress> = ctx.parameter_cursor().get()?;
    ensure_owner(ctx, host.state())?;
    host.state_mut().cosigner = cosigner;
    logger.log(&Event::CosignerSet { cosigner })?;
    Ok(())
}

/// Anyone may re-check that the owner still holds an agent's badge; if not, the agent is paused.
#[receive(
    contract = "agent_spend_guard",
    name = "recheckBadge",
    parameter = "AccountAddress",
    return_value = "bool",
    error = "Error",
    mutable,
    enable_logger
)]
fn recheck_badge(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<bool> {
    let agent: AccountAddress = ctx.parameter_cursor().get()?;
    let mut rec = host.state().agents.get(&agent).map(|r| r.clone()).ok_or(Error::NotAgent)?;
    let ok = match rec.badge {
        Some(b) => owner_holds_badge(host, &b, host.state().owner)?,
        None => host.state().registry.is_none(),
    };
    if !ok && !rec.paused {
        rec.paused = true;
        let _ = host.state_mut().agents.insert(agent, rec);
        logger.log(&Event::BadgeLost { agent })?;
    }
    Ok(ok)
}

#[receive(
    contract = "agent_spend_guard",
    name = "deposit",
    error = "Error",
    payable,
    enable_logger
)]
fn deposit(ctx: &ReceiveContext, _host: &Host<State>, amount: Amount, logger: &mut Logger) -> ContractResult<()> {
    logger.log(&Event::Deposit { from: ctx.sender(), amount })?;
    Ok(())
}

#[receive(
    contract = "agent_spend_guard",
    name = "withdraw",
    parameter = "Amount",
    error = "Error",
    mutable,
    enable_logger
)]
fn withdraw(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let amount: Amount = ctx.parameter_cursor().get()?;
    ensure_owner(ctx, host.state())?;
    let free = host.self_balance().micro_ccd.saturating_sub(host.state().escrow_reserved);
    ensure!(amount.micro_ccd <= free, Error::InsufficientFunds);
    let owner = host.state().owner;
    host.invoke_transfer(&owner, amount)?;
    logger.log(&Event::Withdraw { to: owner, amount })?;
    Ok(())
}

