// Contract error codes, in the order of the Rust `Error` enum (contract/src/error.rs):
// reject code = -(index + 1). Keep in sync; test/policy.test.mjs checks the shared vectors.
export const ERRORS = [
  'ParseParams', 'LogFull', 'LogMalformed', 'NotOwner', 'Paused', 'NotAgent', 'AgentPaused',
  'AssetMismatch', 'ZeroAmount', 'NotAllowlisted', 'PerTxCap', 'DailyCap', 'InvalidPolicy',
  'AllowlistTooLong', 'AlreadyRegistered', 'BadgeRequired', 'WrongRegistry', 'BadgeNotOwned',
  'RegistryCallFailed', 'UnknownAuthorization', 'WrongStatus', 'Expired', 'StaleGeneration',
  'NotPermitted', 'EscrowOnlyCcd', 'InsufficientFunds', 'TransferFailed', 'Overflow', 'ContractSender',
  'DuplicateSettlement', 'InvalidWallet',
];

export const codeOf = (name) => -(ERRORS.indexOf(name) + 1);
export const nameOf = (code) => ERRORS[-code - 1] ?? `Unknown(${code})`;

/** An error carrying a contract error name, thrown by the mock chain and by preflight. */
export class GuardError extends Error {
  constructor(name, detail) {
    super(detail ? `${name}: ${detail}` : name);
    this.code = name;
  }
}
