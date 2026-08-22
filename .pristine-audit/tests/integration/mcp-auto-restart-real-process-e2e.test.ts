/**
 * MCP auto-restart REAL-PROCESS e2e — closes the headline-behavior gap for
 * ADR-0435 (transparent MCP client swap behind the `mcp__` indirection across a
 * restart).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The supervisor (`src/mcp/reconnect/supervisor.ts`) is unit-tested only on a
 * FAKE clock with a FAKE `SupervisableMcpClient` double (see
 * `supervisor.hellgate.test.ts`). And `mcp-e2e.test.ts`'s `crash` case asserts
 * the OPPOSITE of auto-restart: it drives a bare `McpClient` (no supervisor) and
 * pins that the call REJECTS. Its "respawn" test is a MANUAL fresh client, never
 * the supervised transparent swap.
 *
 * So the *headline* claim — "a bridged `mcp__<server>__<tool>` call survives a
 * real process crash because the reconnect supervisor transparently respawns the
 * subprocess and re-runs initialize+tools/list, and a SUBSEQUENT call RESOLVES"
 * — had ZERO real-process coverage. This file provides it.
 *
 * WHAT IS REAL vs INJECTED
 * ------------------------
 *  - REAL: the MCP subprocess (spawned twice — original + respawn), the JSON-RPC
 *    stdio transport, the `McpClient`, the `McpReconnectSupervisor`, and the
 *    `loadMcpTools({ supervisorDepsFor })` → `mcpToolToToolSupervised` bridge.
 *    The crash is a genuine `process.exit(1)`; the respawn is a genuine second
 *    `Bun.spawn` of the server binary by the supervisor's `factory`.
 *  - REAL scheduler: `setTimer` is real `setTimeout` (NOT the fake-clock queue)
 *    so the backoff→respawn→initialize→swap is driven by real timers. Only the
 *    backoff BASE is shortened (10ms) so the real cycle is fast, not slow. This
 *    is the "real-ish client crash on a real subprocess cycle" the harness
 *    prefers — nothing about the crash/respawn/swap is faked.
 *
 * GROUND TRUTH: after the real crash, the bridged tool call RESOLVES ok:true.
 *
 * NON-VACUOUS PROOF (two arms, both in this file):
 *  1. CONTROL (supervisor OFF): the SAME crashing server loaded WITHOUT
 *     `supervisorDepsFor` (bare single-client path) ⇒ the post-crash call FAILS
 *     — proving the supervisor is what turns the crash into a survivable event.
 *  2. RED-ON-INJECTION (supervisor respawn neutered): a `supervisorDepsFor`
 *     whose `factory` returns a client that can build the FIRST process but whose
 *     restart re-spawn is sabotaged (start throws) ⇒ the supervisor can never
 *     reach HEALTHY again ⇒ the post-crash call FAILS. Flipping the sabotage off
 *     is exactly the GREEN main path — so the assertion is load-bearing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadMcpTools } from "@/agent"
import {
  DEFAULT_BACKOFF_POLICY,
  McpClient,
  type McpReconnectSupervisor,
  type McpServerConfig,
  type SupervisableMcpClient,
  type SupervisorDeps,
} from "@/mcp"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "@/tool"
import { withTimeout } from "./_harness"

/**
 * REAL crash-once MCP server. It exposes ONE tool (`echo`). On a `tools/call`,
 * it consults a marker file (path passed via `QUANTA_CRASH_MARKER`):
 *   - marker ABSENT  ⇒ write the marker, then `process.exit(1)` — a REAL crash
 *     of the REAL subprocess mid-call (the FIRST process dies).
 *   - marker PRESENT ⇒ answer normally (the RESPAWNED process, a fresh
 *     `Bun.spawn`, finds the marker and serves the call).
 *
 * Because each respawn is a brand-new process with no shared memory, the marker
 * file is the ONLY way the second process knows the first already crashed — this
 * makes the "crash exactly once, then work" cycle deterministic across a real
 * fork boundary. The handshake (initialize + tools/list) ALWAYS succeeds so the
 * respawn's `start()`+`listTools()` (which the supervisor re-runs) is real.
 */
const CRASH_ONCE_SERVER = `
const fs = require("node:fs")
const marker = process.env.QUANTA_CRASH_MARKER
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.method === "initialize") {
      reply({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "crashsrv", version: "0.0.1" },
        capabilities: { tools: {} },
      } })
    } else if (msg.method === "notifications/initialized") {
      // noop
    } else if (msg.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: msg.id, result: {
        tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object" } }],
      } })
    } else if (msg.method === "tools/call") {
      const crashed = fs.existsSync(marker)
      if (!crashed) {
        // FIRST process: record that we're about to crash, then die mid-call.
        try { fs.writeFileSync(marker, "1") } catch {}
        process.exit(1)
      } else {
        // RESPAWNED process: serve the call.
        reply({ jsonrpc: "2.0", id: msg.id, result: {
          content: [{ type: "text", text: "survived-restart:" + (msg.params.arguments.who || "world") }],
        } })
      }
    } else {
      reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })
    }
  }
})
`

