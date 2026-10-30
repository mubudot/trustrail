// base64(JSON) — the x402 v2 header encoding (PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE).
const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
export const b64 = (o) => Buffer.from(JSON.stringify(o, replacer)).toString('base64');
export const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
