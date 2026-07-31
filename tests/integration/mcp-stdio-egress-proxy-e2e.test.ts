/**
 * MCP stdio child — EGRESS-PROXY reach e2e (H3). BRANCH (A): the MCP server
 * child MUST receive the loopback-proxy env when the operator turns the egress
 * proxy ON, exactly like bash/docker children do via `ToolContext.proxyEnv`.
 *
 * WHY this exists — the REAL BUG it seals:
 *   `StdioMcpTransport` stores `opts.proxyEnv` on `this.proxyEnv`, and its
 *   `buildEnv(configEnv, proxyEnv)` helper KNOWS how to inject the proxy keys.
 *   But `start()` called `buildEnv(this.config.env)` — dropping the second
 *   argument — so the stored proxy env was DEAD: an MCP server child opened its
 *   own sockets with NO `HTTP_PROXY`, bypassing the allowlist that bash/docker
 *   honor. `stdio.ts` already documents (lines 13-22) that the non-inheritance
 *   is a SECRET-leak defense, NOT an egress-gating decision, and that the proxy
 *   keys (which carry the proxy ADDRESS only, never a host secret) MUST reach
 *   the child. So the correct contract is (A): inject. The one-line fix wires
 *   `this.proxyEnv` into `buildEnv`; cut it and the ALLOW/DENY cases below flip
 *   to NOPROXY ⇒ RED.
 *
 * jun-10 LIVE SEAL (was a residual-risk regression guard): the live path is now
 * wired end to end. A SESSION-SCOPED proxy is opened ONCE at bootstrap
 * (`openSessionEgressProxy`) BEFORE the MCP fleet spawns, and its stable
 * `proxyEnv` threads bootstrap → `loadFeatures` → `loadMcpTools({ proxyEnv })` →
 * `loadSingle` → `new McpClient(cfg, { proxyEnv })` → `defaultTransportFor` →
 * `new StdioMcpTransport(cfg, { proxyEnv })`. The final `describe` below drives
 * that REAL composition (`openSessionEgressProxy` + `loadMcpTools`) — NOT the
 * transport in isolation — so a real MCP server child, handshaked by the real
 * `McpClient`, opens its OWN socket and is gated by the loopback allowlist. Cut
 * the `McpClient → defaultTransportFor(proxyEnv)` thread and that seal goes RED.
 *
 * Design judgement — (A) over (B): the source's own carve-out comment commits
 * to (A). (B) (regression-guard the bypass) would CODIFY an egress hole that
 * the surrounding system (bash/docker proxyEnv gating + a live
 * `QUANTA_NETWORK_PROXY`) plainly intends to close. We therefore SEAL injection
 * and prove the child socket is actually gated.
 *
 * Hermetic + offline + deterministic — pattern absorbed verbatim from the
 * sibling `network-proxy-subprocess-e2e.test.ts`:
 *   - A local Node http origin on an ephemeral port stands in for "the internet".
 *   - `withEgressProxy` binds a REAL loopback forward-proxy; the `DialTarget` DI
 *     maps routable NAMES to that loopback origin (no DNS / no real egress).
 *   - `resolvePeerHost` returns an RFC-5737 PUBLIC literal so the always-on peer
 *     SSRF re-check passes the hermetic loopback dial on the ALLOW path.
 *   - The MCP transport spawns a REAL child (`Bun.spawn`) via its `spawn` seam.
 *     The seam receives the env the transport BUILT — i.e. the exact bytes a
 *     production `Bun.spawn` would get — so what the child sees IS the transport
 *     contract, end to end. The child reads `HTTP_PROXY` from its OWN env, opens
 *     its OWN socket to the proxy, and issues an absolute-form forward-proxy GET.
 *   - Assertions: HTTP status (200 allow / 403 deny) + the proxy decision-log
 *     only. NO timing, NO thresholds, NO heuristics.
 *
 * default-OFF byte-identical: with the proxy OFF (`config` absent / disabled)
 * `withEgressProxy` hands `proxyEnv = {}`, `withProxyEnv` is a no-op, and the
 * child sees NONE of `PROXY_ENV_KEYS` ⇒ identical spawn env to the pre-H3 path.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { loadMcpTools } from "@/../src/agent"
import { type McpServerConfig, StdioMcpTransport } from "@/../src/mcp"
import {
  type DialTarget,
  type NetworkProxyConfig,
  openSessionEgressProxy,
  PROXY_ENV_KEYS,
  type ResolvePeerHost,
  withEgressProxy,
} from "@/../src/runtime/network-proxy"

// ── Hermetic upstream origin (the "real internet" for this test) ────────────
let origin: Server
let originPort: number

/** DI dial mapping ANY policy host to the hermetic loopback origin. */
const toOrigin = (): DialTarget => () => ({ host: "127.0.0.1", port: originPort })

