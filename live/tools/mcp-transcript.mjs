// Actual MCP client over a child process' stdio. No model, network, credentials or owner approval.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const client = new Client({ name: 'trustrail-scripted-client', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('../src/mcp/server.mjs', import.meta.url)), '--world', 'reference'] });
try {
  await client.connect(transport);
  console.log('tools/list ->', JSON.stringify((await client.listTools()).tools.map(t => t.name)));
  const call = async (name, args) => {
    const result = (await client.callTool({ name, arguments: args })).structuredContent;
    console.log(`${name}(${JSON.stringify(args)}) -> ${JSON.stringify(result)}`);
    return result;
  };
  const weather = await call('buy_resource', { url: 'https://data.example/weather', intent: 'Find the warmest forecast hour' });
  const big = await call('buy_resource', { url: 'https://data.example/dataset', intent: 'Get demand training examples' });
  await call('purchase_status', { authId: big.authId });
  await call('resume_purchase', { authId: big.authId });
  const warmest = weather.data.hourly.reduce((a, b) => a.temperature > b.temperature ? a : b);
  console.log(`client result -> Demo forecast: warmest hour ${warmest.time}, ${warmest.temperature} C. Dataset awaits owner approval.`);
} finally {
  await client.close();
}
