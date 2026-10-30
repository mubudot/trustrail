//! TEST-ONLY stand-in for the CIS-8004 Agent Registry: just enough CIS-2 (`mint`, `burn`,
//! `balanceOf`) to exercise the guard's badge check. Compiled only with `--features mock-registry`.
use crate::*;
use concordium_cis2::{BalanceOfQueryParams, BalanceOfQueryResponse, TokenAmountU64, TokenIdU64};

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct RegistryState<S = StateApi> {
    owners: StateMap<u64, AccountAddress, S>,
}

#[derive(Serialize, SchemaType)]
pub struct MintParams {
    pub token_id: u64,
    pub owner:    AccountAddress,
}

#[init(contract = "mock_registry")]
fn init(_ctx: &InitContext, sb: &mut StateBuilder) -> InitResult<RegistryState> {
    Ok(RegistryState { owners: sb.new_map() })
}

#[receive(contract = "mock_registry", name = "mint", parameter = "MintParams", mutable)]
fn mint(ctx: &ReceiveContext, host: &mut Host<RegistryState>) -> ReceiveResult<()> {
    let p: MintParams = ctx.parameter_cursor().get()?;
    let _ = host.state_mut().owners.insert(p.token_id, p.owner);
    Ok(())
}

#[receive(contract = "mock_registry", name = "burn", parameter = "u64", mutable)]
fn burn(ctx: &ReceiveContext, host: &mut Host<RegistryState>) -> ReceiveResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    host.state_mut().owners.remove(&id);
    Ok(())
}

#[receive(contract = "mock_registry", name = "balanceOf", parameter = "BalanceOfQueryParams<TokenIdU64>")]
fn balance_of(
    ctx: &ReceiveContext,
    host: &Host<RegistryState>,
) -> ReceiveResult<BalanceOfQueryResponse<TokenAmountU64>> {
    let p: BalanceOfQueryParams<TokenIdU64> = ctx.parameter_cursor().get()?;
    let mut out = Vec::new();
    for q in p.queries {
        let held = match (host.state().owners.get(&q.token_id.0), q.address) {
            (Some(o), Address::Account(a)) => *o == a,
            _ => false,
        };
        out.push(TokenAmountU64(if held { 1 } else { 0 }));
    }
    Ok(BalanceOfQueryResponse(out))
}