/** ALLOW-path peer resolver — classify the hermetic peer as an RFC-5737 PUBLIC
 *  literal (TEST-NET-3 ⇒ classifyHost null) so the always-on peer re-check
 *  passes the hermetic loopback dial. */
const publicPeer: ResolvePeerHost = () => "203.0.113.10"

beforeAll(async () => {
  origin = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("ORIGIN-OK")
  })
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", () => resolve()))
  originPort = (origin.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => origin.close(() => resolve()))
})

/**
 * Inline child (Node stdlib, no deps) — stands in for an MCP server reaching the
 * network. Reads `HTTP_PROXY` from its OWN env, opens its OWN socket to it, and
 * issues an absolute-form forward-proxy GET for the target host. Writes ONE line
 * verdict to the OUT file (argv penult): `STATUS=<n>` (proxy response) /
 * `NOPROXY` (no proxy var injected) / `ERR=<m>`. This is the server's own socket
 * — the path the tool-arg guard never sees. The verdict goes to a FILE (not
 * stdout) so it never contends with the transport's own stdout JSON-RPC pump.
 */
const CHILD_SCRIPT = `
const net = require("node:net");
const fs = require("node:fs");
const out = process.argv[process.argv.length - 2];
const target = process.argv[process.argv.length - 1];
const write = (s) => { try { fs.writeFileSync(out, s); } catch (_) {} };
const proxy = process.env.HTTP_PROXY || process.env.http_proxy;
if (!proxy) { write("NOPROXY"); process.exit(0); }
const u = new URL(proxy);
const sock = net.connect(Number(u.port), u.hostname, () => {
  const abs = "http://" + target + "/exfil";
  sock.write("GET " + abs + " HTTP/1.1\\r\\nHost: " + target + "\\r\\nConnection: close\\r\\n\\r\\n");
});
let buf = "";
sock.setEncoding("utf8");
sock.on("data", (c) => { buf += c; });
sock.on("end", () => {
  const m = buf.match(/^HTTP\\/1\\.1 (\\d{3})/);
  write("STATUS=" + (m ? m[1] : "0"));
});
sock.on("error", (e) => { write("ERR=" + e.message); });
`

/**
 * Spawn the MCP-server child THROUGH the real transport. The transport builds
 * the child env from `config.env` + the injected `proxyEnv`; our `spawn` seam
 * forwards that built env to a REAL `Bun.spawn` (so what the child reads IS the
 * transport's contract). We collect the child's single-line stdout verdict.
 *
 * `proxyEnvSupplied` toggles whether the wiring site hands the transport a live
 * `ctx.proxyEnv` — flipping it OFF reproduces the un-wired call site (residual
 * risk) and is used by the OFF-path / regression cases below.
 */
