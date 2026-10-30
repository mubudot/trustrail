// Concordium testnet connection constants and client factory.
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

export const TESTNET = Object.freeze({
  grpcHost: 'grpc.testnet.concordium.com',
  grpcPort: 20000,
  walletProxy: 'https://wallet-proxy.testnet.concordium.com',
  explorer: 'https://ccdexplorer.io/testnet',
  x402Network: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  agentRegistry: { index: 12802n, subindex: 0n }, // CIS-8004
  cis8: { index: 12801n, subindex: 0n },
});

export function testnetClient() {
  return new ConcordiumGRPCNodeClient(TESTNET.grpcHost, TESTNET.grpcPort, credentials.createSsl(), { timeout: 30000 });
}

export const explorerTx = (hash) => `${TESTNET.explorer}/transaction/${hash}`;
export const explorerAccount = (addr) => `${TESTNET.explorer}/account/${addr}`;
export const explorerContract = (index, sub = 0) => `${TESTNET.explorer}/instance/${index}/${sub}`;
export const explorerModule = (ref) => `${TESTNET.explorer}/module/${ref}`;

// The public testnet node occasionally answers 502/UNAVAILABLE. Read-only tools retry those.
const RETRIED = ['getBlockItemStatus', 'invokeContract', 'getAccountInfo', 'getCryptographicParameters', 'getConsensusStatus', 'getBlockInfo', 'getInstanceInfo', 'getNextAccountNonce'];
export const isTransient = (e) => e?.code === 'UNAVAILABLE' || /\b(502|503|504)\b|UNAVAILABLE|ECONNRESET/.test(String(e?.message));
export async function withRetry(fn, { tries = 4, delayMs = 1500 } = {}) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || !isTransient(e)) throw e;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
}
/** A client whose read calls retry on transient node errors (for read-only tools; never for sends). */
export function readOnlyTestnetClient() {
  const c = testnetClient();
  for (const m of RETRIED) {
    const f = c[m].bind(c);
    c[m] = (...args) => withRetry(() => f(...args));
  }
  return c;
}
