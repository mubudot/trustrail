// Generic testnet transaction helpers (sign with an AccountSigner, submit, wait for finalization).
import {
  AccountAddress, AccountTransactionType, CcdAmount, ContractAddress, ContractName, Energy, InitName,
  ModuleReference, Parameter, ReceiveName, TransactionExpiry, TransactionHash, TransactionSummaryType,
  TransactionKindString, RejectReasonTag, signTransaction, getAccountTransactionHash,
} from '@concordium/web-sdk';

export class ChainError extends Error {
  constructor(message, { rejectReason, txHash } = {}) {
    super(message);
    Object.assign(this, { rejectReason, txHash });
  }
}

/** Sign + send a legacy account transaction, wait until finalized, throw ChainError on reject. */
export async function sendAndWait(client, { sender, signer, type, payload }) {
  const senderAddr = typeof sender === 'string' ? AccountAddress.fromBase58(sender) : sender;
  const { nonce } = await client.getNextAccountNonce(senderAddr);
  const header = { expiry: TransactionExpiry.futureMinutes(5), nonce, sender: senderAddr };
  const tx = { header, payload, type };
  const signature = await signTransaction(tx, signer);
  const hash = await client.sendAccountTransaction(tx, signature);
  const outcome = await client.waitForTransactionFinalization(hash, 120_000);
  const hex = TransactionHash.toHexString(hash);
  const s = outcome.summary;
  if (s.type === TransactionSummaryType.AccountTransaction && s.transactionType === TransactionKindString.Failed) {
    throw new ChainError(`transaction rejected: ${s.failedTransactionType ?? ''} ${s.rejectReason?.tag ?? ''}`, { rejectReason: s.rejectReason, txHash: hex });
  }
  return { txHash: hex, blockHash: outcome.blockHash.toString?.() ?? String(outcome.blockHash), summary: s };
}

export async function transferCcd(client, { sender, signer, to, microCcd }) {
  return sendAndWait(client, {
    sender, signer, type: AccountTransactionType.Transfer,
    payload: { amount: CcdAmount.fromMicroCcd(BigInt(microCcd)), toAddress: AccountAddress.fromBase58(to) },
  });
}

export async function deployModule(client, { sender, signer, wasmV1 }) {
  // .wasm.v1 file = 4-byte version + 4-byte length + module bytes; the SDK wants the raw module.
  const source = wasmV1.subarray(8);
  const res = await sendAndWait(client, { sender, signer, type: AccountTransactionType.DeployModule, payload: { source, version: 1 } });
  return { ...res, moduleRef: res.summary.moduleDeployed?.contents ?? res.summary.moduleDeployed?.moduleRef?.toString?.() };
}

export async function initContract(client, { sender, signer, moduleRef, contractName, param, energy = 10_000n, microCcd = 0n }) {
  const res = await sendAndWait(client, {
    sender, signer, type: AccountTransactionType.InitContract,
    payload: {
      amount: CcdAmount.fromMicroCcd(microCcd), moduleRef: ModuleReference.fromHexString(moduleRef),
      initName: ContractName.fromString(contractName), param, maxContractExecutionEnergy: Energy.create(energy),
    },
  });
  const addr = res.summary.contractInitialized?.address;
  return { ...res, address: addr && { index: BigInt(addr.index), subindex: BigInt(addr.subindex) } };
}

export async function updateContract(client, { sender, signer, address, receiveName, param, energy = 30_000n, microCcd = 0n }) {
  return sendAndWait(client, {
    sender, signer, type: AccountTransactionType.Update,
    payload: {
      amount: CcdAmount.fromMicroCcd(microCcd), address: ContractAddress.create(address.index, address.subindex),
      receiveName: ReceiveName.fromString(receiveName), message: param, maxContractExecutionEnergy: Energy.create(energy),
    },
  });
}

export const paramFromHex = (hex) => Parameter.fromHexString(hex);
export { RejectReasonTag, getAccountTransactionHash };
