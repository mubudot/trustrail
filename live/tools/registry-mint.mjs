// Mint a CIS-8004 agent NFT ("Verified by Concordium" badge) on testnet via the hosted Agent
// Registry MCP's sign-ready `build_register` payload.
//   node tools/registry-mint.mjs buyer   -> minted to the OWNER (the accountable human behind the buyer agent)
//   node tools/registry-mint.mjs seller  -> minted to the SELLER account (the payee agent)
import { testnetClient, explorerTx } from '../src/net.mjs';
import { callTool } from '../src/registry-mcp.mjs';
import { updateContract, paramFromHex } from '../src/chain.mjs';
import { loadAccounts, roleSigner } from '../src/signers.mjs';
import { readState, writeState } from '../src/state.mjs';

const which = process.argv[2] || 'buyer';
const holderRole = which === 'buyer' ? 'owner' : 'seller';
const st = readState();
st.badges ??= {};
if (st.badges[which]?.tokenId) { console.log('already minted', st.badges[which]); process.exit(0); }
const acc = loadAccounts();
const grpc = testnetClient();
const b = await callTool('build_register', { network: 'testnet', sender: acc[holderRole].address });
const res = await updateContract(grpc, {
  sender: acc[holderRole].address, signer: roleSigner(acc[holderRole]),
  address: { index: BigInt(b.contract_address.index), subindex: BigInt(b.contract_address.subindex) },
  receiveName: b.receive_name, param: paramFromHex(b.parameter_hex), energy: BigInt(b.suggested_energy),
});
// CIS-2 Mint event: tag 0xfe, token id (u8 length + bytes; CIS-8004 uses 8-byte little-endian u64).
const mint = res.summary.events.flatMap((e) => e.events ?? []).map((h) => (typeof h === 'string' ? h : Buffer.from(h.buffer ?? h).toString('hex'))).find((h) => h.startsWith('fe08'));
const tokenId = Buffer.from(mint.slice(4, 20), 'hex').readBigUInt64LE(0).toString();
const ta = await callTool('token_address', { contract_index: 12802, contract_subindex: 0, token_id: tokenId });
st.badges[which] = { holder: acc[holderRole].address, tokenId, tokenAddress: ta.token_address, mintTx: res.txHash };
writeState(st);
console.log(which, 'badge', ta.token_address, 'token', tokenId, explorerTx(res.txHash));
process.exit(0);