let dir: string
let serverPath: string
let markerSeq = 0

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-autorestart-e2e-"))
  serverPath = join(dir, "crash-once-server.mjs")
  await writeFile(serverPath, CRASH_ONCE_SERVER)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A FRESH marker path per case so the crash-once state never bleeds. */
const freshMarker = (): string => join(dir, `crash-marker-${markerSeq++}`)

/** Build a config that spawns the real crash-once server with its OWN marker. */
const configWithMarker = (name: string, marker: string): McpServerConfig => ({
  name,
  command: [process.execPath, serverPath],
  env: { QUANTA_CRASH_MARKER: marker },
})

/** REAL scheduler + real clock, with a SHORT backoff so the genuine
 *  crash→respawn cycle is fast. The ONLY thing tuned is the backoff BASE — the
 *  timer itself is a real `setTimeout`, the respawn is a real `Bun.spawn`. */
const realSchedulerDeps = (
  factory: SupervisorDeps["factory"],
  onStateChange?: SupervisorDeps["onStateChange"],
): SupervisorDeps => ({
  factory,
  policy: { ...DEFAULT_BACKOFF_POLICY, fastRetryBaseMs: 10, fastRetryMaxMs: 50 },
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  },
  random: () => 0, // deterministic: delay === base
  ...(onStateChange !== undefined ? { onStateChange } : {}),
})

const toolCtx = (): ToolContext => ({ cwd: dir, signal: new AbortController().signal })

/** Drive a bridged `mcp__…` Tool to its terminal `result` event and return the
 *  `ToolResult`. The supervised bridge (`mcpToolToToolSupervised` →
 *  `streamMcpCall`) always yields exactly one `{ type: "result" }` — even on a
 *  failure it maps to `ok:false` and never throws — so this drains to that. */
const runBridged = async (tool: Tool, input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input, toolCtx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (result === undefined) throw new Error("bridged tool produced no result event")
  return result
}

/** Poll the supervisor snapshot until it reports HEALTHY again (or the deadline
 *  trips). Real timers drive the respawn, so we spin the event loop and re-read
 *  the live snapshot. Returns the last-seen state for diagnostics. */
const waitForHealthy = async (sup: McpReconnectSupervisor, deadlineMs: number): Promise<string> => {
  const start = Date.now()
  let state = sup.snapshot().state
  while (Date.now() - start < deadlineMs) {
    state = sup.snapshot().state
    if (state === "healthy") return state
    if (state === "degraded") return state
    await new Promise((r) => setTimeout(r, 5))
  }
  return state
}

