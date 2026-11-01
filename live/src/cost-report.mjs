// Pure cost accounting for recorded testnet evidence. No keys, filesystem writes or node calls.
const HASH = /^[0-9a-f]{64}$/i;
const TX_FIELD = /^(txHash|transactionRef|anchorTransactionRef)$|Tx$/;
export const COST_NOTE = 'testnet costs in test CCD; mainnet uses the same energy, but CCD cost per energy depends on the chain\'s exchange-rate parameters at the time — convert with current rates; no mainnet price is claimed. Concordium\'s euro-per-energy is a chain parameter; the EUR column applies the current testnet parameter values and would be the same on mainnet only if mainnet uses the same euro-per-energy.';
export const REQUEST_ANCHOR = 'RegisterData (verification request)';
export const APPROVAL_ANCHOR = 'RegisterData (audit record)';
const FLOW_KINDS = ['authorize', 'commitPayment', 'x402 settlement', 'recordSettlement'];

/** Only transaction fields, captured status-map keys and testnet explorer transaction URLs count.
 * Digests, module references, block hashes, public keys and audit heads are deliberately excluded. */
export function collectTransactions(documents) {
  const found = new Map();
  for (const { source, data } of documents) {
    const add = (hash, path, authId) => {
      if (!HASH.test(hash)) throw new Error(`invalid transaction hash at ${source}:${path}`);
      hash = hash.toLowerCase();
      const ref = found.get(hash) ?? { hash, sources: [], authIds: [] };
      const location = `${source}:${path}`;
      if (!ref.sources.includes(location)) ref.sources.push(location);
      if (authId !== undefined && !ref.authIds.includes(String(authId))) ref.authIds.push(String(authId));
      found.set(hash, ref);
    };
    const walk = (value, path = '', authId = source.match(/approvals\/auth-(\d+)\.json$/)?.[1]) => {
      if (!value || typeof value !== 'object') return;
      authId = value.authId ?? authId;
      for (const [key, v] of Object.entries(value)) {
        const next = path ? `${path}.${key}` : key;
        if (TX_FIELD.test(key) && v !== null && v !== '') add(String(v), next, authId);
        else if (key === 'statuses' && v && typeof v === 'object') {
          for (const hash of Object.keys(v)) add(hash, `${next}.${hash}`, authId);
        } else walk(v, next, authId);
      }
    };
    if (typeof data === 'string') {
      for (const match of data.matchAll(/https:\/\/ccdexplorer\.io\/testnet\/transaction\/([0-9a-f]{64})(?![0-9a-f])/gi)) add(match[1], 'explorer link');
    } else walk(data);
  }
  return [...found.values()].sort((a, b) => a.hash.localeCompare(b.hash));
}

const address = (v) => String(v?.address ?? v);
const atomic = (v) => {
  if (v === undefined || v === null) throw new Error('missing measured cost or energy');
  const n = BigInt(v.microCcdAmount ?? v.value ?? v);
  if (n < 0n) throw new Error('negative measured cost or energy');
  return n;
};
// SDK traces finish nested calls before the outer call's Updated event. The last
// Updated is the transaction's own receive, not a registry call it made internally.
const receiveName = (summary) => String(summary.rejectReason?.receiveName?.value ?? summary.rejectReason?.receiveName
  ?? summary.events?.findLast((e) => e.tag === 'Updated')?.receiveName ?? '');

/** Contract entrypoints and RegisterData CBOR type tags come from the finalized summary. */
export function classifyTransaction(summary, { wallet, settlementHashes = [] } = {}) {
  const type = summary.transactionType === 'failed' ? summary.failedTransactionType : summary.transactionType;
  const name = receiveName(summary);
  const entry = name.split('.').at(-1);
  if (name.startsWith('agent_spend_guard.') && [...FLOW_KINDS, 'approve', 'anchorAudit', 'cancel', 'registerAgent'].includes(entry)) return entry;
  if (type === 'deployModule') return 'deploy';
  if (type === 'initContract') return 'init';
  if (type === 'registerData') {
    const data = summary.dataRegistered?.data;
    const hex = typeof data === 'string' ? data : Buffer.from(data instanceof Uint8Array ? data : data?.buffer ?? data ?? []).toString('hex');
    // CBOR text pair "type": "CCDVRA" / "CCDVAA", used by Verify-and-Access V1.
    if (hex.includes(Buffer.from('dtypefCCDVRA').toString('hex'))) return REQUEST_ANCHOR;
    if (hex.includes(Buffer.from('dtypefCCDVAA').toString('hex'))) return APPROVAL_ANCHOR;
    return 'RegisterData (other)';
  }
  const hash = String(summary.hash);
  if (type === 'transfer' && summary.sponsor?.sponsor && (settlementHashes.includes(hash) || (wallet && address(summary.sender) === wallet))) return 'x402 settlement';
  if (type === 'update' && name) return 'admin';
  return 'other';
}

