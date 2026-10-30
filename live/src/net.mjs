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
