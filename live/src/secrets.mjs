// Gitignored local secret store (live/.secrets/*.json, mode 600). Never print values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.secrets');

export function readSecret(name) {
  const p = path.join(SECRETS_DIR, `${name}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function writeSecret(name, value) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const p = path.join(SECRETS_DIR, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return p;
}
