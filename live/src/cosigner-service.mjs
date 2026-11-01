// Authenticated HTTP boundary around a service-owned LiveCosigner. Configuration is supplied
// by the service operator at startup; HTTP callers can submit only signing/cancellation inputs.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { LiveCosigner, CosignRefused } from './cosigner-live.mjs';
import { WalletNonces } from './cosigner-nonces.mjs';

const idOK = (id) => typeof id === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(id) && BigInt(id) <= 18446744073709551615n;
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const keysOnly = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const fail = (reason) => { throw new CosignRefused(reason); };

async function readJSON(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65_536) fail('request_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid_json'); }
}

export function createCosignerService({ config, token }) {
  for (const field of ['guard', 'network', 'owner', 'agentAccount', 'account', 'walletKey', 'agentPublicKey', 'resolver', 'approvals']) {
    if (!config?.[field]) throw new Error(`missing service config: ${field}`);
  }
  if (config.humanProofAbove === undefined || BigInt(config.humanProofAbove) < 0n) throw new Error('missing or invalid pinned threshold');
  if (typeof token !== 'string' || token.length < 32) throw new Error('cosigner bearer token must have at least 32 characters');
  const expected = Buffer.from(`Bearer ${token}`);
  const network = config.network;
  const cosigner = new LiveCosigner({ ...config, requireVerifiedPayee: true });
  const nonces = new WalletNonces({ guard: cosigner.guard, file: config.nonceStateFile,
    scope: JSON.stringify([network, String(cosigner.guard.address.index), String(cosigner.guard.address.subindex), cosigner.agentAccount]) });

  const server = createServer(async (req, res) => {
    let authId = null;
    const reply = (code, data) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ authId, ...data }));
    };
    const header = Buffer.from(req.headers.authorization ?? '');
    if (header.length !== expected.length || !timingSafeEqual(header, expected)) {
      // Correlate an auth failure without consuming or parsing an unauthenticated body.
      reply(401, { status: 'refused', reason: 'unauthenticated' });
      return;
    }
    if (req.method !== 'POST' || !['/cosign', '/release'].includes(req.url)) {
      reply(404, { status: 'refused', reason: 'unknown_endpoint' }); return;
    }
    try {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail('content_type');
      const input = await readJSON(req);
      if (idOK(input?.authId)) authId = input.authId;
      if (authId === null) fail('invalid_auth_id');
      const wallet = (await cosigner.guard.agent(cosigner.agentAccount))?.record.wallet;
      if (!wallet) fail('unknown_agent');
      if (req.url === '/release') {
        if (!keysOnly(input, ['authId'])) fail('invalid_arguments');
        const out = await nonces.run(wallet, async () => {
          const view = await cosigner.guard.authorization(BigInt(authId));
          if (!view || view.auth.agent !== cosigner.agentAccount) fail('authorization_for_other_agent');
          const released = await cosigner.releaseWithReceipt(BigInt(authId));
          await nonces.reconcile(wallet);
          return released;
        });
        reply(200, { status: 'released', released: out.released, receipt: { cancelTx: out.cancelTx } });
        return;
      }
      if (!keysOnly(input, ['authId', 'signableJSON', 'resourceUrl', 'requirements'])
        || !object(input.signableJSON) || !object(input.requirements)
        || typeof input.resourceUrl !== 'string' || input.resourceUrl.length > 2048) fail('invalid_arguments');
      if (input.requirements.network !== network) fail('network_mismatch');
      // Persist the checked transaction's nonce, digest and signed expiry before commitPayment.
      const out = await nonces.run(wallet, () => cosigner.cosignWithReceipt({ ...input, authId: BigInt(authId) },
        { beforeCommit: (reservation) => nonces.reserve(reservation) }));
      reply(200, { status: 'signed', signature: out.signature, receipt: { commitTx: out.commitTx, digest: out.digest } });
    } catch (e) {
      if (e instanceof CosignRefused) reply(422, { status: 'refused', reason: e.reason });
      else reply(503, { status: 'unavailable', reason: 'cosigner_unavailable' });
    }
  });
  server.requestTimeout = 130_000;
  return server;
}
