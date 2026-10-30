// Step 1 of a throwaway TESTNET identity: create a seed + identity object request and print the
// issuance URL of the "Concordium testnet IP" (dummy attributes, no real ID). Seed stays in .secrets.
import crypto from 'node:crypto';
import { createIdentityRequest } from '@concordium/web-sdk/wasm';
import { readSecret, writeSecret } from '../src/secrets.mjs';
import { TESTNET, testnetClient } from '../src/net.mjs';

const name = process.argv[2] || 'owner';
let s = readSecret(`identity-${name}`);
if (!s) s = { seedAsHex: crypto.randomBytes(64).toString('hex'), identityIndex: 0, ipIdentity: 0, net: 'Testnet' };

const ips = await (await fetch(`${TESTNET.walletProxy}/v1/ip_info`)).json();
const ip = ips.find((x) => x.ipInfo.ipIdentity === s.ipIdentity);
const globalContext = await testnetClient().getCryptographicParameters();
const req = createIdentityRequest({
  ipInfo: ip.ipInfo, globalContext, arsInfos: ip.arsInfos, arThreshold: 1,
  seed: s.seedAsHex, net: 'Testnet', identityIndex: s.identityIndex,
});
const redirect = 'http://localhost/identity-callback';
const params = new URLSearchParams({ scope: 'identity', response_type: 'code', redirect_uri: redirect, state: JSON.stringify({ idObjectRequest: req }) });
s.issuanceUrl = `${ip.metadata.issuanceStart}?${params}`;
s.redirect = redirect;
writeSecret(`identity-${name}`, s);
console.log('identity request ready for', name, '(url saved in .secrets, length', s.issuanceUrl.length, ')');
