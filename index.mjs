#!/usr/bin/env node
// swarm-x402-mcp — MCP server for SWARM's paid services (https://swarm-agent.net).
// Tools are built at startup from the live shop (/offers + /openapi.json), so new
// services appear without updating this package. Each call is paid per use in USDC
// on Base via x402, from the wallet in SWARM_WALLET_KEY. Nothing is charged unless
// the service delivers (the shop settles only after the work succeeds).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const VERSION = "0.1.0";
const BASE = (process.env.SWARM_BASE_URL || "https://swarm-agent.net").replace(/\/$/, "");
const MAX_USD = Number(process.env.SWARM_MAX_USD || "1");
const NETWORK = "eip155:8453"; // Base mainnet
const UA = { "User-Agent": `swarm-x402-mcp/${VERSION}` };
const log = (...a) => console.error("[swarm-mcp]", ...a); // stdout is the MCP channel

async function getJson(path) {
  const r = await fetch(BASE + path, { headers: UA });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

// ── Tools from the live shop ─────────────────────────────────────────
const [offers, api] = await Promise.all([getJson("/offers"), getJson("/openapi.json")]);
const tools = {};
for (const o of offers.offers ?? []) {
  const route = `/services/${o.id}`;
  const op = api.paths?.[route]?.post;
  const body = op?.requestBody?.content?.["application/json"] ?? {};
  const name = String(o.id).replace(/[^a-zA-Z0-9_]/g, "_");
  const price = (o.priceUsdCents / 100).toFixed(2);
  tools[name] = {
    route,
    def: {
      name,
      description: `${o.description ?? op?.summary ?? o.id} Price: $${price} per call (USDC on Base, x402; charged only on success).`,
      inputSchema: body.schema?.type === "object" ? body.schema : { type: "object", properties: {} },
    },
  };
}
log(`${Object.keys(tools).length} tools from ${BASE}`);

// ── Payer (optional: without a key the tools explain how to pay) ─────
let pay = null;
if (process.env.SWARM_WALLET_KEY) {
  let k = process.env.SWARM_WALLET_KEY.trim();
  if (!k.startsWith("0x")) k = "0x" + k;
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(k)));
  pay = wrapFetchWithPayment(fetch, client);
}

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

async function call(name, args) {
  const t = tools[name];
  if (!t) return text(`Unknown tool: ${name}`, true);
  const init = { method: "POST", headers: { ...UA, "Content-Type": "application/json" }, body: JSON.stringify(args ?? {}) };

  // Read the quote first, without paying, and check it against the caller's limits.
  const q = await fetch(BASE + t.route, init);
  if (q.status !== 402) return text(`Expected a 402 quote, got HTTP ${q.status}: ${(await q.text()).slice(0, 500)}`, true);
  const accept = ((await q.json()).accepts ?? []).find((a) => a.network === NETWORK);
  if (!accept) return text("The shop offered no payment option on Base mainnet; not paying.", true);
  const usd = Number(accept.amount) / 1e6;
  if (!(usd <= MAX_USD)) return text(`Price $${usd.toFixed(2)} is above SWARM_MAX_USD ($${MAX_USD}); not paying.`, true);
  if (!pay) {
    return text(`This tool costs $${usd.toFixed(2)} per call, paid in USDC on Base via x402. ` +
      "Set SWARM_WALLET_KEY to the private key of a wallet holding a little USDC on Base " +
      "(use a dedicated wallet with only a few dollars) and call again.", true);
  }

  const r = await pay(BASE + t.route, init);
  const body = await r.text();
  if (!r.ok) return text(`HTTP ${r.status}: ${body.slice(0, 1000)}`, true);
  let out = body;
  try { const j = JSON.parse(body); out = typeof j.markdown === "string" ? j.markdown : JSON.stringify(j, null, 2); } catch {}
  return text(`${out}\n\n(paid $${usd.toFixed(2)} to SWARM via x402)`);
}

const server = new Server({ name: "swarm-x402", version: VERSION }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.values(tools).map((t) => t.def) }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try { return await call(req.params.name, req.params.arguments); }
  catch (e) { return text(`Error: ${e?.message || e}`, true); }
});
await server.connect(new StdioServerTransport());
