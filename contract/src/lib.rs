//! # agent_spend_guard
//!
//! A deterministic spending guardrail for AI agents on Concordium.
//!
//! * The **owner** (the account that initialises the contract; on Concordium every account is
//!   backed by an identity issued by an identity provider) registers agents and sets their policy.
//! * An **agent** is a Concordium account. Before it pays anyone it must obtain an on-chain
//!   authorisation with `authorize`. The contract checks, in a fixed order: contract paused, agent
//!   registered, agent paused, asset, amount, payee allowlist, per-transaction cap, daily cap, and
//!   whether the amount needs human approval.
//! * Authorisations are either paid immediately from the contract balance (`Escrow` mode, CCD only)
//!   or recorded for an off-chain x402 payment (`X402` mode). In x402 mode the agent's paying account
//!   is co-signed by a deterministic co-signer that only signs a transfer matching an `Approved`
//!   authorisation; the resulting transaction hash is written back with `recordSettlement`.
//! * Optionally the contract is bound to a CIS-8004 Agent Registry: an agent can then only be
//!   registered with a badge (agent NFT) that the owner holds, which ties the Verified by Concordium
//!   badge, the accountable owner and the spending policy together on chain.
//! * Every state change emits an event, which together with the stored authorisation records forms
//!   the audit trail.

#![cfg_attr(target_arch = "wasm32", no_std)]

use concordium_std::*;

mod admin;
mod audit;
mod badge;
mod error;
mod events;
mod policy;
mod spend;
mod types;
mod views;

pub use error::*;
pub use events::*;
pub use policy::*;
pub use types::*;
pub(crate) use badge::*;

pub(crate) fn sender_account(ctx: &ReceiveContext) -> ContractResult<AccountAddress> {
    match ctx.sender() {
        Address::Account(a) => Ok(a),
        Address::Contract(_) => Err(Error::ContractSender),
    }
}

pub(crate) fn ensure_owner(ctx: &ReceiveContext, state: &State) -> ContractResult<()> {
    ensure!(ctx.sender().matches_account(&state.owner), Error::NotOwner);
    Ok(())
}

#[cfg(test)]
mod unit_tests;

#[cfg(feature = "mock-registry")]
pub mod mock_registry;
