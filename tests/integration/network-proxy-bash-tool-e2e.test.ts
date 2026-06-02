/**
 * Network-egress proxy — BUG1 PROOF: REAL bash-tool dispatch path (ADR-0428,
 * jun-02 live-wire fix).
 *
 * The sibling `network-proxy-subprocess-e2e.test.ts` drives `runShell` directly
 * with a hand-threaded `proxyEnv`. THIS battery proves the thing the jun-02 fix
 * actually closed: the egress proxy is now wired through the ACTUAL bash TOOL
 * dispatch path — `ToolContext.proxyEnv` → `bashTool.execute` → `runShell` — so
 * a real child process spawned by the LLM-facing tool has its OWN sockets gated.
 *
 * Before the fix `ctx.proxyEnv` did not exist and the bash tool never forwarded
 * any proxy env, so `QUANTA_NETWORK_PROXY` enforced NOTHING on the tool path.
 *
 * Hermetic + offline + deterministic: a local Node http origin stands in for the
 * internet; the `DialTarget` DI maps routable NAMES to it; the child speaks the
 * forward-proxy protocol over the injected `HTTP_PROXY` (Node stdlib only). The
 * peer-classification DI (`resolvePeerHost`) returns a PUBLIC literal on the
 * allow path so the always-on rebinding re-check passes the hermetic loopback.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import {
  type DialTarget,
  type NetworkProxyConfig,
  type ResolvePeerHost,
  withEgressProxy,
} from "@/../src/runtime/network-proxy"
import { bashTool } from "@/../src/tool/bash"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"

let origin: Server
let originPort: number

const toOrigin = (): DialTarget => () => ({ host: "127.0.0.1", port: originPort })
/** Allow-path peer resolver — classify the hermetic peer as a PUBLIC literal
 *  (RFC 5737 TEST-NET-3 ⇒ not SSRF) so the always-on peer re-check passes. */
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

/** Child opens its OWN socket to HTTP_PROXY and issues an absolute-form GET for
 *  the target host. Prints STATUS=<n> / NOPROXY / ERR=<msg>. */
const CHILD_SCRIPT = `
const net = require("node:net");
const target = process.argv[process.argv.length - 1];
const proxy = process.env.HTTP_PROXY || process.env.http_proxy;
if (!proxy) { process.stdout.write("NOPROXY\\n"); process.exit(0); }
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
  process.stdout.write("STATUS=" + (m ? m[1] : "0") + "\\n");
});
sock.on("error", (e) => { process.stdout.write("ERR=" + e.message + "\\n"); });
`

/** Drain the bash TOOL (not runShell) into a single ToolResult. */
const runBashTool = async (command: string, ctx: ToolContext): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of bashTool.execute({ command } as never, ctx) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("bash tool produced no result")
  return last
}

/** Run a child through the bash TOOL with the live proxy's env on ctx.proxyEnv. */
const childThroughBashTool = async (
  config: NetworkProxyConfig | undefined,
  targetHost: string,
  opts: { dial?: DialTarget; resolvePeerHost?: ResolvePeerHost } = {},
): Promise<string> =>
  withEgressProxy(
    config,
    async (proxyCtx): Promise<string> => {
      const escaped = CHILD_SCRIPT.replace(/'/g, `'\\''`)
      const ctx: ToolContext = {
        cwd: process.cwd(),
        signal: new AbortController().signal,
        // The live proxy env surfaced exactly as the dispatch seam wires it.
        proxyEnv: proxyCtx.proxyEnv,
      }
      const result = await runBashTool(`bun -e '${escaped}' ${targetHost}`, ctx)
      return result.output
    },
    {
      ...(opts.dial !== undefined ? { dial: opts.dial } : {}),
      ...(opts.resolvePeerHost !== undefined ? { resolvePeerHost: opts.resolvePeerHost } : {}),
    },
  )

describe("network-proxy BUG1 — wired through the REAL bash tool dispatch path", () => {
  test("allowlisted host ⇒ bash-tool child socket CONNECTS (200)", async () => {
    const out = await childThroughBashTool(
      { enabled: true, allowlist: ["allowed.test"] },
      "allowed.test",
      { dial: toOrigin(), resolvePeerHost: publicPeer },
    )
    expect(out).toContain("STATUS=200")
  })

  test("off-list host ⇒ bash-tool child BLOCKED at the socket (403)", async () => {
    const out = await childThroughBashTool(
      { enabled: true, allowlist: ["allowed.test"] },
      "blocked.example.com",
      { dial: toOrigin(), resolvePeerHost: publicPeer },
    )
    // The child's OWN socket is refused — the subprocess bypass is closed via
    // the bash TOOL path (not just a direct runShell call).
    expect(out).toContain("STATUS=403")
  })

  test("knob absent ⇒ bash-tool child env has NO proxy vars (byte-identical)", async () => {
    const out = await childThroughBashTool(undefined, "allowed.test", {})
    expect(out).toContain("NOPROXY")
  })

  test("knob enabled:false ⇒ NO proxy vars in the bash-tool child", async () => {
    const out = await childThroughBashTool(
      { enabled: false, allowlist: ["allowed.test"] },
      "allowed.test",
      {},
    )
    expect(out).toContain("NOPROXY")
  })
})
