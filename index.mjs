#!/usr/bin/env node
// swarm-x402-mcp — MCP server for SWARM's paid services (https://swarm-agent.net).
// Four tools, declared below. Every tool calls SWARM's shop over the network and,
// when SWARM_WALLET_KEY is set, pays per call in USDC on Base via x402 — so none of
// them is read-only, and each says so in its MCP annotations. Before paying, a call
// reads the shop's 402 quote and refuses anything off Base mainnet or above
// SWARM_MAX_USD. Nothing is charged unless the service delivers (the shop settles
// only after the work succeeds).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const VERSION = "0.1.2";
const BASE = (process.env.SWARM_BASE_URL || "https://swarm-agent.net").replace(/\/$/, "");
const MAX_USD = Number(process.env.SWARM_MAX_USD || "1");
const NETWORK = "eip155:8453"; // Base mainnet
const UA = { "User-Agent": `swarm-x402-mcp/${VERSION}` };

// ── Payer (optional: without a key the tools only quote and explain the price) ──
let pay = null;
if (process.env.SWARM_WALLET_KEY) {
  let k = process.env.SWARM_WALLET_KEY.trim();
  if (!k.startsWith("0x")) k = "0x" + k;
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(k)));
  pay = wrapFetchWithPayment(fetch, client);
}

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

async function call(route, args) {
  const init = { method: "POST", headers: { ...UA, "Content-Type": "application/json" }, body: JSON.stringify(args ?? {}) };
  try {
    // Read the quote first, without paying, and check it against the caller's limits.
    const q = await fetch(BASE + route, init);
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
    const r = await pay(BASE + route, init);
    const body = await r.text();
    if (!r.ok) return text(`HTTP ${r.status}: ${body.slice(0, 1000)}`, true);
    let out = body;
    try { const j = JSON.parse(body); out = typeof j.markdown === "string" ? j.markdown : JSON.stringify(j, null, 2); } catch {}
    return text(`${out}\n\n(paid $${usd.toFixed(2)} to SWARM via x402)`);
  } catch (e) {
    return text(`Error: ${e?.message || e}`, true);
  }
}

// Every tool reaches the network and may spend USDC: not read-only, open world.
const REACH = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const PAID = "Calls SWARM's shop over the network and, with SWARM_WALLET_KEY set, pays in USDC on Base via x402 " +
  "(the live quote is checked against SWARM_MAX_USD before paying; charged only on success).";

const server = new McpServer({ name: "swarm-x402", version: VERSION });

server.registerTool("utilities", {
  title: "SWARM utilities",
  description: `UUIDs, hashes, base64, URL encoding, secure passwords and timestamp conversion. Price: $0.02 per call. ${PAID}`,
  inputSchema: {
    op: z.string().describe("Operation, e.g. uuid, hash, base64, password, timestamp (see https://swarm-agent.net/openapi.json)"),
    text: z.string().optional().describe("Input text, for operations that take one"),
    n: z.number().int().optional().describe("How many to generate"),
    algo: z.string().optional().describe("Hash algorithm"),
    length: z.number().int().optional().describe("Password length"),
    t: z.union([z.string(), z.number()]).optional().describe("Timestamp to convert"),
  },
  annotations: { title: "SWARM utilities", ...REACH },
}, (args) => call("/services/utilities", args));

server.registerTool("code_health", {
  title: "GitHub repo health scan",
  description: `Static scan of a public GitHub repo: TODO/FIXME debt, oversized files, secret heuristics, hygiene. Price: $0.05 per call. ${PAID}`,
  inputSchema: { repo: z.string().describe("Public GitHub repo URL, e.g. https://github.com/owner/repo") },
  annotations: { title: "GitHub repo health scan", ...REACH },
}, (args) => call("/services/code-health", args));

const topic = {
  topic: z.string().describe("What to research"),
  context: z.string().optional().describe("Why you need it, or what you already know"),
  requirements: z.string().optional().describe("Anything the result must cover"),
};

server.registerTool("summary", {
  title: "One-page web research brief",
  description: `A one-page brief on a topic, researched on the live web at request time, sources linked. Price: $0.75 per call. ${PAID}`,
  inputSchema: topic,
  annotations: { title: "One-page web research brief", ...REACH },
}, (args) => call("/services/summary", args));

server.registerTool("report", {
  title: "Full web research report",
  description: `A full Markdown report on a topic, researched on the live web at request time, sources linked. Price: $0.99 per call. ${PAID}`,
  inputSchema: topic,
  annotations: { title: "Full web research report", ...REACH },
}, (args) => call("/services/report", args));

await server.connect(new StdioServerTransport());
