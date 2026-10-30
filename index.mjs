#!/usr/bin/env node
// swarm-x402-mcp — MCP server for SWARM's paid services (https://swarm-agent.net).
// Six tools, declared below. Every tool calls SWARM's shop over the network and,
// when SWARM_WALLET_KEY is set, pays per call in USDC on Base via x402 — so none of
// them is read-only, and each says so in its MCP annotations. Before paying, a call
// reads the shop's 402 quote and refuses anything off Base mainnet or above
// SWARM_MAX_USD. Nothing is charged unless the service delivers (the shop settles
// only after the work succeeds).
// 0.1.4: a failed call always says whether you were charged and whether a retry is safe,
// as a normal tool result with isError (issue #1). It never retries on its own.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const VERSION = "0.1.4";
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
  // 0.1.3: newer @x402/core adds its own per-payment cap, which rejected $0.002 calls. The quote is
  // already checked against SWARM_MAX_USD below before anything is signed, so that cap is turned off.
  client.setSpendControls?.(false);
  pay = wrapFetchWithPayment(fetch, client);
}

const usdText = (u) => "$" + (u < 0.01 ? u.toFixed(3) : u.toFixed(2));
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
// Every failure starts with one line an agent can act on: charged? retry?
const fail = (charged, retry, why) => text(`charged: ${charged}; retry: ${retry}. ${why}`, true);

// The settlement receipt the shop sends back (x402 v2 PAYMENT-RESPONSE, v1 X-PAYMENT-RESPONSE).
function receipt(r) {
  const h = r.headers.get("payment-response") || r.headers.get("x-payment-response");
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return { unreadable: true }; }
}
const reason = (body) => { try { return JSON.parse(body).error || body; } catch { return body; } };

async function call(route, args) {
  const init = { method: "POST", headers: { ...UA, "Content-Type": "application/json" }, body: JSON.stringify(args ?? {}) };
  let q;
  try {
    // Read the quote first, without paying, and check it against the caller's limits.
    q = await fetch(BASE + route, init);
  } catch (e) {
    return fail("no", "safe", `Could not reach the shop (${e?.message || e}); nothing was signed.`);
  }
  if (q.status !== 402) return fail("no", q.status >= 500 ? "safe" : "fix the input first", `Expected a 402 quote, got HTTP ${q.status}: ${reason(await q.text()).toString().slice(0, 500)}`);
  const accept = ((await q.json().catch(() => ({}))).accepts ?? []).find((a) => a.network === NETWORK);
  if (!accept) return fail("no", "no", "The shop offered no payment option on Base mainnet; not paying.");
  const usd = Number(accept.amount) / 1e6;
  if (!(usd <= MAX_USD)) return fail("no", "no", `Price ${usdText(usd)} is above SWARM_MAX_USD ($${MAX_USD}); not paying.`);
  if (!pay) {
    return text(`This tool costs ${usdText(usd)} per call, paid in USDC on Base via x402. ` +
      "Set SWARM_WALLET_KEY to the private key of a wallet holding a little USDC on Base " +
      "(use a dedicated wallet with only a few dollars) and call again.", true);
  }
  let r, body;
  try {
    r = await pay(BASE + route, init);
    body = await r.text();
  } catch (e) {
    // The connection broke after a payment may have been signed: say so, never guess.
    return fail("unknown", "check your wallet first",
      `The call failed after payment was attempted (${e?.message || e}). Look for a USDC transfer to SWARM on Base ` +
      "in the last minutes before calling again. A signed payment can be settled only once, so this one cannot be charged twice.");
  }
  const rc = receipt(r);
  if (!r.ok) {
    if (rc?.success && rc.transaction) {
      return fail("yes", "no", `Paid (tx ${rc.transaction}) but the service returned HTTP ${r.status}: ${reason(body).toString().slice(0, 500)}. ` +
        "Do not pay again; write to contact@swarm-agent.net with the tx hash.");
    }
    if (rc) return fail("unknown", "check your wallet first", `HTTP ${r.status} with an unreadable payment receipt: ${body.slice(0, 500)}`);
    if (r.status === 402) return fail("no", "safe", `The payment was rejected: ${reason(body).toString().slice(0, 500)}`);
    return fail("no", r.status >= 500 ? "safe" : "fix the input first",
      `HTTP ${r.status}, and the shop settled nothing (it settles only after the work succeeds): ${reason(body).toString().slice(0, 500)}`);
  }
  let out = body;
  try { const j = JSON.parse(body); out = typeof j.markdown === "string" ? j.markdown : JSON.stringify(j, null, 2); } catch {}
  return text(`${out}\n\n(paid ${usdText(usd)} to SWARM via x402${rc?.transaction ? `, tx ${rc.transaction}` : ""})`);
}

