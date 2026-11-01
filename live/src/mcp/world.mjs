import { createWorld } from '../../../agent/src/mock/world.mjs';
import { PurchaseTools } from './purchase-tools.mjs';

export async function purchaseWorld(world = 'reference') {
  if (world === 'reference') {
    const w = createWorld();
    return { tools: new PurchaseTools({ ...w, fixture: true }), close: () => {} };
  }
  if (world !== 'testnet') throw new Error('world must be reference or testnet');
  // Explicit opt-in only: this path loads existing runtime secrets and may send real testnet
  // transactions/write the live audit log. Never used by the offline tests or transcript.
  const { createLiveWorld } = await import('../world.mjs');
  const w = await createLiveWorld();
  return { tools: new PurchaseTools(w), close: w.close };
}