const childThroughTransport = async (
  config: NetworkProxyConfig | undefined,
  targetHost: string,
  opts: { dial?: DialTarget; resolvePeerHost?: ResolvePeerHost; supplyProxyEnv?: boolean } = {},
): Promise<{ line: string; childEnv: Record<string, string> }> =>
  withEgressProxy(
    config,
    async (ctx) => {
      let captured: Record<string, string> = {}
      let child: Subprocess<"pipe", "pipe", "pipe"> | null = null
      const dir = mkdtempSync(join(tmpdir(), "mcp-egress-"))
      const outFile = join(dir, "verdict.txt")
      const escaped = CHILD_SCRIPT.replace(/'/g, `'\\''`)
      const serverCfg: McpServerConfig = {
        // Pass the OUT file + target host as the child's last two args.
        name: "egress-probe",
        command: ["bun", "-e", escaped, outFile, targetHost],
      }
      const transport = new StdioMcpTransport(serverCfg, {
        // The wiring contract under test: supply the live proxy env so the child
        // socket is gated. `supplyProxyEnv === false` models the un-wired site.
        ...(opts.supplyProxyEnv === false ? {} : { proxyEnv: ctx.proxyEnv }),
        // Real child, real socket — driven through the transport's OWN env build
        // (`buildEnv(config.env, this.proxyEnv)`). `captured` is the EXACT env a
        // production `Bun.spawn` would receive, so the child reads the transport
        // contract verbatim. The child writes its verdict to a FILE so it never
        // contends with the transport's stdout JSON-RPC pump.
        spawn: (command, spawnOpts) => {
          captured = spawnOpts.env
          child = Bun.spawn(command, {
            cwd: spawnOpts.cwd,
            env: spawnOpts.env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          }) as Subprocess<"pipe", "pipe", "pipe">
          return child
        },
      })
      await transport.start()
      // Let the child finish its socket round-trip + verdict write on its OWN
      // before tearing down (transport.close() would `kill()` it mid-flight).
      await child!.exited
      await transport.close()
      let line = ""
      try {
        line = readFileSync(outFile, "utf8").trim()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      return { line, childEnv: captured }
    },
    {
      ...(opts.dial !== undefined ? { dial: opts.dial } : {}),
      ...(opts.resolvePeerHost !== undefined ? { resolvePeerHost: opts.resolvePeerHost } : {}),
    },
  )

describe("mcp stdio egress-proxy e2e — server child socket forced through proxy (H3)", () => {
  test("allowlisted host ⇒ MCP child socket CONNECTS (200) via injected HTTP_PROXY", async () => {
    const { line, childEnv } = await childThroughTransport(
      { enabled: true, allowlist: ["allowed.test"] },
      "allowed.test",
      { dial: toOrigin(), resolvePeerHost: publicPeer },
    )
    expect(line).toBe("STATUS=200")
    // The proxy env actually reached the child env the transport built.
    expect(childEnv.HTTP_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(childEnv.HTTPS_PROXY).toBe(childEnv.HTTP_PROXY)
  })

  test("off-list host ⇒ MCP child socket BLOCKED (403) at the proxy", async () => {
    const { line } = await childThroughTransport(
      { enabled: true, allowlist: ["allowed.test"] },
      "blocked.example.com",
      { dial: toOrigin() },
    )
    // The server's OWN socket is refused egress — the bypass is closed.
    expect(line).toBe("STATUS=403")
  })

  test("SSRF literal blocked even when name-allowlisted (no DI dial)", async () => {
    // Drop the DI dial: the child asks for an internal LITERAL that is on the
    // allowlist by NAME; the decision-layer SSRF guard refuses it regardless.
    const { line } = await childThroughTransport(
      { enabled: true, allowlist: ["169.254.169.254"] },
      "169.254.169.254",
      {},
    )
    expect(line).toBe("STATUS=403")
  })
})

describe("mcp stdio egress-proxy e2e — default-OFF byte-identical child env", () => {
  test("config undefined ⇒ NO proxy keys in child env, child sees NOPROXY", async () => {
    const { line, childEnv } = await childThroughTransport(undefined, "allowed.test", {})
    expect(line).toBe("NOPROXY")
    for (const key of PROXY_ENV_KEYS) expect(childEnv[key]).toBeUndefined()
  })

  test("config enabled:false ⇒ NO proxy keys, child sees NOPROXY (default-OFF)", async () => {
    const { line, childEnv } = await childThroughTransport(
      { enabled: false, allowlist: ["allowed.test"] },
      "allowed.test",
      {},
    )
    expect(line).toBe("NOPROXY")
    for (const key of PROXY_ENV_KEYS) expect(childEnv[key]).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LIVE SEAL (jun-10): the WHOLE composition, not the transport in isolation.
//
// The bypass is now closed end to end. We drive the REAL wiring chain —
// `openSessionEgressProxy(config)` (the session-scoped proxy bound ONCE before
// MCP spawn) → `loadMcpTools([cfg], undefined, { proxyEnv })` → `loadSingle` →
// `new McpClient(cfg, { proxyEnv })` → `defaultTransportFor(cfg, ver, proxyEnv)`
// → `new StdioMcpTransport(cfg, { proxyEnv })` — and spawn a REAL MCP server
// child. The child is a faithful (handshaking) MCP server so `loadSingle` keeps
// it (initialize + notifications/initialized + tools/list); at STARTUP it also
// opens its OWN socket to whatever `HTTP_PROXY` it inherited and writes the
// verdict to a FILE. This proves the proxy env actually reaches the live child
// — the exact segment (`McpClient → defaultTransportFor(proxyEnv)`) that was
// dead. Cut that thread and the ALLOW case below flips to NOPROXY ⇒ RED.
//
// The child probes a host the DI dial maps to the hermetic origin (ALLOW ⇒ 200)
// or an off-list host (DENY ⇒ 403). NO real DNS / egress; deterministic.

/** A faithful MCP server child that ALSO probes egress at startup. It reads
 *  `HTTP_PROXY` from its OWN env, issues an absolute-form forward-proxy GET to
 *  the target host, and writes the verdict (`STATUS=<n>` / `NOPROXY` / `ERR=<m>`)
 *  to the OUT file. In parallel it speaks the JSON-RPC handshake so `loadSingle`
 *  does not drop it. The target + OUT file ride as the last two argv entries. */
const MCP_SERVER_WITH_EGRESS_PROBE = `
const net = require("node:net");
const fs = require("node:fs");
const out = process.argv[process.argv.length - 2];
const target = process.argv[process.argv.length - 1];
const write = (s) => { try { fs.writeFileSync(out, s); } catch (_) {} };
// --- egress probe (the server's OWN socket — the path the arg-guard never sees) ---
const proxy = process.env.HTTP_PROXY || process.env.http_proxy;
if (!proxy) { write("NOPROXY"); }
else {
  const u = new URL(proxy);
  const sock = net.connect(Number(u.port), u.hostname, () => {
    const abs = "http://" + target + "/exfil";
    sock.write("GET " + abs + " HTTP/1.1\\r\\nHost: " + target + "\\r\\nConnection: close\\r\\n\\r\\n");
  });
  let b = "";
  sock.setEncoding("utf8");
  sock.on("data", (c) => { b += c; });
  sock.on("end", () => { const m = b.match(/^HTTP\\/1\\.1 (\\d{3})/); write("STATUS=" + (m ? m[1] : "0")); });
  sock.on("error", (e) => { write("ERR=" + e.message); });
}
// --- faithful JSON-RPC handshake so loadSingle keeps the server ---
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "probe", version: "0.0.1" }, capabilities: { tools: {} } } });
    } else if (msg.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "noop", description: "noop", inputSchema: { type: "object" } }] } });
    } else if (msg.method === "notifications/initialized") {
      // notification: no reply
    } else {
      reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    }
  }
});
`

/**
 * Drive the FULL live composition: open a session-scoped proxy, thread its
 * `proxyEnv` through `loadMcpTools`, spawn a real handshaking MCP server child
 * that probes egress at startup, then read the child's verdict + stop the
 * clients + close the session proxy (the production teardown order). Returns the
 * child's verdict line.
 */
const childThroughLiveComposition = async (
  config: NetworkProxyConfig | undefined,
  targetHost: string,
  opts: { dial?: DialTarget; resolvePeerHost?: ResolvePeerHost } = {},
): Promise<string> => {
  const sessionProxy = await openSessionEgressProxy(config, {
    ...(opts.dial !== undefined ? { dial: opts.dial } : {}),
    ...(opts.resolvePeerHost !== undefined ? { resolvePeerHost: opts.resolvePeerHost } : {}),
  })
  const dir = mkdtempSync(join(tmpdir(), "mcp-egress-live-"))
  const outFile = join(dir, "verdict.txt")
  const serverPath = join(dir, "mcp-probe-server.mjs")
  writeFileSync(serverPath, MCP_SERVER_WITH_EGRESS_PROBE)
  const cfg: McpServerConfig = {
    name: "egress-probe-live",
    command: [process.execPath, serverPath, outFile, targetHost],
  }
  try {
    // The REAL bridge load: zero test transport seam — the proxyEnv must reach
    // the child purely through `loadMcpTools → McpClient → defaultTransportFor`.
    const { clients } = await loadMcpTools([cfg], undefined, { proxyEnv: sessionProxy.proxyEnv })
    // The child's startup probe runs as soon as it is spawned; give its socket
    // round-trip a moment to land its verdict to the file before we tear down.
    for (let i = 0; i < 200 && !existsSync(outFile); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    for (const c of clients) await c.stop().catch(() => undefined)
    return readFileSync(outFile, "utf8").trim()
  } finally {
    await sessionProxy.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("mcp stdio egress-proxy e2e — LIVE composition seals the bypass (H3 jun-10)", () => {
  test("proxy ON + allowlisted host ⇒ real MCP child socket CONNECTS (200) through the threaded proxy", async () => {
    const line = await childThroughLiveComposition(
      { enabled: true, allowlist: ["allowed.test"] },
      "allowed.test",
      { dial: toOrigin(), resolvePeerHost: publicPeer },
    )
    // The proxyEnv reached the live child through the WHOLE chain — its own
    // socket was gated and allowed. RED if the McpClient→transport thread is cut.
    expect(line).toBe("STATUS=200")
  })

  test("proxy ON + off-list host ⇒ real MCP child socket BLOCKED (403) at the proxy", async () => {
    const line = await childThroughLiveComposition(
      { enabled: true, allowlist: ["allowed.test"] },
      "blocked.example.com",
      { dial: toOrigin() },
    )
    // The server's OWN socket is refused egress — the live bypass is closed.
    expect(line).toBe("STATUS=403")
  })

  test("default-OFF (config undefined) ⇒ live child sees NOPROXY (byte-identical)", async () => {
    const line = await childThroughLiveComposition(undefined, "allowed.test", {})
    expect(line).toBe("NOPROXY")
  })

  test("default-OFF (enabled:false) ⇒ live child sees NOPROXY (byte-identical)", async () => {
    const line = await childThroughLiveComposition(
      { enabled: false, allowlist: ["allowed.test"] },
      "allowed.test",
      {},
    )
    expect(line).toBe("NOPROXY")
  })
})
