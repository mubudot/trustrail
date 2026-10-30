//! Error codes (stable; mirrored by agent/src/policy/errors.mjs).
use crate::*;

#[derive(Serialize, Reject, SchemaType, Debug, PartialEq, Eq)]
pub enum Error {
    #[from(ParseError)]
    ParseParams, // -1
    LogFull,                // -2
    LogMalformed,           // -3
    NotOwner,               // -4
    Paused,                 // -5
    NotAgent,               // -6
    AgentPaused,            // -7
    AssetMismatch,          // -8
    ZeroAmount,             // -9
    NotAllowlisted,         // -10
    PerTxCap,               // -11
    DailyCap,               // -12
    InvalidPolicy,          // -13
    AllowlistTooLong,       // -14
    AlreadyRegistered,      // -15
    BadgeRequired,          // -16
    WrongRegistry,          // -17
    BadgeNotOwned,          // -18
    RegistryCallFailed,     // -19
    UnknownAuthorization,   // -20
    WrongStatus,            // -21
    Expired,                // -22
    StaleGeneration,        // -23
    NotPermitted,           // -24
    EscrowOnlyCcd,          // -25
    InsufficientFunds,      // -26
    TransferFailed,         // -27
    Overflow,               // -28
    ContractSender,         // -29
}

impl From<LogError> for Error {
    fn from(le: LogError) -> Self {
        match le {
            LogError::Full => Error::LogFull,
            LogError::Malformed => Error::LogMalformed,
        }
    }
}

impl From<TransferError> for Error {
    fn from(_: TransferError) -> Self { Error::TransferFailed }
}

pub type ContractResult<A> = Result<A, Error>;

