// A paid API ("seller agent") speaking x402 v2 over a fetch-like interface:
//   GET without payment  -> 402 + PAYMENT-REQUIRED header (base64 JSON PaymentRequirements)
//   GET + PAYMENT-SIGNATURE -> facilitator verify + settle -> 200 + PAYMENT-RESPONSE header
import { b64, unb64 } from '../util/b64json.mjs';

export class MockSeller {
  /** routes: { [path]: { amount: bigint, asset: string, body: any, description: string } } */
  constructor({ payTo, facilitator, routes, badge = null, network = 'ccd:4221332d34e1694168c2a0c0b3fd0f27' }) {
    Object.assign(this, { payTo, facilitator, routes, badge, network });
  }

  requirementsFor(route) {
    return {
      scheme: 'exact', network: this.network, amount: route.amount.toString(), asset: route.asset,
      payTo: this.payTo, maxTimeoutSeconds: 300, description: route.description,
      extra: { feePayer: this.facilitator.address, ...(this.badge ? { payeeBadge: this.badge } : {}) },
    };
  }

  /** fetch-like: (url, {headers}) -> {status, headers, json} */
  async fetch(url, { headers = {} } = {}) {
    const path = new URL(url).pathname;
    const route = this.routes[path];
    if (!route) return { status: 404, headers: {}, json: { error: 'not_found' } };
    const requirements = this.requirementsFor(route);
    const sig = headers['PAYMENT-SIGNATURE'];
    if (!sig) {
      return { status: 402, headers: { 'PAYMENT-REQUIRED': b64({ x402Version: 2, resource: { url }, accepts: [requirements] }) }, json: { error: 'payment_required' } };
    }
    const payment = unb64(sig);
    const settled = this.facilitator.settle(payment.payload, requirements);
    if (!settled.success) return { status: 402, headers: {}, json: { error: settled.errorReason } };
    return { status: 200, headers: { 'PAYMENT-RESPONSE': b64(settled) }, json: route.body };
  }
}

