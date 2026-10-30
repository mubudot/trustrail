// Build both Agent Cards with the hosted MCP (Concordium badge extension included), write them to
// live/agent-cards/, and pin their SHA-256 on chain with setAgentURI. Hosting: the files are copied
// verbatim to the public URL (see docs/TESTNET.md); run with --pin after they are served.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { testnetClient, explorerTx } from '../src/net.mjs';
import { callTool } from '../src/registry-mcp.mjs';
import { updateContract, paramFromHex } from '../src/chain.mjs';
import { loadAccounts, roleSigner } from '../src/signers.mjs';
import { readState, writeState } from '../src/state.mjs';

export const CARD_BASE = 'https://trustrail-204-44-110-122.sslip.io/agents';
const st = readState();
const acc = loadAccounts();
const guardRef = `ccd:testnet:contract:${st.guard.address.index}:${st.guard.address.subindex}`;

const cards = {
  buyer: {
    holder: 'owner',
    name: 'TrustRail buyer agent',
    description: 'An AI purchasing agent that pays other agents and APIs with x402 on Concordium, but only inside an on-chain spend policy (agent_spend_guard). Payments above the approval threshold need a zero-knowledge proof that a verified adult holding the owner\'s identity-backed account approved that exact payment. Testnet demo.',
    skills: [{ id: 'x402-buy', name: 'Buy data over x402', description: 'Pays x402 resources in CCD within per-transaction and daily caps, only to allowlisted, badge-verified payees.', tags: ['x402', 'payments', 'spend-policy'] }],
    services: { spendGuard: guardRef, paymentWallet: acc.wallet.address, network: 'concordium:testnet' },
  },
  seller: {
    holder: 'seller',
    name: 'TrustRail demo data seller',
    description: 'A demo x402 resource server on Concordium testnet that sells small data items for CCD. Used as the verified payee in the TrustRail demo.',
    skills: [{ id: 'x402-sell', name: 'Sell data over x402', description: 'Returns HTTP 402 with Concordium exact-scheme payment requirements, settles through an x402 facilitator.', tags: ['x402', 'seller'] }],
    services: { network: 'concordium:testnet' },
  },
};

const pin = process.argv.includes('--pin');
const grpc = pin ? testnetClient() : null;
for (const [which, c] of Object.entries(cards)) {
  const badge = st.badges[which];
  const agentUri = `${CARD_BASE}/${badge.tokenId}.json`;
  const file = `agent-cards/${badge.tokenId}.json`;
  if (!pin) {
    const out = await callTool('build_agent_card', {
      network: 'testnet', name: c.name, description: c.description, agent_uri: agentUri,
      owner_account: acc[c.holder].address, token_id: badge.tokenId, skills: c.skills, services: c.services,
      provider: { organization: 'TrustRail (hackathon project)' },
    });
    const json = out.agent_card_json;
    fs.writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
    console.log(which, 'card written', file, 'sha256', createHash('sha256').update(fs.readFileSync(file)).digest('hex'), 'mcp', out.metadata_hash_hex);
    continue;
  }
  const served = Buffer.from(await (await fetch(agentUri)).arrayBuffer());
  const local = fs.readFileSync(file);
  if (!served.equals(local)) throw new Error(`${agentUri} does not serve ${file} verbatim`);
  const hash = createHash('sha256').update(served).digest('hex');
  const b = await callTool('build_set_agent_uri', { network: 'testnet', token_id: badge.tokenId, agent_uri: agentUri, metadata_hash_hex: hash, sender: acc[c.holder].address });
  const r = await updateContract(grpc, {
    sender: acc[c.holder].address, signer: roleSigner(acc[c.holder]),
    address: { index: BigInt(b.contract_address.index), subindex: BigInt(b.contract_address.subindex) },
    receiveName: b.receive_name, param: paramFromHex(b.parameter_hex), energy: BigInt(b.suggested_energy ?? 30000),
  });
  Object.assign(badge, { agentUri, cardSha256: hash, setUriTx: r.txHash });
  writeState(st);
  console.log(which, 'pinned', explorerTx(r.txHash));
}
process.exit(0);
