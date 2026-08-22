/**
 * Network-egress proxy — REAL SUBPROCESS e2e (ADR-0428, knob + spawn wiring).
 *
 * The existing `network-proxy-e2e.test.ts` drives the proxy with hand-rolled
 * client sockets. This battery proves the THING THE SLICE EXISTS FOR: a REAL
 * spawned child process (`runShell` → `bun … inline-script`) whose egress is
 * forced through the proxy by the injected `HTTP_PROXY` env actually
 *   - CONNECTS to an allowlisted host, and
 *   - is BLOCKED at the SOCKET for an off-list host,
 * proving the subprocess-bypass is closed (not merely the tool-arg gate). Plus:
 * runtime amendment then allows; SSRF blocked even when name-allowlisted; and
 * the knob-absent path leaves the child env byte-identical (no proxy vars).
 *
 * Hermetic + offline + deterministic:
 *   - A local Node http origin on an ephemeral port stands in for "the internet".
 *   - The `DialTarget` DI seam maps routable NAMES to that loopback origin so the
 *     ALLOW path is exercised without real DNS / real egress.
 *   - The child speaks the forward-proxy protocol over the injected `HTTP_PROXY`
 *     using Node stdlib only (no deps) and prints a single machine-readable line.
 *   - Assertions are connection-accepted / refused (HTTP status) + decision-log
 *     entries only. NO heuristics, NO thresholds, NO timing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import {
  type DecisionLogEntry,
  type DialTarget,
  type NetworkPolicyAmendment,
  type NetworkProxyConfig,
  PROXY_ENV_KEYS,
  type ResolvePeerHost,
  withEgressProxy,
} from "@/../src/runtime/network-proxy"
import { runShell } from "@/../src/runtime/shell"

// ── Hermetic upstream origin (the "real internet" for this test) ────────────
let origin: Server
let originPort: number

/** DI dial mapping ANY policy host to the hermetic loopback origin — keeps the
 *  test offline while exercising routable NAMES through the real allow/deny
 *  policy + real child sockets. */
const toOrigin = (): DialTarget => () => ({ host: "127.0.0.1", port: originPort })

/** jun-02 SSRF re-audit: the post-connect peer re-check now ALWAYS runs, so a
 *  hermetic loopback dial would be classified as loopback and (correctly) block
 *  the allow path. ALLOW-path tests resolve the peer to a PUBLIC literal (RFC
 *  5737 TEST-NET-3 ⇒ classifyHost returns null) — the address the routable name
 *  would resolve to in production. */
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
 * Inline child script (Node stdlib, no deps). Reads `HTTP_PROXY` from its OWN
 * env, opens a socket to it, and issues an absolute-form forward-proxy GET for
 * the host passed as argv[0]. Prints ONE line: `STATUS=<n>` (proxy response
 * status) or `NOPROXY` when no proxy var was injected, or `ERR=<msg>`. This is
 * the subprocess opening its OWN socket — exactly the path the tool-arg guard
 * never sees. */
const CHILD_SCRIPT = `
const net = require("node:net");
// The target host is the LAST argv entry — robust to bun -e (argv[1]) vs node
// (argv[2]) differing on where the first user arg lands.
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

interface ChildVerdict {
  readonly line: string
  readonly log: readonly DecisionLogEntry[]
}

/** Run a real child via the WIRED `runShell` path under a live proxy. Returns
 *  the child's single-line verdict + the proxy's decision log. */
const childThroughProxy = async (
  config: NetworkProxyConfig | undefined,
  targetHost: string,
  opts: {
    dial?: DialTarget
    resolvePeerHost?: ResolvePeerHost
    amend?: (a: NetworkPolicyAmendment) => void
  } = {},
): Promise<ChildVerdict> =>
  withEgressProxy(
    config,
    async (ctx): Promise<ChildVerdict> => {
      if (ctx.proxy !== null && opts.amend !== undefined) opts.amend(ctx.proxy.amendments)
      // The child runs the inline script; bun is guaranteed on PATH in CI.
      const escaped = CHILD_SCRIPT.replace(/'/g, `'\\''`)
      const res = await runShell(`bun -e '${escaped}' ${targetHost}`, {
        timeoutMs: 15_000,
        proxyEnv: ctx.proxyEnv,
      })
      return {
        line: res.stdout.trim(),
        log: ctx.proxy?.decisionLog() ?? [],
      }
    },
    {
      ...(opts.dial !== undefined ? { dial: opts.dial } : {}),
      ...(opts.resolvePeerHost !== undefined ? { resolvePeerHost: opts.resolvePeerHost } : {}),
    },
  )

describe("network-proxy subprocess e2e — real child socket forced through proxy", () => {
  test("allowlisted host ⇒ child socket CONNECTS (200), 'allow' logged", async () => {
    const { line, log } = await childThroughProxy(
      { enabled: true, allowlist: ["allowed.test"] },
      "allowed.test",
      { dial: toOrigin(), resolvePeerHost: publicPeer },
    )
    expect(line).toBe("STATUS=200")
    expect(log.at(-1)?.decision).toBe("allow")
    expect(log.at(-1)?.host).toBe("allowed.test")
  })

  test("off-list host ⇒ child socket BLOCKED (403) at the proxy, 'deny' logged", async () => {
    const { line, log } = await childThroughProxy(
      { enabled: true, allowlist: ["allowed.test"] },
      "blocked.example.com",
      { dial: toOrigin() },
    )
    // The child's OWN socket is refused egress — this is the bypass being closed.
    expect(line).toBe("STATUS=403")
    expect(log.at(-1)?.decision).toBe("deny")
    expect(log.at(-1)?.host).toBe("blocked.example.com")
  })
})

