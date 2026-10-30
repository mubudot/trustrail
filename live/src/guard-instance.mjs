// The deployed guard instance from live/state/testnet.json.
import { testnetClient } from './net.mjs';
import { GuardClient } from './guard-client.mjs';
import { readState } from './state.mjs';

export function deployedGuard(grpc = testnetClient()) {
  const st = readState();
  if (!st.guard?.address) throw new Error('guard not deployed (run tools/deploy-guard.mjs)');
  const address = { index: BigInt(st.guard.address.index), subindex: BigInt(st.guard.address.subindex) };
  return new GuardClient({ grpc, address });
}
