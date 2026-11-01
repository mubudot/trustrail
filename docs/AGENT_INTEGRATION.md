# TrustRail purchasing over MCP

TrustRail is exposed as a purchasing tool to an existing MCP-capable agent. The agent receives
data and a receipt for an authorized purchase, or a pending/refused result it cannot override.
The stdio server uses `@modelcontextprotocol/sdk` (pinned in `live/package.json`).

Install with `(cd live && npm ci)`. A generic MCP client configuration is:

```json
{
  "mcpServers": {
    "trustrail": {
      "command": "node",
      "args": ["/path/to/trustrail/live/src/mcp/server.mjs", "--world", "reference"]
    }
  }
}
```

Replace the path with your checkout. `cd live && npm run mcp` also starts the server; stdout is
reserved for MCP messages, so clients should launch `node` directly (or use `npm run --silent mcp`).
An agent can ask for the warmest forecast hour using `https://data.example/weather`, or request
sample demand data at `https://data.example/dataset` to reach the owner-approval boundary.

## Tool contract

| Tool | Input | Result |
| --- | --- | --- |
| `buy_resource` | `{url, intent}`; HTTP(S) URL and intent strings | `{status, reason, authId?, receipt?, data?}` |
| `purchase_status` | `{authId}`; decimal string | Saved result or current pending/refused status; never signs |
| `resume_purchase` | `{authId}` | Uses the saved quote after approval; re-checks quote binding and runs the buyer/co-signer checks |

`status` is `paid`, `pending` or `refused`. Paid results include the content in `data` and a
`receipt` with `transactionHash`, the committed `digest`, `fixture`, and live commit/record
transaction hashes when available. All amounts and identifiers crossing JSON are strings.
Refusals have stable reasons such as `NotAllowlisted`, `payee_not_bound_to_badge`,
`human_approval_invalid`, or `quote_binding_changed`; the MCP result also sets `isError: true`.

There is no approve, policy or admin tool. Extra input fields (including approval records, amounts,
payees and replacement URLs on resume) are rejected. Resuming before approval returns pending
without consuming the pending purchase. After approval, the original URL and requirements must
still match the guard authorization; the co-signer independently verifies the approval. A forged
owner-key approval still fails. Repeated successful resumes return the saved receipt, without
another payment. Purchases and quotes are kept in memory for this server session; restarting the
server does not recover its queue.

Paid receipts use the committed digest returned by the buyer, without another chain read. A
failed receipt lookup therefore cannot discard a confirmed payment. An identical `buy_resource`
call (same URL and intent) returns its saved paid or uncertain result within the session, including
after resume; use a distinct intent for an intentional repeat purchase. Across server restarts or
separate sessions there is no durable request identity or purchase cache, so duplicate purchases
cannot be prevented: retain receipts and reconcile uncertain outcomes before starting a new one.

If settlement is uncertain, the result stays `pending` with
`settlement_unknown_do_not_retry`; an operator must reconcile it with the chain. A confirmed
payment whose guard record failed returns `paid` with `settlement_record_pending`, its receipt
and content. Neither result is automatically retried. A free endpoint is refused with
`resource_does_not_require_payment` because it has no payment receipt.

## Actual scripted MCP run

Run `(cd live && npm run mcp:transcript)`. The SDK client starts the reference server as a child
process, initializes MCP, lists the tools and calls them over stdio. This is a scripted MCP client,
not a recording of an LLM deciding to purchase. Its final line computes a result from the
purchased forecast. The following is actual output; fixture transaction hashes vary per run
because signing keys are generated in memory.

```text
tools/list -> ["buy_resource","purchase_status","resume_purchase"]
buy_resource({"url":"https://data.example/weather","intent":"Find the warmest forecast hour"}) -> {"status":"paid","reason":"payment_settled","authId":"0","receipt":{"transactionHash":"a4c197e642e7388afa1a573dc2d8f9d5fcf76d948355bb3795bbd3cde80c05e7","digest":"0414ee86f87764710a03e1b7feb6a3c41a92e8f161f5b37156399c211d333f47","fixture":true},"data":{"demo":true,"source":"TrustRail synthetic hourly forecast","location":"Tokyo","units":{"temperature":"C","precipitationProbability":"%"},"hourly":[{"time":"2026-12-01T09:00:00Z","temperature":18,"condition":"clear","precipitationProbability":5},{"time":"2026-12-01T10:00:00Z","temperature":19,"condition":"partly cloudy","precipitationProbability":10},{"time":"2026-12-01T11:00:00Z","temperature":20,"condition":"cloudy","precipitationProbability":20}]}}
buy_resource({"url":"https://data.example/dataset","intent":"Get demand training examples"}) -> {"status":"pending","reason":"owner_approval_required","authId":"1"}
purchase_status({"authId":"1"}) -> {"status":"pending","reason":"owner_approval_required","authId":"1"}
resume_purchase({"authId":"1"}) -> {"status":"pending","reason":"owner_approval_required","authId":"1"}
client result -> Demo forecast: warmest hour 2026-12-01T11:00:00Z, 20 C. Dataset awaits owner approval.
```

## Fixture and testnet scope

The default `--world reference` uses `agent/`'s in-memory guard, ledger, seller, badge resolver
and approval verifier. It needs no keys or network. Forecasts and dataset rows are synthetic
demo content; receipts are fixture hashes, not chain transactions. The fixture owner helper is
available only to direct tests, never over MCP. Tests demonstrate a valid fixture owner approval
and reject forged proofs and changes to amount, payee or URL.

`--world testnet` wraps `createLiveWorld()` and `LiveAgent` with the same tool contract. It uses
existing runtime credentials, real testnet guard/badge/x402 adapters and the live audit log.
An operator must supply a real seller URL (the default local seller uses port 4402), and create
valid owner approval outside MCP. With the [remote co-signer configuration](PRODUCTION.md#separate-co-signer-service-offline-tested),
the buyer loads wallet key 0 only and expects an external seller. This mode sends transactions and writes the live log when used;
it was **not exercised for this integration**. The recorded testnet runs predate MCP. The local
testnet seller now serves the same labelled synthetic content, but the recorded response bodies
remain historical evidence. No external agent pilot or independently operated seller is claimed.
