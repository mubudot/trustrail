// Key helpers: seed-derived account keys (Concordium HD wallet) and standalone Ed25519 keys.
import crypto from 'node:crypto';
import { ConcordiumHdWallet } from '@concordium/web-sdk/wasm';

export function hdWallet(identity) {
  return ConcordiumHdWallet.fromHex(identity.seedAsHex, identity.net || 'Testnet');
}

/** Fresh Ed25519 key pair as raw hex (32-byte private seed, 32-byte public key). */
export function newEd25519() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  return { privateKey: priv, publicKey: pub };
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Ed25519 signature (hex) of a hex digest with a raw 32-byte private key (hex). */
export function signDigestWithKey(privateKeyHex, digestHex) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(privateKeyHex, 'hex')]), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(digestHex, 'hex'), key).toString('hex');
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export function verifyDigestWithKey(publicKeyHex, digestHex, sigHex) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(digestHex, 'hex'), key, Buffer.from(sigHex, 'hex'));
  } catch { return false; }
}