// Every tool reaches the network and may spend USDC: not read-only, open world.
const REACH = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const PAID = "Pays in USDC on Base via x402 when SWARM_WALLET_KEY is set (quote checked against SWARM_MAX_USD first; " +
  "charged only on success). On failure it says whether you were charged and if a retry is safe; it never retries on its own.";

const server = new McpServer({ name: "swarm-x402", version: VERSION });

server.registerTool("utilities", {
  title: "SWARM utilities",
  description: `SWARM Utilities - UUIDs, hashes, base64 and URL encoding, passwords, timestamp conversion. Pick one with \`op\`. Instant, no AI. Returns JSON (uuids, hash, encoded/decoded or password). $0.02. ${PAID}`,
  inputSchema: {
    op: z.enum(["uuid", "hash", "base64-encode", "base64-decode", "url-encode", "url-decode", "password", "timestamp"])
      .describe("Operation. Example: uuid"),
    text: z.string().optional().describe("Input for hash, base64-* and url-*. Example: hello world"),
    n: z.number().int().min(1).max(100).optional().describe("How many UUIDs (op=uuid), 1-100, default 1"),
    algo: z.string().optional().describe("Hash algorithm (op=hash), default sha256"),
    length: z.number().int().min(4).max(128).optional().describe("Password length (op=password), 4-128, default 16"),
    t: z.union([z.string(), z.number()]).optional().describe("Timestamp to convert (op=timestamp), ISO date or Unix seconds"),
  },
  annotations: { title: "SWARM utilities", ...REACH },
}, (args) => call("/services/utilities", args));

server.registerTool("code_health", {
  title: "GitHub repo health scan",
  description: `SWARM Code Health - Static health check of a public GitHub repo: TODO/FIXME debt, oversized files, possible committed secrets, README/.gitignore/LICENSE. Repos over 25 MB are refused before payment. Returns a Markdown report. $0.05. ${PAID}`,
  inputSchema: { repo: z.string().describe("Public GitHub repo URL, https://github.com/owner/name. Example: https://github.com/expressjs/express") },
  annotations: { title: "GitHub repo health scan", ...REACH },
}, (args) => call("/services/code-health", args));

const topic = {
  topic: z.string().min(1).describe("What to research. Example: Stablecoin payment volume on Base over the last 30 days"),
  context: z.string().optional().describe("Optional: why you need it, or what you already know"),
  requirements: z.string().optional().describe("Optional: anything the result must cover"),
};

server.registerTool("summary", {
  title: "One-page web research brief",
  description: `SWARM Research Brief - One-page brief on any topic, researched on the live web at request time, every source linked. 60-120 s (allow 180 s). Returns Markdown. $0.75. ${PAID}`,
  inputSchema: topic,
  annotations: { title: "One-page web research brief", ...REACH },
}, (args) => call("/services/summary", args));

server.registerTool("report", {
  title: "Full web research report",
  description: `SWARM Research Report - Full Markdown report on any topic, researched on the live web, every claim linked to its source. 2-4 min (allow 360 s). Returns Markdown. $0.99. ${PAID}`,
  inputSchema: topic,
  annotations: { title: "Full web research report", ...REACH },
}, (args) => call("/services/report", args));

const page = { url: z.string().describe("Public http(s) URL, ports 80/443 only. Example: https://example.com") };

server.registerTool("site_check", {
  title: "Website up check",
  description: `SWARM Site Check - Is a URL up? For agents that watch websites. Returns JSON: up, HTTP status, final URL after redirects, response time in ms, TLS errors. Instant, no AI. $0.002. ${PAID}`,
  inputSchema: page,
  annotations: { title: "Website up check", ...REACH },
}, (args) => call("/services/site-check", args));

server.registerTool("read_page", {
  title: "Read a web page",
  description: `SWARM Read Page - The readable text of a web page, menus, scripts and markup removed (median 97% fewer tokens than the raw HTML). HTML or text up to 3 MB. Returns JSON: title, text, word count. Not billed if the page cannot be read. $0.002. ${PAID}`,
  inputSchema: page,
  annotations: { title: "Read a web page", ...REACH },
}, (args) => call("/services/read-page", args));

await server.connect(new StdioServerTransport());
