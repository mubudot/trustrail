// "A verified human approved THIS payment": Concordium Verify-and-Access (Verifiable Presentation
// V1) bound to one guard authorisation.
//
//   1. requestApproval   (verifier/co-signer) anchors a VerificationRequestV1 on chain whose context
//                        names the guard + authorisation id + amount/payee/purpose (ResourceID) and
//                        asks for an ACCOUNT-based claim "age >= 18" from a testnet identity provider.
//   2. proveApproval     (owner's wallet) builds a zero-knowledge presentation from the credential of
//                        the OWNER account (no personal data revealed).
//   3. recordApproval    (verifier) checks the proof against the chain, creates the Verification
//                        Audit Record and anchors its hash on chain (RegisterData, CCDVAA). The owner
//                        then calls guard.approve(id, anchorHash).
//   4. checkApproval     (co-signer, auditors) re-verifies everything from the record + chain before
//                        any co-signature: proof valid, credential active, credential belongs to the
//                        guard owner, ResourceID is this authorisation, anchor hash == on-chain proof.
import crypto from 'node:crypto';
import {
  VerificationRequestV1, VerifiablePresentationV1, VerificationAuditRecordV1, ConcordiumHdWallet,
} from '@concordium/web-sdk/wasm';
import {
  AccountAddress, CredentialRegistrationId, IdentityProviderDID, TransactionHash,
  createAccountCommitmentInputWithHdWallet,
} from '@concordium/web-sdk';

export const NETWORK = 'Testnet';
/** Identity providers whose credentials we accept for approvers (testnet). */
export const TRUSTED_IDPS = [0];
export const MIN_AGE = 18;

export function approvalResourceId(guard, authId) {
  return `trustrail:ccd:testnet:${guard.index}:${guard.subindex}:auth:${authId}`;
}

export function approvalContextString(auth) {
  return `approve ${auth.amount} microCCD to ${auth.payee} for purpose ${auth.purpose_hash}`;
}

function claims() {
  return VerificationRequestV1.claimsBuilder()
    .addAccountClaims(TRUSTED_IDPS.map((i) => new IdentityProviderDID(NETWORK, i)), (b) => b.addMinimumAge(MIN_AGE))
    .getClaims();
}

export async function requestApproval({ grpc, verifier, guard, authId, auth }) {
  const context = VerificationRequestV1.createSimpleContext(
    crypto.randomBytes(32), 'trustrail-approval', approvalResourceId(guard, authId), approvalContextString(auth),
  );
  const request = await VerificationRequestV1.createAndAnchor(grpc, { sender: AccountAddress.fromBase58(verifier.address), signer: verifier.signer }, context, claims());
  await grpc.waitForTransactionFinalization(request.transactionRef, 120_000);
  return request;
}

async function credIdsOf(grpc, address) {
  const info = await grpc.getAccountInfo(AccountAddress.fromBase58(address));
  return Object.values(info.accountCredentials).map((c) => c.value.contents.credId ?? c.value.contents.regId);
}

/** Owner side: ZK presentation from the owner account's credential (index 0 of that account). */
export async function proveApproval({ grpc, request, identity, credNumber, ownerAddress }) {
  const [credId] = await credIdsOf(grpc, ownerAddress);
  const statements = VerifiablePresentationV1.noRevealRequestedStatements(request.subjectClaims[0].statements);
  const subject = VerifiablePresentationV1.createAccountClaims(NETWORK, CredentialRegistrationId.fromHexString(credId), identity.ipIdentity, statements);
  const wallet = ConcordiumHdWallet.fromHex(identity.seedAsHex, NETWORK);
  const input = createAccountCommitmentInputWithHdWallet(statements, identity.ipIdentity, identity.idObject.attributeList, wallet, identity.identityIndex, credNumber);
  return VerifiablePresentationV1.createFromAnchor(grpc, request, [subject], [input], []);
}

/** Checks shared by the verifier and the co-signer. Throws with a stable reason. */
async function checkBinding(grpc, presentation, request, { ownerAddress, resourceId }) {
  const given = Object.fromEntries(request.context.given.map((g) => [g.label, g.context]));
  if (given.ResourceID !== resourceId) throw new Error('approval_wrong_resource');
  const v = await VerifiablePresentationV1.verifyWithNode(presentation, grpc, NETWORK);
  if (v.type !== 'success') throw new Error(`approval_proof_invalid: ${v.error?.message}`);
  if (!v.result.credentialsStatus.every((s) => s === 0)) throw new Error('approval_credential_not_active');
  const ownerCreds = new Set((await credIdsOf(grpc, ownerAddress)).map((c) => c.toLowerCase()));
  const subjects = v.result.request.subjectClaims;
  if (subjects.length !== 1 || !subjects[0].id?.startsWith('did:ccd:testnet:cred:')) throw new Error('approval_not_account_bound');
  if (!ownerCreds.has(subjects[0].id.split(':').pop().toLowerCase())) throw new Error('approval_not_by_owner');
}

/** Verifier: check, build the audit record, anchor it. Returns what the owner puts on chain. */
export async function recordApproval({ grpc, verifier, request, presentation, ownerAddress, resourceId }) {
  await checkBinding(grpc, presentation, request, { ownerAddress, resourceId });
  const r = await VerificationAuditRecordV1.createAndAnchor(resourceId, request, presentation, grpc,
    { metadata: { sender: AccountAddress.fromBase58(verifier.address), signer: verifier.signer } }, { network: NETWORK });
  if (r.type !== 'success') throw new Error(`approval_record_failed: ${r.error?.message}`);
  await grpc.waitForTransactionFinalization(r.result.anchorTransactionRef, 120_000);
  return {
    record: r.result.record.toJSON(),
    anchorTx: TransactionHash.toHexString(r.result.anchorTransactionRef),
    requestTx: TransactionHash.toHexString(request.transactionRef),
    anchorHash: Buffer.from(VerificationAuditRecordV1.computeAnchorHash(r.result.record)).toString('hex'),
  };
}

/** Co-signer / auditor: everything re-derived from the record JSON + chain. */
export async function checkApproval({ grpc, recordJSON, anchorTx, ownerAddress, resourceId, expectedAnchorHash }) {
  const record = VerificationAuditRecordV1.fromJSON(recordJSON);
  const hash = Buffer.from(VerificationAuditRecordV1.computeAnchorHash(record)).toString('hex');
  if (hash !== expectedAnchorHash) throw new Error('approval_hash_mismatch');
  if (record.id !== resourceId) throw new Error('approval_wrong_resource');
  await VerificationAuditRecordV1.verifyAnchor(record, TransactionHash.fromHexString(anchorTx), grpc);
  await VerificationRequestV1.verifyAnchor(record.request, grpc);
  await checkBinding(grpc, record.presentation, record.request, { ownerAddress, resourceId });
  return true;
}
