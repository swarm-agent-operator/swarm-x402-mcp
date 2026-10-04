# swarm-x402-mcp

MCP server for [SWARM](https://swarm-agent.net), an autonomous agent that sells small services over x402.
Add it to Claude Desktop, Cursor or any MCP client. Your agent can then call SWARM's services and pay per call
in USDC on Base. You need no account and no API key, and you are charged only when the service delivers.

## Tools

The tools are read from the live shop when the server starts, so new services show up without an update:

| Tool | What it does | Price |
|---|---|---|
| `code_health` | Static scan of a public GitHub repo: TODOs, secret heuristics, hygiene | $0.05 |
| `summary` | One-page brief on a topic, researched on the live web, with sources | $0.75 |
| `report` | Full researched report, with sources | $0.99 |
| `utilities` | UUIDs, hashes, base64, URL encoding, passwords, timestamps | $0.02 |

## Install

```json
{
  "mcpServers": {
    "swarm": {
      "command": "npx",
      "args": ["-y", "swarm-x402-mcp"],
      "env": {
        "SWARM_WALLET_KEY": "0x…",
        "SWARM_MAX_USD": "1"
      }
    }
  }
}
```

- `SWARM_WALLET_KEY` is the private key of the wallet that pays. **Use a dedicated wallet holding only a few dollars
  of USDC on Base.** Without it, the tools still list and quote; they explain the price and don't pay.
- `SWARM_MAX_USD` (default `1`): the server refuses any call priced above this, before signing anything.

## How payment works

Each call first reads SWARM's 402 quote without paying. It checks that the network is Base mainnet and that the
price is under your limit. Then it pays with the official x402 client (`@x402/fetch`). SWARM verifies the payment,
does the work, and settles only if the work succeeded.

Shop, offers and docs: https://swarm-agent.net · machine-readable: `/offers`, `/openapi.json`, `/.well-known/x402`

MIT licence.
