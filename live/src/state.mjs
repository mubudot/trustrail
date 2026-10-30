// Public (non-secret) testnet deployment record: live/state/testnet.json (committed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state', 'testnet.json');
const big = (k, v) => (typeof v === 'bigint' ? v.toString() : v);

export function readState() {
  return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
}
export function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(s, big, 2)}\n`);
}