/** Public state supplies role labels; a deploy summary additionally identifies the deployer. */
export function payerLabels(state, run, transactions = []) {
  const labels = {};
  const add = (addr, role) => { if (addr) labels[addr] = [...new Set([...(labels[addr] ?? []), role])]; };
  for (const [key, role] of Object.entries({ wallet: 'agent wallet', agent: 'agent control', owner: 'owner', cosigner: 'co-signer', deployer: 'deployer', facilitator: 'facilitator (sponsor)' })) add(state.guard?.[key], role);
  add(state.badges?.seller?.holder, 'seller');
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    for (const [key, value] of Object.entries(v)) {
      if (key === 'feePayer' && typeof value === 'string') add(value, 'facilitator (sponsor)');
      else walk(value);
    }
  };
  walk(run);
  for (const tx of transactions) if (tx.kind === 'deploy') add(tx.sender, 'deployer');
  return labels;
}

export function measuredTransaction(ref, status, context = {}) {
  if (status?.status !== 'finalized' || !status.outcome?.summary) throw new Error('transaction is not finalized / not found');
  const s = status.outcome.summary;
  const sender = address(s.sender);
  const charges = [{ payer: sender, microCcd: atomic(s.cost) }];
  if (s.sponsor) charges.push({ payer: address(s.sponsor.sponsor), microCcd: atomic(s.sponsor.cost) });
  return { ...ref, kind: classifyTransaction(s, context), entrypoint: receiveName(s), transactionType: s.transactionType,
    outcome: s.transactionType === 'failed' ? `rejected (${s.rejectReason?.tag ?? 'unknown reason'})` : 'success',
    sender, charges, energy: atomic(s.energyCost), microCcd: charges.reduce((n, c) => n + c.microCcd, 0n) };
}

export function ratio(numerator, denominator = 1n) {
  if (denominator <= 0n) throw new Error('ratio denominator must be positive');
  let a = numerator < 0n ? -numerator : numerator; let b = denominator;
  while (b) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}
