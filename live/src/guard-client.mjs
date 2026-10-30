// Async client for the deployed agent_spend_guard contract on testnet. Parameters and return
// values go through the module's embedded schema (deployed/agent_spend_guard.schema.b64), so the
// JSON shapes here are exactly what CCDExplorer shows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AccountAddress, ContractAddress, ContractName, EntrypointName, ReceiveName, Parameter,
  serializeUpdateContractParameters, deserializeReceiveReturnValue, deserializeReceiveError,
} from '@concordium/web-sdk';
import { updateContract, ChainError } from './chain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEPLOYED_DIR = path.join(HERE, '..', 'deployed');
export const CONTRACT = 'agent_spend_guard';

export function loadSchema() {
  return Buffer.from(fs.readFileSync(path.join(DEPLOYED_DIR, `${CONTRACT}.schema.b64`), 'utf8').trim(), 'base64');
}

// --- JSON helpers matching the schema JSON format -----------------------------------------
export const some = (v) => ({ Some: [v] });
export const none = () => ({ None: [] });
export const unOpt = (o) => (o && 'Some' in o ? o.Some[0] : null);
export const enumTag = (e) => Object.keys(e)[0];
export const hex32 = (h) => { if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`bad 32-byte hex: ${h}`); return h; };

export class GuardClient {
  constructor({ grpc, address, schema = loadSchema() }) {
    Object.assign(this, { grpc, address, schema });
  }

  param(entry, value) {
    return serializeUpdateContractParameters(ContractName.fromString(CONTRACT), EntrypointName.fromString(entry), value, this.schema);
  }

  async invoke(entry, value, invoker) {
    const res = await this.grpc.invokeContract({
      contract: ContractAddress.create(this.address.index, this.address.subindex),
      method: ReceiveName.fromString(`${CONTRACT}.${entry}`),
      parameter: value === undefined ? Parameter.empty() : this.param(entry, value),
      invoker: invoker ? AccountAddress.fromBase58(invoker) : undefined,
    });
    if (res.tag !== 'success') {
      const code = this.#errorName(entry, res.returnValue);
      throw new ChainError(`view ${entry} rejected: ${code}`, { rejectReason: code });
    }
    return deserializeReceiveReturnValue(res.returnValue.buffer, this.schema, ContractName.fromString(CONTRACT), EntrypointName.fromString(entry));
  }

  #errorName(entry, rv) {
    try { return enumTag(deserializeReceiveError(rv.buffer, this.schema, ContractName.fromString(CONTRACT), EntrypointName.fromString(entry))); } catch { return 'unknown'; }
  }

  /** Send an update; on reject, resolve the contract's Error variant name when possible. */
  async send(entry, value, { sender, signer, energy, microCcd }) {
    const param = value === undefined ? Parameter.empty() : this.param(entry, value);
    try {
      return await updateContract(this.grpc, { sender, signer, address: this.address, receiveName: `${CONTRACT}.${entry}`, param, energy, microCcd });
    } catch (e) {
      if (e instanceof ChainError && e.rejectReason?.tag === 'RejectedReceive') {
        // reject reason code -n maps to the n-th Error variant (see contract/src/error.rs)
        e.code = e.rejectReason.rejectReason;
        e.message += ` (contract error ${e.code})`;
      }
      throw e;
    }
  }

  view() { return this.invoke('view'); }
  agent(account) { return this.invoke('agent', account).then(unOpt); }
  authorization(id) { return this.invoke('authorization', BigInt(id)).then(unOpt); }
  /** Dry-run authorize as the agent (no state change): returns the outcome or throws with the code. */
  preview(agent, request) { return this.invoke('authorize', request, agent); }
}
