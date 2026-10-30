//! Data types: policy, agent and authorisation records, contract state, parameters and views.
use crate::*;

/// Milliseconds in one UTC day.
pub const DAY_MS: u64 = 86_400_000;
/// Upper bound on allowlist entries per agent.
pub const MAX_ALLOWLIST: usize = 32;
/// Upper bound on the length of a PLT token id.
pub const MAX_TOKEN_ID_LEN: usize = 64;
/// Shortest and longest authorisation lifetime.
pub const MIN_TTL_MS: u64 = 1_000;
pub const MAX_TTL_MS: u64 = DAY_MS;

/// The asset an agent's budget is denominated in. Amounts are always atomic units
/// (microCCD for CCD, the token's smallest unit for a Protocol-Level Token).
#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub enum Asset {
    Ccd,
    Plt(String),
}

/// How an authorisation is paid.
#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PayMode {
    /// The contract transfers CCD from its own balance to the payee.
    Escrow,
    /// The agent pays via x402 (sponsored transfer from its own, co-signed account).
    X402,
}

/// Spending policy of one agent.
#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct SpendPolicy {
    pub asset:              Asset,
    pub per_tx_cap:         u64,
    pub daily_cap:          u64,
    /// Amounts strictly above this need the owner's approval.
    pub approval_threshold: u64,
    /// Lifetime of an authorisation in milliseconds.
    pub auth_ttl_ms:        u64,
}

/// Reference to an agent NFT in a CIS-8004 Agent Registry (the Verified by Concordium badge).
#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub struct BadgeRef {
    pub registry: ContractAddress,
    pub token_id: u64,
}

/// Stored per-agent data.
#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct AgentRecord {
    pub badge:       Option<BadgeRef>,
    /// The agent's paying account (2-of-2: agent key + co-signer key). The agent account itself
    /// (the map key) only calls the guard; it never holds the budget. Matches CIS-8004 `agentWallet`.
    pub wallet:      AccountAddress,
    pub policy:      SpendPolicy,
    pub allowlist:   Vec<AccountAddress>,
    pub paused:      bool,
    pub generation:  u64,
    /// UTC day number the `spent_today` counter belongs to.
    pub day:         u64,
    /// Approved + pending (reserved) + settled amount on `day`.
    pub spent_today: u64,
    /// Lifetime total of authorised amounts (informational).
    pub total:       u64,
}

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AuthStatus {
    Pending,
    Approved,
    /// The co-signer committed to exactly one transfer (its signing digest) and may now sign it.
    /// From here the budget is never released: the payment may already be on chain.
    Committed,
    Settled,
    Rejected,
    Cancelled,
}

/// One authorisation (the core audit record).
#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Authorization {
    pub agent:        AccountAddress,
    pub generation:   u64,
    pub payee:        AccountAddress,
    pub asset:        Asset,
    pub amount:       u64,
    pub mode:         PayMode,
    /// SHA-256 of what is being paid for (e.g. the canonical x402 PaymentRequirements).
    pub purpose_hash: HashSha2256,
    pub status:       AuthStatus,
    pub created_at:   Timestamp,
    pub expires_at:   Timestamp,
    pub day:          u64,
    /// Signing digest of the one transfer the co-signer will sign — set by `commitPayment`.
    pub commitment:   Option<HashSha2256>,
    /// Settlement transaction hash (x402) — set by `recordSettlement`.
    pub settlement:   Option<HashSha2256>,
}

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    pub(crate) owner:           AccountAddress,
    pub(crate) registry:        Option<ContractAddress>,
    pub(crate) cosigner:        Option<AccountAddress>,
    pub(crate) paused:          bool,
    pub(crate) agents:          StateMap<AccountAddress, AgentRecord, S>,
    pub(crate) generations:     StateMap<AccountAddress, u64, S>,
    pub(crate) auths:           StateMap<u64, Authorization, S>,
    /// Settlement tx hash -> authorisation id (a tx can settle only one authorisation).
    pub(crate) settled_txs:     StateMap<HashSha2256, u64, S>,
    pub(crate) next_auth_id:    u64,
    /// CCD reserved by pending escrow authorisations (not withdrawable).
    pub(crate) escrow_reserved: u64,
}

#[derive(Serialize, SchemaType)]
pub struct InitParams {
    /// CIS-8004 registry to bind badges to (`None` = badges optional and unchecked).
    pub registry: Option<ContractAddress>,
    pub cosigner: Option<AccountAddress>,
}

#[derive(Serialize, SchemaType)]
pub struct RegisterAgentParams {
    pub agent:     AccountAddress,
    pub wallet:    AccountAddress,
    pub badge:     Option<BadgeRef>,
    pub policy:    SpendPolicy,
    pub allowlist: Vec<AccountAddress>,
}

#[derive(Serialize, SchemaType)]
pub struct UpdatePolicyParams {
    pub agent:  AccountAddress,
    pub policy: SpendPolicy,
}

#[derive(Serialize, SchemaType)]
pub struct SetAllowlistParams {
    pub agent:     AccountAddress,
    pub allowlist: Vec<AccountAddress>,
}

#[derive(Serialize, SchemaType)]
pub struct SetAgentPausedParams {
    pub agent:  AccountAddress,
    pub paused: bool,
}

#[derive(Serialize, SchemaType, Clone)]
pub struct AuthorizeParams {
    pub payee:        AccountAddress,
    pub asset:        Asset,
    pub amount:       u64,
    pub mode:         PayMode,
    pub purpose_hash: HashSha2256,
}

#[derive(Serialize, SchemaType, PartialEq, Eq, Debug)]
pub struct AuthorizeOutcome {
    pub id:         u64,
    pub status:     AuthStatus,
    pub expires_at: Timestamp,
}

#[derive(Serialize, SchemaType)]
pub struct PreviewParams {
    pub agent:   AccountAddress,
    pub request: AuthorizeParams,
}

#[derive(Serialize, SchemaType)]
pub struct CommitParams {
    pub id:     u64,
    /// Signing digest of the sponsored transfer the co-signer is about to sign.
    pub digest: HashSha2256,
}

#[derive(Serialize, SchemaType)]
pub struct SettleParams {
    pub id:      u64,
    pub tx_hash: HashSha2256,
}

#[derive(Serialize, SchemaType, PartialEq, Eq, Debug)]
pub struct ContractView {
    pub owner:           AccountAddress,
    pub registry:        Option<ContractAddress>,
    pub cosigner:        Option<AccountAddress>,
    pub paused:          bool,
    pub next_auth_id:    u64,
    pub escrow_reserved: u64,
    pub balance:         Amount,
}

#[derive(Serialize, SchemaType, PartialEq, Eq, Debug)]
pub struct AgentView {
    pub record:          AgentRecord,
    /// Spent amount that applies to the current block's UTC day.
    pub spent_today_now: u64,
}

#[derive(Serialize, SchemaType, PartialEq, Eq, Debug)]
pub struct AuthorizationView {
    pub auth:    Authorization,
    pub expired: bool,
}

