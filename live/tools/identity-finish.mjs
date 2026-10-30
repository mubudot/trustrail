// Step 2: submit the testnet IP's test form with its own dummy defaults (John Doe, DK) and
// poll for the identity object. Testnet only — the form is the IdP's documented test path.
import { readSecret, writeSecret } from '../src/secrets.mjs';

const name = process.argv[2] || 'owner';
const s = readSecret(`identity-${name}`);
if (!s?.issuanceUrl) throw new Error('run identity-start first');

async function hop(url, init) {
  const r = await fetch(url, { redirect: 'manual', ...init });
  return { r, loc: r.headers.get('location') && new URL(r.headers.get('location'), url).toString() };
}

if (!s.codeUri) {
  let { loc } = await hop(s.issuanceUrl);
  const formRes = await fetch(loc);
  const html = await formRes.text();
  const fields = {};
  for (const m of html.matchAll(/<input[^>]*>/g)) {
    const tag = m[0];
    const n = tag.match(/name="([^"]+)"/)?.[1];
    if (!n || /type="checkbox"/.test(tag) || /type="submit"/.test(tag)) continue;
    fields[n] = tag.match(/value="([^"]*)"/)?.[1] ?? '';
  }
  const d = new Date();
  fields.expiry = `${d.getUTCFullYear() + 1}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const action = new URL(html.match(/<form action="([^"]+)"/)[1], loc).toString();
  let res = await hop(action, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  for (let i = 0; i < 6 && res.loc && !res.loc.startsWith(s.redirect); i++) res = await hop(res.loc);
  if (!res.loc?.startsWith(s.redirect)) throw new Error(`unexpected IdP response ${res.r.status}`);
  s.codeUri = decodeURIComponent(new URL(res.loc).hash.replace(/^#code_uri=/, ''));
  writeSecret(`identity-${name}`, s);
}
for (let i = 0; i < 30; i++) {
  const j = await (await fetch(s.codeUri)).json();
  if (j.status === 'done') {
    s.idObject = j.token.identityObject.value;
    writeSecret(`identity-${name}`, s);
    console.log('identity object received for', name);
    process.exit(0);
  }
  if (j.status === 'error') throw new Error(`IdP error: ${j.detail}`);
  await new Promise((r) => setTimeout(r, 3000));
}
console.log('still pending');
