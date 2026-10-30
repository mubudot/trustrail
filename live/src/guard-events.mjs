// Decode the few guard events the agent needs from a transaction summary (raw event bytes:
// tag u8, then the variant's fields; see contract/src/events.rs).
export const EVENT_TAGS = { Authorized: 7, PendingApproval: 8, Approved: 9, Settled: 12, PaymentCommitted: 17, AuditAnchored: 18 };

export function guardEventsOf(summary, guardIndex) {
  const out = [];
  for (const e of summary.events ?? []) {
    if (e.address && BigInt(e.address.index) !== BigInt(guardIndex)) continue;
    for (const raw of e.events ?? []) {
      const hex = typeof raw === 'string' ? raw : Buffer.from(raw.buffer ?? raw).toString('hex');
      const b = Buffer.from(hex, 'hex');
      out.push({ tag: b[0], id: b.length >= 9 ? b.readBigUInt64LE(1) : null, hex });
    }
  }
  return out;
}

/** {id, status} of the authorisation created by an `authorize` transaction. */
export function authorizeOutcome(summary, guardIndex) {
  const ev = guardEventsOf(summary, guardIndex).find((x) => x.tag === EVENT_TAGS.Authorized || x.tag === EVENT_TAGS.PendingApproval);
  if (!ev) throw new Error('authorize produced no Authorized/PendingApproval event');
  return { id: ev.id, status: ev.tag === EVENT_TAGS.PendingApproval ? 'Pending' : 'Approved' };
}