const plus = (a, b) => ratio(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
const times = (a, b) => ratio(a.numerator * b.numerator, a.denominator * b.denominator);
export const fractionText = (r) => r.denominator === 1n ? String(r.numerator) : `${r.numerator}/${r.denominator}`;

/** Exact median: even samples retain half a microCCD (or half an energy unit). */
export function median(values) {
  if (!values.length) return null;
  const sorted = values.map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? ratio(sorted[i]) : ratio(sorted[i - 1] + sorted[i], 2n);
}

export function aggregateTransactions(transactions) {
  const byKind = new Map(); const byPayer = new Map();
  let energy = 0n; let microCcd = 0n;
  for (const tx of transactions) {
    const kind = byKind.get(tx.kind) ?? { kind: tx.kind, count: 0, energy: 0n, microCcd: 0n };
    kind.count++; kind.energy += tx.energy; kind.microCcd += tx.microCcd;
    byKind.set(tx.kind, kind); energy += tx.energy; microCcd += tx.microCcd;
    for (const charge of tx.charges) {
      const payer = byPayer.get(charge.payer) ?? { payer: charge.payer, count: 0, microCcd: 0n };
      payer.count++; payer.microCcd += charge.microCcd;
      byPayer.set(charge.payer, payer);
    }
  }
  return { count: transactions.length, energy, microCcd, byKind: [...byKind.values()], byPayer: [...byPayer.values()] };
}

/** Fee medians use successful purchases only; setup and refusal fees remain in historical totals. */
export function deriveFlows(transactions, run, entries, rates) {
  const purchases = [...new Map((run.steps ?? []).filter((s) => s.status === 'paid').map((s) => [s.txHash, s])).values()];
  const paidIds = purchases.map((p) => String(p.authId));
  const anchor = (run.steps ?? []).filter((s) => s.step === 'anchor').at(-1);
  const coveredIds = new Set(entries.slice(0, anchor?.count ?? 0).filter((e) => ['paid', 'settled'].includes(e.event)).map((e) => String(e.data.authId)));
  const batchSize = paidIds.filter((id) => coveredIds.has(id)).length;
  const components = [...FLOW_KINDS, REQUEST_ANCHOR, APPROVAL_ANCHOR, 'approve', 'anchorAudit'].map((kind) => {
    const samples = transactions.filter((tx) => tx.kind === kind && tx.outcome === 'success'
      && (kind === 'anchorAudit' || tx.authIds.some((id) => paidIds.includes(id))));
    return { kind, count: samples.length, hashes: samples.map((tx) => tx.hash), energy: median(samples.map((tx) => tx.energy)), microCcd: median(samples.map((tx) => tx.microCcd)) };
  });
  const calculate = (kinds) => {
    const required = [...kinds, 'anchorAudit'].map((k) => components.find((c) => c.kind === k));
    const missing = required.filter((c) => !c.count).map((c) => c.kind);
    if (!batchSize) missing.push('audit batch size');
    if (missing.length) return { missing };
    const sum = (field) => required.reduce((n, c) => plus(n, c.kind === 'anchorAudit' ? times(c[field], ratio(1n, BigInt(batchSize))) : c[field]), ratio(0n));
    const energy = sum('energy'); const microCcd = sum('microCcd');
    return { energy, microCcd, ...(rates ? { eur: times(energy, rates.euroPerEnergy), currentMicroCcd: times(times(energy, rates.euroPerEnergy), rates.microCcdPerEuro) } : {}) };
  };
  return { purchases: purchases.map(({ authId, step, txHash }) => ({ authId, step, txHash })), batchSize, anchor,
    components, small: calculate(FLOW_KINDS), large: calculate([...FLOW_KINDS, REQUEST_ANCHOR, APPROVAL_ANCHOR, 'approve']) };
}

// Decimal displays are truncated only when a rational repeats; the exact microCCD fraction is kept.
export function decimal(r, places = 6) {
  if (typeof r !== 'object') r = ratio(BigInt(r));
  const scale = 10n ** BigInt(places);
  const scaled = r.numerator * scale / r.denominator;
  return `${r.numerator * scale % r.denominator ? '≈' : ''}${scaled / scale}.${String(scaled % scale).padStart(places, '0')}`;
}
export const ccdCost = (micro) => decimal(times(typeof micro === 'object' ? micro : ratio(BigInt(micro)), ratio(1n, 1_000_000n)), 9);
const cell = (s) => String(s).replace(/[\\`|<>\[\]]/g, (c) => `\\${c}`).replace(/[\r\n]/g, ' ');
const txLink = (hash) => `[${hash.slice(0, 10)}…](https://ccdexplorer.io/testnet/transaction/${hash})`;

export function renderCostReport(report) {
  const { transactions, totals, flows, labels, rates, errors = [] } = report;
  const who = (addr) => `${(labels[addr] ?? ['unlabelled account']).join(' / ')}: \`${addr}\``;
  const out = ['# TrustRail testnet transaction costs', '',
    `Generated by \`(cd live && npm run costs -- --write)\` at ${report.generatedAt}; network=testnet. This covers recorded public evidence and finalized summaries, not every transaction ever sent by these accounts. Costs are fees, excluding purchase principal. The command needs no secrets and sends no transactions; \`--write\` writes local Markdown only.`, '',
    '## Per purchase', '',
    `| Flow | Median-derived energy | Test CCD (historical fee medians) | Exact microCCD |${rates ? ' Test CCD at current testnet parameters | EUR estimate from testnet parameters |' : ''}`,
    `| --- | ---: | ---: | ---: |${rates ? ' ---: | ---: |' : ''}`];
  for (const [name, flow] of [['C_small', flows.small], ['C_large', flows.large]]) {
    out.push(flow.missing
      ? `| ${name} | unavailable: ${flow.missing.map(cell).join(', ')} | — | — |${rates ? ' — | — |' : ''}`
      : `| ${name} | ${fractionText(flow.energy)} | ${ccdCost(flow.microCcd)} | ${fractionText(flow.microCcd)} |${rates ? ` ${ccdCost(flow.currentMicroCcd)} | ${decimal(flow.eur, 8)} |` : ''}`);
  }
  out.push('', `> ${COST_NOTE}`, '',
    `Historical test CCD uses measured fee medians.${rates ? ' Current-parameter test CCD and EUR estimates apply the chain parameters read during this run to the measured median energy; they are not market prices or historical charged fees.' : ''}`, '',
    '## Formulas and who pays', '',
    '`C_small = authorize + commitPayment + x402 settlement + recordSettlement + anchorAudit / batch_size`', '',
    '`C_large = C_small + verification request anchor + approval record anchor + approve`', '',
    '| Component | Fee payer |', '| --- | --- |',
    '| x402 settlement | facilitator (sponsor) |',
    '| authorize, recordSettlement, anchorAudit | agent control |',
    '| commitPayment, verification request anchor, audit record anchor, cancel | co-signer |',
    '| approve | owner |', '',
    'The 2-of-2 agent wallet pays 0 in settlement fees because the facilitator sponsors the settlements. Cancel fees are historical refusal costs and are excluded from the successful purchase formulas.', '',
    `Audit amortisation: batch_size = ${flows.batchSize} successful purchases within the latest recorded anchor's ${flows.anchor?.count ?? 0} log entries${flows.anchor ? ` (${txLink(flows.anchor.txHash)})` : ''}. Use the median anchorAudit fee divided by that batch size. Earlier overlapping anchors are included in historical totals; this formula budgets one anchor per batch, not all historical re-anchoring.`, '',
    `Measured purchases: ${flows.purchases.map((p) => `${cell(p.step)} authorisation #${cell(p.authId)} (${txLink(p.txHash)})`).join('; ') || 'none'}.`, '',
    'Only successful transactions associated with these paid purchases enter the flow medians. Contract rejections, forged/replayed approvals and setup fees are excluded from flow medians, and remain in the historical totals.', '',
    '| Component | Samples | Median energy | Median test CCD | Exact median microCCD | Sample transactions |', '| --- | ---: | ---: | ---: | ---: | --- |');
  for (const c of flows.components) out.push(`| ${cell(c.kind)} | ${c.count} | ${c.energy ? fractionText(c.energy) : 'unavailable'} | ${c.microCcd ? ccdCost(c.microCcd) : 'unavailable'} | ${c.microCcd ? fractionText(c.microCcd) : 'unavailable'} | ${c.hashes.map(txLink).join(', ')} |`);
  if (rates) {
    out.push('', '## Current testnet chain parameters', '',
      `Read at ${rates.readAt}, finalized block \`${rates.blockHash}\` (block time ${rates.blockTime}).`, '',
      `euro-per-energy = ${fractionText(rates.euroPerEnergy)}; microCCD-per-euro = ${fractionText(rates.microCcdPerEuro)}; microCCD-per-energy = ${fractionText(times(rates.euroPerEnergy, rates.microCcdPerEuro))}. These parameter values may differ from those at transaction time.`);
  }
  out.push('', `Sources: ${report.sources.map((s) => `\`${cell(s)}\``).join(', ')}. Transaction fields and explorer links are deduplicated; audit digests, module references and block hashes are excluded.`, '',
    '## Historical totals (including setup and refused transactions)', '',
    '| Kind | Transactions | Energy | Test CCD | Exact microCCD |', '| --- | ---: | ---: | ---: | ---: |');
  for (const k of totals.byKind) out.push(`| ${cell(k.kind)} | ${k.count} | ${k.energy} | ${ccdCost(k.microCcd)} | ${k.microCcd} |`);
  out.push(`| **Total** | **${totals.count}** | **${totals.energy}** | **${ccdCost(totals.microCcd)}** | **${totals.microCcd}** |`, '',
    'Payer transaction counts include the zero-fee sender of sponsored settlements; the 2-of-2 agent wallet pays 0 because settlements are sponsored.', '',
    '| Payer | Transactions | Test CCD | Exact microCCD |', '| --- | ---: | ---: | ---: |');
  for (const p of totals.byPayer) out.push(`| ${who(p.payer)} | ${p.count} | ${ccdCost(p.microCcd)} | ${p.microCcd} |`);
  if (errors.length) out.push('', '## Incomplete reads — no generated file written', '', ...errors.map((e) => `- ${cell(e.hash)}: ${cell(e.error)}`));
  out.push('', '## Per transaction', '',
    '| Transaction | Kind / entrypoint | Outcome | Energy used | Cost (test CCD) | Exact microCCD | Sender | Fee paid by |',
    '| --- | --- | --- | ---: | ---: | ---: | --- | --- |');
  for (const tx of transactions) out.push(`| ${txLink(tx.hash)} | ${cell(tx.kind)}${tx.entrypoint ? `<br>\`${cell(tx.entrypoint)}\`` : ''} | ${cell(tx.outcome)} | ${tx.energy} | ${ccdCost(tx.microCcd)} | ${tx.microCcd} | ${who(tx.sender)} | ${tx.charges.map((c) => `${who(c.payer)}: ${c.microCcd} microCCD`).join('<br>')} |`);
  return `${out.join('\n')}\n`;
}