describe("MCP auto-restart — REAL process crash → transparent supervised respawn", () => {
  test("bridged mcp__crashsrv__echo call RESOLVES after a real crash+respawn (headline transparent swap)", async () => {
    const marker = freshMarker()
    const states: string[] = []
    const { tools, clients } = await loadMcpTools(
      [configWithMarker("crashsrv", marker)],
      undefined,
      {
        supervisorDepsFor: (_config) =>
          realSchedulerDeps(
            // REAL factory: each (re)start builds a real McpClient → real
            // subprocess. The supervisor calls this on the initial start AND on
            // every respawn.
            (cfg) => new McpClient(cfg) as SupervisableMcpClient,
            (s) => states.push(s.state),
          ),
      },
    )
    try {
      const echo = tools.find((t) => t.name === "mcp__crashsrv__echo")
      expect(echo).toBeDefined()
      // The returned client IS the supervisor (compatible stop()); read its live
      // snapshot to observe the transparent lifecycle.
      const sup = clients[0] as unknown as McpReconnectSupervisor
      expect(sup.snapshot().state).toBe("healthy")

      // FIRST call ⇒ the REAL subprocess writes the marker and `process.exit(1)`
      // mid-call. The supervised bridge maps the resulting transport failure to
      // an ok:false result (it never throws). This is the crash trigger.
      const first = await withTimeout(
        runBridged(echo as Tool, { who: "quanta" }),
        15_000,
        "crash-trigger call",
      )
      expect(first.ok).toBe(false)

      // The onExit fan-out → supervisor.onCrash → scheduleRestart → attemptRestart
      // now spawns a SECOND real subprocess on real timers. Wait for HEALTHY.
      const recovered = await waitForHealthy(sup, 15_000)
      expect(recovered).toBe("healthy")
      // The supervisor actually walked the crash lifecycle (not a no-op): the
      // observed transitions must include a respawn path.
      expect(states).toContain("crashed")
      expect(states).toContain("restarting")

      // GROUND TRUTH: a SUBSEQUENT bridged call through the SAME stable
      // `mcp__crashsrv__echo` name now RESOLVES against the RESPAWNED process.
      const after = await withTimeout(
        runBridged(echo as Tool, { who: "quanta" }),
        15_000,
        "post-respawn call",
      )
      expect(after.ok).toBe(true)
      expect(after.output).toContain("survived-restart:quanta")
    } finally {
      for (const c of clients) await c.stop().catch(() => undefined)
    }
  }, 45_000)

  // --- CONTROL: supervisor OFF ⇒ the crash is fatal to the tool ---------------
  test("CONTROL — same crashing server WITHOUT a supervisor: the post-crash call FAILS (proves the supervisor is load-bearing)", async () => {
    const marker = freshMarker()
    // No `supervisorDepsFor` ⇒ the byte-identical single-client path. There is
    // NO auto-restart; a crashed subprocess stays dead.
    const { tools, clients } = await loadMcpTools([configWithMarker("crashsrv", marker)])
    try {
      const echo = tools.find((t) => t.name === "mcp__crashsrv__echo")
      expect(echo).toBeDefined()

      // Crash-trigger call: the real process exits mid-call.
      const first = await withTimeout(
        runBridged(echo as Tool, { who: "quanta" }),
        15_000,
        "control crash-trigger",
      )
      expect(first.ok).toBe(false)

      // Give any (nonexistent) recovery the same wall-clock budget the auto-
      // restart path used — then a SECOND call must STILL FAIL, because nothing
      // respawned the dead client. This is the non-vacuous control: the ONLY
      // difference from the passing test above is the absent supervisor.
      await new Promise((r) => setTimeout(r, 300))
      const after = await withTimeout(
        runBridged(echo as Tool, { who: "quanta" }),
        15_000,
        "control post-crash",
      )
      expect(after.ok).toBe(false)
      expect(after.output).not.toContain("survived-restart")
    } finally {
      for (const c of clients) await c.stop().catch(() => undefined)
    }
  }, 45_000)

  // --- RED-ON-INJECTION: neuter the supervisor's respawn ----------------------
  test("RED-ON-INJECTION — respawn sabotaged (restart start() throws): post-crash call FAILS; the ONLY delta from GREEN is the sabotage", async () => {
    const marker = freshMarker()
    const states: string[] = []
    let spawnCount = 0
    const { tools, clients } = await loadMcpTools(
      [configWithMarker("crashsrv", marker)],
      undefined,
      {
        supervisorDepsFor: (_config) =>
          realSchedulerDeps(
            (cfg) => {
              spawnCount += 1
              const real = new McpClient(cfg) as SupervisableMcpClient
              if (spawnCount === 1) {
                // First client (initial start) is the real, working process so the
                // session boots HEALTHY exactly like the GREEN path.
                return real
              }
              // Every RESPAWN is sabotaged: its `start()` throws, so the supervisor
              // can never reach HEALTHY again — the transparent swap is neutered.
              // A DELEGATING wrapper (not an object spread) so `stop`/`listTools`/
              // `onExit` still forward to the real client — the ONLY behavioral
              // delta from the GREEN path is that `start()` throws. (We stop the
              // real subprocess it spawned so we don't leak it.)
              const sabotaged: SupervisableMcpClient = {
                async start(): Promise<void> {
                  await real.stop().catch(() => undefined)
                  throw new Error("sabotaged respawn: start disabled")
                },
                listTools: () => real.listTools(),
                callTool: (name, args, opts) => real.callTool(name, args, opts),
                stop: () => real.stop(),
                onExit: (handler) => real.onExit(handler),
              }
              return sabotaged
            },
            (s) => states.push(s.state),
          ),
      },
    )
    try {
      const echo = tools.find((t) => t.name === "mcp__crashsrv__echo")
      expect(echo).toBeDefined()
      const sup = clients[0] as unknown as McpReconnectSupervisor
      expect(sup.snapshot().state).toBe("healthy")

      // Crash the real first process.
      const first = await withTimeout(
        runBridged(echo as Tool, { who: "quanta" }),
        15_000,
        "injection crash-trigger",
      )
      expect(first.ok).toBe(false)

      // The supervisor keeps trying to respawn, but every respawn's start()
      // throws ⇒ it never returns to HEALTHY (it churns backing-off/restarting,
      // ultimately DEGRADED once caps exhaust). It must NOT reach healthy.
      const finalState = await waitForHealthy(sup, 8_000)
      expect(finalState).not.toBe("healthy")
      // Proof the sabotage was actually exercised: at least one respawn attempt
      // (spawnCount>1) ⇒ the factory was re-invoked for a restart.
      expect(spawnCount).toBeGreaterThan(1)

      // GROUND TRUTH of the RED arm: the post-crash bridged call FAILS. In the
      // GREEN test the ONLY difference is that these respawns start() cleanly.
      const after = await withTimeout(
        runBridged(echo as Tool, { who: "quanta" }),
        15_000,
        "injection post-crash",
      )
      expect(after.ok).toBe(false)
      expect(after.output).not.toContain("survived-restart")
    } finally {
      for (const c of clients) await c.stop().catch(() => undefined)
    }
  }, 45_000)
})
