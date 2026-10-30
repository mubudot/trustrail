//! Anchors the head of the off-chain hash-chained audit log on chain (EU AI Act Art. 12-style
//! record keeping): anyone holding the log can later prove it was not rewritten after this point.
use crate::*;

/// Owner, a registered agent or the co-signer anchors the current audit-log head.
#[receive(
    contract = "agent_spend_guard",
    name = "anchorAudit",
    parameter = "AnchorAuditParams",
    error = "Error",
    enable_logger
)]
fn anchor_audit(ctx: &ReceiveContext, host: &Host<State>, logger: &mut Logger) -> ContractResult<()> {
    let p: AnchorAuditParams = ctx.parameter_cursor().get()?;
    let by = sender_account(ctx)?;
    let st = host.state();
    ensure!(by == st.owner || Some(by) == st.cosigner || st.agents.get(&by).is_some(), Error::NotPermitted);
    logger.log(&Event::AuditAnchored { by, head: p.head, count: p.count })?;
    Ok(())
}
