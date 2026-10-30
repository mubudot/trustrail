// Wires a complete offline world: owner, agent (2-of-2 account), co-signer, guard contract (mock),
// facilitator, ledger, a verified seller, an unverified seller and an attacker. Shared by the demo
// and the tests so both exercise exactly the same setup.
import { AuditLog } from '../audit/log.mjs';
import { TrustedAgent } from '../agent.mjs';
import { MockGuardChain } from '../chain/mock-guard.mjs';
import { Cosigner } from '../cosigner/cosigner.mjs';
import { FixtureBadgeResolver } from '../identity/badge.mjs';
import { newKeyPair } from '../payments/tx.mjs';
import { MockFacilitator } from './facilitator.mjs';
import { MockLedger } from './ledger.mjs';
import { MockSeller } from './seller.mjs';

export const NETWORK = 'ccd:4221332d34e1694168c2a0c0b3fd0f27'; // Concordium testnet (CAIP-2)
export const CCD = 1_000_000n; // microCCD per CCD

// Placeholder account names (real testnet addresses are base58; the mock only needs unique ids).
export const ACCOUNTS = {
  owner: 'owner-account', agent: 'agent-account', wallet: 'agent-wallet-account', cosigner: 'cosigner-account',
  facilitator: 'facilitator-account', dataSeller: 'data-seller-account',
  shadySeller: 'unverified-seller-account', attacker: 'attacker-account',
};

export function createWorld({ startMs = Date.UTC(2026, 11, 1, 9, 0, 0), policy } = {}) {
  let nowMs = startMs;
  const clock = () => nowMs;
  const advance = (ms) => { nowMs += ms; };

  const agentKeys = newKeyPair();
  const cosignerKeys = newKeyPair();
  const ledger = new MockLedger();
  // The agent's paying wallet: key 0 = agent, key 1 = co-signer, threshold 2. The agent account itself
  // (single key) only talks to the guard.
  ledger.open(ACCOUNTS.wallet, { keys: [agentKeys.publicKey, cosignerKeys.publicKey], threshold: 2, balance: 100n * CCD });
  ledger.open(ACCOUNTS.facilitator, { keys: [newKeyPair().publicKey], balance: 10n * CCD });

  const guard = new MockGuardChain({ owner: ACCOUNTS.owner, cosigner: ACCOUNTS.cosigner, clock });
  guard.registerAgent(ACCOUNTS.owner, {
    agent: ACCOUNTS.agent,
    wallet: ACCOUNTS.wallet,
    badge: { registry: 'cis8004:12802.0', tokenId: 41n },
    policy: policy ?? { asset: 'CCD', perTxCap: 5n * CCD, dailyCap: 12n * CCD, approvalThreshold: 2n * CCD, authTtlMs: 120_000n },
    allowlist: [ACCOUNTS.dataSeller, ACCOUNTS.shadySeller],
  });

  const facilitator = new MockFacilitator({ ledger, address: ACCOUNTS.facilitator, network: NETWORK, clock });
  const dataSeller = new MockSeller({
    payTo: ACCOUNTS.dataSeller, facilitator, network: NETWORK, badge: 'BadgeDataSeller',
    routes: {
      '/weather': { amount: CCD / 2n, asset: 'CCD', description: 'Hourly weather feed', body: { tokyo: '18C, clear' } },
      '/dataset': { amount: 4n * CCD, asset: 'CCD', description: 'Labelled dataset (1k rows)', body: { rows: 1000 } },
    },
  });
  const shadySeller = new MockSeller({
    payTo: ACCOUNTS.shadySeller, facilitator, network: NETWORK, badge: null,
    routes: { '/cheap-data': { amount: CCD / 10n, asset: 'CCD', description: 'Unverified data', body: { rows: 3 } } },
  });
  const attacker = new MockSeller({
    payTo: ACCOUNTS.attacker, facilitator, network: NETWORK, badge: 'BadgeDataSeller', // stolen badge string
    routes: { '/refund': { amount: 3n * CCD, asset: 'CCD', description: 'Claim your refund', body: {} } },
  });
  const hosts = { 'data.example': dataSeller, 'shady.example': shadySeller, 'attacker.example': attacker };
  const fetchImpl = (url, init) => hosts[new URL(url).host].fetch(url, init);

  const resolver = new FixtureBadgeResolver({
    BadgeDataSeller: { valid: true, active: true, owner: 'data-seller-owner', agentWallet: ACCOUNTS.dataSeller },
  });
  const cosigner = new Cosigner({ guard, account: ACCOUNTS.cosigner, keyPair: cosignerKeys, agentAccount: ACCOUNTS.agent, agentPublicKey: agentKeys.publicKey, clock });
  const audit = new AuditLog({ clock });
  const agent = new TrustedAgent({
    account: ACCOUNTS.agent, agentKey: agentKeys.privateKey, guard, cosigner, resolver, audit, fetchImpl,
    nonceOf: (a) => ledger.account(a).nonce, network: NETWORK, clock,
  });
  return { agent, guard, ledger, cosigner, audit, facilitator, fetchImpl, agentKeys, cosignerKeys, clock, advance };
}
