import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('mcp_stdio_round_trip_lists_only_purchasing_tools_and_calls_reference_world_offline', { timeout: 20_000 }, async () => {
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    // Fail if even the spawned reference server tries any outbound I/O.
    args: ['--import', fileURLToPath(new URL('./offline-only.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/mcp/server.mjs', import.meta.url))], stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', b => { stderr += b; });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name), ['buy_resource', 'purchase_status', 'resume_purchase']);
    const call = async (name, args) => client.callTool({ name, arguments: args });
    const paid = await call('buy_resource', { url: 'https://data.example/weather', intent: 'forecast' });
    assert.equal(paid.structuredContent.status, 'paid');
    assert.equal(paid.structuredContent.data.hourly.length, 3);
    assert.deepEqual(JSON.parse(paid.content[0].text), paid.structuredContent);
    const pending = (await call('buy_resource', { url: 'https://data.example/dataset', intent: 'training' })).structuredContent;
    assert.equal(pending.status, 'pending');
    assert.deepEqual((await call('resume_purchase', { authId: pending.authId })).structuredContent, pending);
    const forged = await call('resume_purchase', { authId: pending.authId, approval: 'forged' });
    assert.equal(forged.isError, true);
    assert.equal(forged.structuredContent.reason, 'invalid_arguments');
    const unknown = await call('approve', { authId: pending.authId });
    assert.equal(unknown.structuredContent.reason, 'unknown_tool');
    assert.equal(stderr, '');
  } finally {
    await client.close();
  }
});
