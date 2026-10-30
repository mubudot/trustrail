// A real x402 seller on Concordium testnet: Express + @x402/express payment middleware, settled by
// an in-process facilitator built from @x402/concordium (verifies the 9 rules, adds the sponsor
// signature, submits, waits for finalization). The facilitator account pays the fees.
import express from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { x402Facilitator } from '@x402/core/facilitator';
import { ExactConcordiumScheme as FacilitatorScheme } from '@x402/concordium/exact/facilitator';
import { ExactConcordiumScheme as ServerScheme } from '@x402/concordium/exact/server';
import { toConcordiumFacilitatorSigner } from '@x402/concordium';
import { TESTNET } from './net.mjs';

export function createFacilitator({ address, privateKey }) {
  const signer = toConcordiumFacilitatorSigner(address, privateKey, { host: TESTNET.grpcHost, port: TESTNET.grpcPort, useTls: true });
  return new x402Facilitator().register(TESTNET.x402Network, new FacilitatorScheme({ signer, requireFinalization: true, finalizationTimeoutMs: 90_000 }));
}

/**
 * @param {{payTo: string, badge: string, facilitator: object,
 *          items: Record<string, {microCcd: bigint, description: string, body: object}>}} opts
 */
export function createSellerApp({ payTo, badge, facilitator, items }) {
  const server = new x402ResourceServer(facilitator).register(TESTNET.x402Network, new ServerScheme());
  const routes = {};
  for (const [path, it] of Object.entries(items)) {
    routes[`GET ${path}`] = {
      accepts: {
        scheme: 'exact', network: TESTNET.x402Network, payTo, maxTimeoutSeconds: 300,
        price: { amount: it.microCcd.toString(), asset: 'CCD', extra: { payeeBadge: badge } },
      },
      description: it.description, mimeType: 'application/json',
    };
  }
  const app = express();
  app.use(paymentMiddleware(routes, server));
  for (const [path, it] of Object.entries(items)) app.get(path, (_req, res) => res.json(it.body));
  return app;
}

export function listen(app, port = 0) {
  return new Promise((resolve) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}