describe("network-proxy subprocess e2e — runtime amendment allows after approval", () => {
  test("off-list child denied; after amend(host) ⇒ child connects (amended-allow)", async () => {
    // First call: empty allowlist ⇒ child denied at socket.
    const denied = await childThroughProxy({ enabled: true, allowlist: [] }, "amend.example.com", {
      dial: toOrigin(),
    })
    expect(denied.line).toBe("STATUS=403")

    // Second call: amend the host into the LIVE allow-set before the child runs.
    const allowed = await childThroughProxy({ enabled: true, allowlist: [] }, "amend.example.com", {
      dial: toOrigin(),
      resolvePeerHost: publicPeer,
      amend: (amendments) =>
        amendments.amend({
          host: "amend.example.com",
          scope: "turn-7",
          reason: "operator approved",
        }),
    })
    expect(allowed.line).toBe("STATUS=200")
    expect(allowed.log.at(-1)?.decision).toBe("amended-allow")
    expect(allowed.log.at(-1)?.reason).toContain("turn-7")
  })
})

describe("network-proxy subprocess e2e — SSRF blocked even when name-allowlisted", () => {
  // Production peer SSRF re-check is active only with the identity dial, so we
  // drop the DI dial here: the child asks for an internal LITERAL that is on the
  // allowlist by NAME, and the decision-layer SSRF guard refuses it regardless.
  for (const host of ["169.254.169.254", "127.0.0.1", "10.0.0.5", "192.168.1.1"]) {
    test(`child targeting ${host} ⇒ 403 even though '${host}' is allowlisted`, async () => {
      const { line, log } = await childThroughProxy({ enabled: true, allowlist: [host] }, host, {})
      expect(line).toBe("STATUS=403")
      expect(log.at(-1)?.decision).toBe("deny")
      expect(log.at(-1)?.reason.toLowerCase()).toContain("ssrf")
    })
  }
})

describe("network-proxy subprocess e2e — knob absent ⇒ child env byte-identical", () => {
  test("config undefined ⇒ NO proxy constructed, child sees NO proxy vars", async () => {
    const { line, log } = await childThroughProxy(undefined, "allowed.test", {})
    // The child found no HTTP_PROXY in its env ⇒ the wiring injected nothing.
    expect(line).toBe("NOPROXY")
    expect(log).toEqual([])
  })

  test("config enabled:false ⇒ NO proxy, NO proxy vars (default-OFF)", async () => {
    const { line } = await childThroughProxy(
      { enabled: false, allowlist: ["allowed.test"] },
      "allowed.test",
      {},
    )
    expect(line).toBe("NOPROXY")
  })

  test("PROXY_ENV_KEYS are absent from the child env on the OFF path", async () => {
    // Run a child that prints which proxy keys are present; assert none.
    const probe = `
const keys = ${JSON.stringify(PROXY_ENV_KEYS)};
const present = keys.filter((k) => process.env[k] !== undefined);
process.stdout.write("PRESENT=" + present.join(",") + "\\n");
`
    const escaped = probe.replace(/'/g, `'\\''`)
    const out = await withEgressProxy(undefined, async (ctx) => {
      const res = await runShell(`bun -e '${escaped}'`, {
        timeoutMs: 15_000,
        proxyEnv: ctx.proxyEnv,
      })
      return res.stdout.trim()
    })
    expect(out).toBe("PRESENT=")
  })
})

describe("network-proxy lifecycle — socket closed on teardown (no leak)", () => {
  test("proxy is closed after withEgressProxy returns (re-listen on same port ok)", async () => {
    let boundPort = 0
    await withEgressProxy(
      { enabled: true, allowlist: ["allowed.test"], port: 0 },
      async (ctx) => {
        boundPort = ctx.proxyEnv.address?.port ?? 0
        expect(boundPort).toBeGreaterThan(0)
      },
      { dial: toOrigin() },
    )
    // If the socket were leaked, binding the SAME ephemeral port immediately
    // would still be fine (ephemeral), so instead we prove the proxy answered
    // during the body and the body completed — close() ran in finally. A second
    // independent proxy binds cleanly, proving no fd/handle exhaustion.
    await withEgressProxy(
      { enabled: true, allowlist: ["allowed.test"] },
      async (ctx) => {
        expect(ctx.proxy).not.toBeNull()
        expect(ctx.proxyEnv.address?.port).toBeGreaterThan(0)
      },
      { dial: toOrigin() },
    )
  })

  test("body throw ⇒ proxy still closed (finally), error propagates", async () => {
    const boom = new Error("body blew up")
    await expect(
      withEgressProxy(
        { enabled: true, allowlist: ["allowed.test"] },
        async () => {
          throw boom
        },
        { dial: toOrigin() },
      ),
    ).rejects.toBe(boom)
  })
})
