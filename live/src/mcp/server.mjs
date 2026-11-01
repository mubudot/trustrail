// MCP owns JSON-RPC initialization, schema validation, errors and newline-delimited stdio.
// Stdout is reserved for protocol messages; operational diagnostics go to stderr.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PURCHASE_TOOLS } from './purchase-tools.mjs';
import { purchaseWorld } from './world.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--world' || !['reference', 'testnet'].includes(args[1]))) {
  console.error('Usage: node src/mcp/server.mjs [--world reference|testnet]');
  process.exitCode = 1;
} else {
  const world = await purchaseWorld(args[1] ?? 'reference');
  const server = new Server({ name: 'trustrail', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: PURCHASE_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const result = await world.tools.call(params.name, params.arguments);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
      ...(result.status === 'refused' ? { isError: true } : {}) };
  });
  let closed = false;
  const close = () => { if (!closed) { closed = true; world.close(); } };
  server.onclose = close;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { close(); await server.close(); });
  await server.connect(new StdioServerTransport());
}
