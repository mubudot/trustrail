// Minimal JSON-RPC client for Concordium's hosted Agent Registry MCP server (holds no keys;
// "build_*" tools return sign-ready payloads that we sign and submit ourselves).
export const REGISTRY_MCP_URL = 'https://agent-registry-mcp.concordium.com/mcp';

let nextId = 1;
export async function callTool(name, args, { url = REGISTRY_MCP_URL, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`registry MCP HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`registry MCP error: ${body.error.message}`);
  const r = body.result;
  if (r?.isError) throw new Error(`registry MCP tool error: ${r.content?.map((c) => c.text).join(' ')}`);
  if (r?.structuredContent) return r.structuredContent;
  const text = r?.content?.find((c) => c.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return text; }
}
