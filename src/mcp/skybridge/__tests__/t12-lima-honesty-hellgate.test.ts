/**
 * T12 hellgate — skybridge honesty (audit L9 M17). `sandboxApplied` must
 * DERIVE from the policy actually enforced. Phase 2 launches the MCP server in
 * a Lima guest (kernel boundary) but does NOT apply the compiled `limayaml`
 * (mounts allowlist / memory cap / network allowlist). So when the policy asks
 * for any of those constraints, the handle must report `sandboxApplied:false`
 * + a `degradeReason` naming the dropped constraints — never claim an
 * isolation that is not in effect.
 */

import { describe, expect, test } from "bun:test"
import { limaMicroVmSandbox } from "@/mcp/skybridge/lima-microvm"
import type {
  McpSandboxConfig,
  McpSandboxPolicy,
  McpServerSpec,
  SkybridgeRunner,
  SkybridgeSpawner,
} from "@/mcp/skybridge/types"

const which = (): McpSandboxConfig["which"] => async (bin) =>
  bin === "lima" ? "/usr/local/bin/lima" : null

const runnerRunning: SkybridgeRunner = async (argv) => {
  // list → report our VM as Running so `lima start` is skipped.
  if (argv[1] === "list") {
    // The VM name is derived from spec.id; we just answer "running" for any.
    return { exitCode: 0, stdout: JSON.stringify({ name: argv[2] ?? "x", status: "Running" }), stderr: "" }
  }
  return { exitCode: 0, stdout: "", stderr: "" }
}
// list with a non-matching name → start is invoked (and succeeds).
const runnerStart: SkybridgeRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" })

const spawner: SkybridgeSpawner = async () => ({ pid: 4242, stop: async () => {} })

const spec = (id: string): McpServerSpec => ({ id, command: ["node", "server.js"] })
const policy = (o: Partial<McpSandboxPolicy> = {}): McpSandboxPolicy => ({
  profile: "microvm",
  ...o,
})

describe("T12 / M17 — lima sandboxApplied derives from enforced policy", () => {
  test("bare policy (no constraints) → sandboxApplied=true, no degradeReason", async () => {
    const sb = limaMicroVmSandbox({ which: which(), spawner, runner: runnerStart })
    const h = await sb.spawn(spec("bare"), policy({}))
    expect(h.sandboxApplied).toBe(true)
    expect(h.degradeReason).toBeUndefined()
  })

  test("hostReadAllowlist requested → DROPPED → sandboxApplied=false + reason", async () => {
    const sb = limaMicroVmSandbox({ which: which(), spawner, runner: runnerStart })
    const h = await sb.spawn(spec("ro"), policy({ hostReadAllowlist: ["/srv"] }))
    expect(h.sandboxApplied).toBe(false)
    expect(h.degradeReason).toBeDefined()
    expect(h.degradeReason).toContain("hostReadAllowlist")
  })

  test("memoryMb + networkAllowlist requested → both named in degradeReason", async () => {
    const sb = limaMicroVmSandbox({ which: which(), spawner, runner: runnerStart })
    const h = await sb.spawn(
      spec("constrained"),
      policy({ memoryMb: 2048, networkAllowlist: ["api.github.com:443"] }),
    )
    expect(h.sandboxApplied).toBe(false)
    expect(h.degradeReason).toContain("memoryMb")
    expect(h.degradeReason).toContain("networkAllowlist")
  })

  test("hostWriteAllowlist requested while VM already running → still honest false", async () => {
    const sb = limaMicroVmSandbox({ which: which(), spawner, runner: runnerRunning })
    const h = await sb.spawn(spec("rw"), policy({ hostWriteAllowlist: ["/data"] }))
    expect(h.sandboxApplied).toBe(false)
    expect(h.degradeReason).toContain("hostWriteAllowlist")
    // Honesty MUST NOT block the MCP from actually spawning.
    expect(h.backendId).toContain("quanta-skybridge-")
  })

  test("empty constraint arrays are NOT 'requested' (no false degrade)", async () => {
    const sb = limaMicroVmSandbox({ which: which(), spawner, runner: runnerStart })
    const h = await sb.spawn(
      spec("empties"),
      policy({ hostReadAllowlist: [], hostWriteAllowlist: [], networkAllowlist: [] }),
    )
    expect(h.sandboxApplied).toBe(true)
    expect(h.degradeReason).toBeUndefined()
  })
})
