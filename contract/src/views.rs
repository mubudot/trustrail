//! Read-only entrypoints (views and on-chain preflight).
use crate::*;

#[receive(contract = "agent_spend_guard", name = "view", return_value = "ContractView", error = "Error")]
fn view(_ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<ContractView> {
    let s = host.state();
    Ok(ContractView {
        owner:           s.owner,
        registry:        s.registry,
        cosigner:        s.cosigner,
        paused:          s.paused,
        next_auth_id:    s.next_auth_id,
        escrow_reserved: s.escrow_reserved,
        balance:         host.self_balance(),
    })
}

#[receive(
    contract = "agent_spend_guard",
    name = "agent",
    parameter = "AccountAddress",
    return_value = "Option<AgentView>",
    error = "Error"
)]
fn agent_view(ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<Option<AgentView>> {
    let agent: AccountAddress = ctx.parameter_cursor().get()?;
    let today = day_of(ctx.metadata().slot_time());
    Ok(host.state().agents.get(&agent).map(|r| AgentView {
        spent_today_now: spent_on(&r, today),
        record:          r.clone(),
    }))
}

#[receive(
    contract = "agent_spend_guard",
    name = "authorization",
    parameter = "u64",
    return_value = "Option<AuthorizationView>",
    error = "Error"
)]
fn authorization_view(ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<Option<AuthorizationView>> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let now = ctx.metadata().slot_time();
    Ok(host.state().auths.get(&id).map(|a| AuthorizationView {
        expired: now >= a.expires_at && matches!(a.status, AuthStatus::Pending | AuthStatus::Approved),
        auth:    a.clone(),
    }))
}

/// Dry-run of `authorize` for a given agent (used by clients for an on-chain preflight).
#[receive(
    contract = "agent_spend_guard",
    name = "preview",
    parameter = "PreviewParams",
    return_value = "Decision",
    error = "Error"
)]
fn preview(ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<Decision> {
    let p: PreviewParams = ctx.parameter_cursor().get()?;
    let today = day_of(ctx.metadata().slot_time());
    let s = host.state();
    let rec = s.agents.get(&p.agent).map(|r| r.clone());
    let r = &p.request;
    let d = evaluate(s.paused, rec.as_ref(), &r.payee, &r.asset, r.amount, r.mode, today)?;
    if r.mode == PayMode::Escrow {
        let free = host.self_balance().micro_ccd.saturating_sub(s.escrow_reserved);
        ensure!(free >= r.amount, Error::InsufficientFunds);
    }
    Ok(d)
}

