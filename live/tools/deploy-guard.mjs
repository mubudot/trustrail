// Deploy the agent_spend_guard module (live/deployed/agent_spend_guard.wasm.v1) and create an
// instance bound to the testnet CIS-8004 Agent Registry, with our co-signer account.
import fs from 'node:fs';
import path from 'node:path';
import { ContractName, serializeInitContractParameters, sha256 } from '@concordium/web-sdk';
import { testnetClient, TESTNET, explorerTx, explorerContract } from '../src/net.mjs';
import { deployModule, initContract } from '../src/chain.mjs';
import { loadAccounts, roleSigner } from '../src/signers.mjs';
import { DEPLOYED_DIR, CONTRACT, loadSchema, some } from '../src/guard-client.mjs';
import { readState, writeState } from '../src/state.mjs';

const st = readState();
const acc = loadAccounts();
const grpc = testnetClient();
const owner = { sender: acc.owner.address, signer: roleSigner(acc.owner) };
const wasmV1 = fs.readFileSync(path.join(DEPLOYED_DIR, `${CONTRACT}.wasm.v1`));
if (!st.guard?.moduleRef) {
  const d = await deployModule(grpc, { ...owner, wasmV1 });
  st.guard = { moduleRef: d.moduleRef, deployTx: d.txHash };
  writeState(st);
  console.log('module', d.moduleRef, explorerTx(d.txHash));
}
if (!st.guard.address) {
  const param = serializeInitContractParameters(ContractName.fromString(CONTRACT), {
    registry: some({ index: TESTNET.agentRegistry.index, subindex: TESTNET.agentRegistry.subindex }),
    cosigner: some(acc.cosigner.address),
  }, loadSchema());
  const r = await initContract(grpc, { ...owner, moduleRef: st.guard.moduleRef, contractName: CONTRACT, param });
  st.guard.address = { index: r.address.index.toString(), subindex: r.address.subindex.toString() };
  st.guard.initTx = r.txHash;
  st.guard.owner = acc.owner.address;
  st.guard.cosigner = acc.cosigner.address;
  writeState(st);
  console.log('instance', st.guard.address, explorerTx(r.txHash), explorerContract(st.guard.address.index));
}
process.exit(0);
