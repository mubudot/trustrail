//! Logged events — the on-chain audit trail.
use crate::*;

/// Events (audit trail). Tags stay clear of the CIS-2 reserved range 251..=255.
#[derive(Serial, SchemaType, Debug, PartialEq, Eq)]
#[concordium(repr(u8))]
pub enum Event {
    #[concordium(tag = 1)]
    AgentRegistered { agent: AccountAddress, wallet: AccountAddress, generation: u64, badge: Option<BadgeRef> },
    #[concordium(tag = 2)]
    AgentRemoved { agent: AccountAddress, generation: u64 },
    #[concordium(tag = 3)]
    PolicyUpdated { agent: AccountAddress, policy: SpendPolicy },
    #[concordium(tag = 4)]
    AllowlistUpdated { agent: AccountAddress, allowlist: Vec<AccountAddress> },
    #[concordium(tag = 5)]
    AgentPausedSet { agent: AccountAddress, paused: bool },
    #[concordium(tag = 6)]
    ContractPausedSet { paused: bool },
    #[concordium(tag = 7)]
    Authorized { id: u64, agent: AccountAddress, payee: AccountAddress, amount: u64, mode: PayMode, purpose_hash: HashSha2256 },
    #[concordium(tag = 8)]
    PendingApproval { id: u64, agent: AccountAddress, payee: AccountAddress, amount: u64, mode: PayMode, purpose_hash: HashSha2256 },
    #[concordium(tag = 9)]
    Approved { id: u64, human_proof: HashSha2256 },
    #[concordium(tag = 10)]
    Rejected { id: u64 },
    #[concordium(tag = 11)]
    Cancelled { id: u64, by: AccountAddress },
    #[concordium(tag = 12)]
    Settled { id: u64, tx_hash: Option<HashSha2256> },
    #[concordium(tag = 13)]
    Deposit { from: Address, amount: Amount },
    #[concordium(tag = 14)]
    Withdraw { to: AccountAddress, amount: Amount },
    #[concordium(tag = 15)]
    BadgeLost { agent: AccountAddress },
    #[concordium(tag = 16)]
    CosignerSet { cosigner: Option<AccountAddress> },
    #[concordium(tag = 17)]
    PaymentCommitted { id: u64, digest: HashSha2256 },
    #[concordium(tag = 18)]
    AuditAnchored { by: AccountAddress, head: HashSha2256, count: u64 },
}

