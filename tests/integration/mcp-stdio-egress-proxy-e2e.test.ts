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
import type { Subprocess } from "bun"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type DialTarget,
  type NetworkProxyConfig,
  PROXY_ENV_KEYS,
  type ResolvePeerHost,
  withEgressProxy,
} from "@/../src/runtime/network-proxy"
import { type McpServerConfig, StdioMcpTransport } from "@/../src/mcp"

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

describe("mcp stdio egress-proxy e2e — un-wired call site reproduces the egress bypass", () => {
  // RESIDUAL-RISK GUARD: the transport now injects correctly, but the live
  // factory `createTransport` (src/mcp/client.ts) still calls
  // `new StdioMcpTransport(config)` with NO `proxyEnv`. This case models that
  // site (`supplyProxyEnv: false`): even with the proxy ON, a transport that is
  // handed no proxyEnv lets the child reach the network UNGATED (NOPROXY). This
  // documents the remaining wiring gap so a future fix flips it RED on purpose.
  test("proxy ON but transport handed NO proxyEnv ⇒ child UNGATED (NOPROXY) — bypass", async () => {
    const { line, childEnv } = await childThroughTransport(
      { enabled: true, allowlist: ["allowed.test"] },
      "allowed.test",
      { dial: toOrigin(), resolvePeerHost: publicPeer, supplyProxyEnv: false },
    )
    expect(line).toBe("NOPROXY")
    for (const key of PROXY_ENV_KEYS) expect(childEnv[key]).toBeUndefined()
  })
})
