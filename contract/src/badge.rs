//! Agent Registry (CIS-8004 / CIS-2) badge ownership check.
use crate::*;
use concordium_cis2::{BalanceOfQuery, BalanceOfQueryParams, BalanceOfQueryResponse, TokenAmountU64, TokenIdU64};

/// Ask a CIS-8004 (CIS-2) registry whether `owner` holds the agent NFT `token_id`.
pub(crate) fn owner_holds_badge(host: &Host<State>, badge: &BadgeRef, owner: AccountAddress) -> ContractResult<bool> {
    let params = BalanceOfQueryParams {
        queries: vec![BalanceOfQuery {
            token_id: TokenIdU64(badge.token_id),
            address:  Address::Account(owner),
        }],
    };
    let rv = host
        .invoke_contract_read_only(
            &badge.registry,
            &params,
            EntrypointName::new_unchecked("balanceOf"),
            Amount::zero(),
        )
        .map_err(|_| Error::RegistryCallFailed)?
        .ok_or(Error::RegistryCallFailed)?;
    let mut rv = rv;
    let resp: BalanceOfQueryResponse<TokenAmountU64> =
        BalanceOfQueryResponse::deserial(&mut rv).map_err(|_| Error::RegistryCallFailed)?;
    ensure!(resp.0.len() == 1, Error::RegistryCallFailed);
    Ok(resp.0[0].0 >= 1)
}

pub(crate) fn check_badge(host: &Host<State>, badge: &Option<BadgeRef>) -> ContractResult<()> {
    let state = host.state();
    if let Some(registry) = state.registry {
        let b = badge.as_ref().ok_or(Error::BadgeRequired)?;
        ensure!(b.registry == registry, Error::WrongRegistry);
        ensure!(owner_holds_badge(host, b, state.owner)?, Error::BadgeNotOwned);
    }
    Ok(())
}

