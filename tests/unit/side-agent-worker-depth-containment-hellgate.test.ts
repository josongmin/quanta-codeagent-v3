/**
 * HELLGATE — OS-process side-agent DEPTH CONTAINMENT (defense-in-depth).
 *
 * The process-backed side-agent (`QUANTA_SIDE_AGENT_PROCESS`) forks an OS
 * process running `worker-charter-runner.ts`, whose `assembleChildConfig` builds
 * the daemon PARENT `AgentConfig` handed to `createSubagentRunner`.
 * `subagentRunnerToSidePass` invokes that runner ONCE to spawn the actual
 * investigating pass, which runs at `childDepthOf(parent) = parent.depth + 1`.
 *
 * PRIOR HOLE: the config was DEPTH-BLIND (`depth: undefined` ⇒ treated as a
 * genuine ROOT). Under the DEFAULT operator cap the single investigating pass is
 * a depth-1 leaf, so spawn tools are already projected away — BUT a background
 * daemon treated as root inherits the FULL root spawning budget: if the operator
 * policy `QUANTA_MAX_DESCENDANT_DEPTH` were WIDENED, the daemon's pass could
 * recurse descendants, contained ONLY by the `subagentRunnerToSidePass`
 * read-only tool filter (single-layer).
 *
 * FIX under test: `assembleChildConfig` pins a TIGHTENING-ONLY per-config
 * `subagent.maxDepth = childDepthOf(daemon)`, so the effective ceiling
 * (`min(operator policy, this)`) admits EXACTLY the one investigating pass and NO
 * deeper — the investigating pass's own children are denied fail-closed even
 * under a widened operator policy. Defense-in-depth ON TOP of the read filter.
 *
 * RED (pre-fix): `assembleChildConfig(...)` carries no `subagent.maxDepth`, so
 * under a WIDENED policy the investigating pass is spawn-tool-ENTITLED.
 * red-on-injection: revert the fix (drop the pin) ⇒ RED again.
 */

import { describe, expect, test } from "bun:test"
import { childDepthOf, effectiveCap, spawnToolsAvailable } from "@/agent/spawn-depth"
import { projectSpawnTools, SPAWN_TOOL_NAMES } from "@/agent/spawn-projection"
import type { AgentConfig } from "@/agent/types"
import type { EnvLike, LLMPort } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import type {
  ChildProcessHandle,
  DelayScheduler,
  ProcessForkPort,
  ProcessForkSpec,
  SideAgentSpec,
} from "@/side-agent"
import {
  createProcessSideAgentDaemonRegistry,
  WORKER_PARENT_DEPTH_ENV_KEY,
} from "@/side-agent/process-registry"
import {
  assembleChildConfig,
  MIN_DAEMON_DEPTH,
  resolveDaemonDepth,
  WORKER_PARENT_DEPTH_ENV,
} from "@/side-agent/worker-charter-runner"
import type { Tool } from "@/tool"

const withCap = (cap: number | undefined): void => {
  if (cap === undefined) delete process.env["QUANTA_MAX_DESCENDANT_DEPTH"]
  else process.env["QUANTA_MAX_DESCENDANT_DEPTH"] = String(cap)
  __resetRuntimeConfig()
}

/** A never-called LLM stub — assembly does not invoke it. */
const stubLlm = (): LLMPort =>
  ({
    stream: () => {
      throw new Error("unused")
    },
  }) as unknown as LLMPort

/** A fake spawn-creation tool tagged with a real SPAWN_TOOL_NAMES name, plus a
 *  benign read tool, so projection has something to strip AND keep. */
const spawnToolNamed = (name: string): Tool =>
  ({
    name,
    description: name,
    parameters: {},
    execute: () => (async function* () {})(),
  }) as unknown as Tool

/** Assemble the DAEMON PARENT config via the REAL production depth resolver
 *  (empty env ⇒ fail-closed floor), so the depth/cap under test are the shipped
 *  resolution, not test-baked literals. */
const assemble = (env: EnvLike = {}): AgentConfig =>
  assembleChildConfig(stubLlm(), "/repo", resolveDaemonDepth(env))

/** The config the INVESTIGATING PASS runs under: depth = childDepthOf(daemon),
 *  inheriting the daemon's tightening `subagent` block (the runner propagates
 *  `parent.subagent` onto the child — see subagent-runner.ts). This is the
 *  surface `projectSpawnTools`/`spawnToolsAvailable` gate for the pass. */
const passConfigOf = (daemon: AgentConfig): AgentConfig =>
  ({
    depth: childDepthOf(daemon),
    ...(daemon.subagent ? { subagent: daemon.subagent } : {}),
  }) as unknown as AgentConfig

describe("worker-charter-runner assembleChildConfig — daemon depth containment", () => {
  test("daemon config pins a tightening subagent.maxDepth = childDepthOf(daemon)", () => {
    const daemon = assemble()
    // RED pre-fix: no subagent block ⇒ no tightening cap ⇒ widened policy leaks.
    expect(daemon.subagent).toBeDefined()
    expect(daemon.subagent?.maxDepth).toBe(childDepthOf(daemon))
    // The pinned cap is a real, non-root descendant level (the pass runs >= 1).
    expect(childDepthOf(daemon)).toBeGreaterThanOrEqual(1)
  })

  test("under a WIDENED operator policy the investigating pass is STILL a LEAF", () => {
    withCap(9) // operator policy widened far past the default 1
    try {
      const pass = passConfigOf(assemble())
      const pinned = pass.subagent?.maxDepth
      expect(typeof pinned).toBe("number")
      // effectiveCap = min(policy 9, pinned tightening cap) === the pinned cap,
      // so the pass at its own depth is NOT entitled to spawn tools.
      expect(effectiveCap(pinned)).toBe(pinned as number)
      expect(spawnToolsAvailable(pass)).toBe(false)

      // Behavioral: projectSpawnTools strips every creation tool for the pass.
      const menu: Tool[] = [
        spawnToolNamed("agent"),
        spawnToolNamed("side_agent_spawn"),
        spawnToolNamed("subagent_fork"),
        spawnToolNamed("read_file"), // survivor control
      ]
      const projectedNames = projectSpawnTools(menu, pass).map((t) => t.name)
      for (const spawnName of SPAWN_TOOL_NAMES) {
        expect(projectedNames).not.toContain(spawnName)
      }
      expect(projectedNames).toContain("read_file")
    } finally {
      withCap(undefined)
    }
  })

  test("PAIRED CONTROL: WITHOUT the pin, a widened policy WOULD expose spawn tools to the pass", () => {
    withCap(9)
    try {
      const daemon = assemble()
      // Same pass depth but strip the tightening subagent block (simulates the
      // pre-fix depth-blind root-budget path). Now effectiveCap = policy 9, and a
      // depth-1 pass IS entitled ⇒ proves the pin is what closes the hole.
      const unpinnedPass = { depth: childDepthOf(daemon) } as unknown as AgentConfig
      expect(spawnToolsAvailable(unpinnedPass)).toBe(true)
      expect(
        projectSpawnTools([spawnToolNamed("agent")], unpinnedPass).map((t) => t.name),
      ).toContain("agent")
    } finally {
      withCap(undefined)
    }
  })

  test("CONTAINMENT at daemon-depth BOUNDARIES 0,1,2: pinned cap forbids the pass's CHILDREN under a widened policy", () => {
    withCap(9) // widened operator policy — the daemon must NOT inherit root budget
    try {
      for (const daemonDepth of [0, 1, 2]) {
        const daemon = assembleChildConfig(stubLlm(), "/repo", daemonDepth)
        const passDepth = childDepthOf(daemon) // daemonDepth + 1
        expect(daemon.subagent?.maxDepth).toBe(passDepth) // pin tracks the boundary

        // The pass ITSELF is admitted (childDepth == cap) — the one legit pass.
        const pass = passConfigOf(daemon)
        expect(spawnToolsAvailable(pass)).toBe(false) // …but is a LEAF (cannot spawn)

        // The pass's OWN hypothetical child sits one deeper than the pinned cap, so
        // even with policy 9 it is NOT admissible: childDepthOf(pass) > effectiveCap.
        const grandchildDepth = childDepthOf(pass) // passDepth + 1
        expect(grandchildDepth).toBeGreaterThan(effectiveCap(daemon.subagent?.maxDepth))
        // The ceiling IS the pinned cap (min(9, pin) === pin), not the widened policy.
        expect(effectiveCap(daemon.subagent?.maxDepth)).toBe(passDepth)
      }
    } finally {
      withCap(undefined)
    }
  })

  test("DEEPER spawner ⇒ deeper daemon ⇒ still BOUNDED (the pass stays a leaf, its children denied)", () => {
    withCap(9)
    try {
      // A depth-5 spawner threads through to a depth-5 daemon; its pass is depth 6
      // and pinned; the pass's children (depth 7) exceed the pin ⇒ denied. Deeper
      // lineage scales the ceiling but never UN-bounds it under a widened policy.
      const daemon = assemble({ [WORKER_PARENT_DEPTH_ENV]: "5" })
      expect(daemon.depth).toBe(5)
      const pass = passConfigOf(daemon)
      expect(spawnToolsAvailable(pass)).toBe(false)
      expect(childDepthOf(pass)).toBeGreaterThan(effectiveCap(daemon.subagent?.maxDepth))
    } finally {
      withCap(undefined)
    }
  })

  test("the single investigating pass is STILL ADMITTED under the default cap (no regression)", () => {
    withCap(undefined) // default operator policy cap = 1
    try {
      const daemon = assemble()
      // childDepthOf(daemon) must be <= effectiveCap so the runner admits the ONE
      // legitimate investigating pass (a stricter daemon depth would DENY it and
      // break the whole feature). This is the guard against over-tightening.
      const passDepth = childDepthOf(daemon)
      expect(passDepth).toBeLessThanOrEqual(effectiveCap(daemon.subagent?.maxDepth))
    } finally {
      withCap(undefined)
    }
  })
})

describe("resolveDaemonDepth — fail-closed lineage resolution", () => {
  test("no threaded parent depth (absent / empty env) ⇒ fail-closed floor", () => {
    expect(resolveDaemonDepth({})).toBe(MIN_DAEMON_DEPTH)
    expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: "" })).toBe(MIN_DAEMON_DEPTH)
    expect(resolveDaemonDepth({})).toBeGreaterThanOrEqual(0)
  })

  test("a threaded spawning-agent depth DEEPENS the daemon lineage (never shallower)", () => {
    // A deeper spawner ⇒ a proportionally deeper daemon (so its pass sits deeper).
    expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: "2" })).toBe(2)
    expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: "5" })).toBe(5)
  })

  test("FAIL-CLOSED TABLE: every non-parseable / negative / non-finite value floors to MIN_DAEMON_DEPTH", () => {
    // These are the forms that CANNOT yield a valid non-negative integer, so the
    // resolver MUST fall to the floor (never NaN, never negative, never undefined).
    // RED under the mutation `derived = parent` (drop the `Number.isInteger && >=0`
    // guard) — "-1"/"-4" would then return a NEGATIVE depth (widening the budget),
    // and "abc"/"NaN"/"" would return NaN (which fails every downstream cap check).
    const floored = ["", "abc", "not-a-number", "NaN", "-1", "-4", "-0.5", "0x10", "  ", "+"]
    for (const v of floored) {
      expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: v })).toBe(MIN_DAEMON_DEPTH)
    }
    // Absent key is the same fail-closed floor as an unparseable value.
    expect(resolveDaemonDepth({})).toBe(MIN_DAEMON_DEPTH)
  })

  test("CONTAINMENT INVARIANT: NO env value (malformed OR lenient) can ever grant a depth below the floor", () => {
    // The load-bearing security property regardless of parse leniency: the result
    // is ALWAYS a non-negative integer >= the floor. A forged value can only
    // DEEPEN the lineage (tighter budget), never widen it below MIN_DAEMON_DEPTH.
    // RED under the mutation `Math.max` → `Math.min` (or dropping the `>= 0` clamp):
    // a "-4" would then leak a negative/sub-floor depth.
    const adversarial = ["-4", "-1", "abc", "NaN", "", "2.5", "3abc", "1e3", "  7 ", "999999999"]
    for (const v of adversarial) {
      const d = resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: v })
      expect(Number.isInteger(d)).toBe(true)
      expect(d).toBeGreaterThanOrEqual(MIN_DAEMON_DEPTH)
    }
  })

  test("LENIENT-PARSE cases resolve to their truncated integer (still bounded, never sub-floor)", () => {
    // parseInt truncation is the SHIPPED behavior — encode it honestly rather than
    // pretend these floor. What matters for containment: each lands on a valid
    // non-negative integer. RED if the parse base/radix changes (e.g. "0x10"→16)
    // or the leading-int extraction is replaced by a strict Number() (NaN → floor,
    // changing "3abc" from 3 to 0 — a behavior change this pins).
    expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: "2.5" })).toBe(2) // truncates
    expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: "3abc" })).toBe(3) // leading int
    expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: "1e3" })).toBe(1) // base-10, not 1000
    expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: "0x10" })).toBe(MIN_DAEMON_DEPTH) // base-10 "0x…" → 0
    expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: "  7 " })).toBe(7) // whitespace-tolerant
  })

  test("a deeper daemon's pinned cap tracks its deeper pass (containment scales)", () => {
    // Threaded parent depth 3 ⇒ daemon depth 3 ⇒ pass depth 4 ⇒ pinned cap 4.
    const daemon = assemble({ [WORKER_PARENT_DEPTH_ENV]: "3" })
    expect(daemon.depth).toBe(3)
    expect(daemon.subagent?.maxDepth).toBe(4)
    expect(childDepthOf(daemon)).toBe(4)
  })
})

// ── FORK-BOUNDARY LINEAGE THREADING (this ticket) ─────────────────────────────
// The prior commit made `resolveDaemonDepth` READ `WORKER_PARENT_DEPTH_ENV`, but
// NOTHING on the spawning/fork side SET it — so the worker always floored. These
// tests fork a worker (over a spec-capturing fake fork) with a KNOWN spawning
// depth N and assert the forked worker's env carries N, so `resolveDaemonDepth`
// (which the real worker calls on `process.env`) resolves to N — not the floor.

/** A fake fork port that RECORDS the exact `ProcessForkSpec` each fork saw, so we
 *  can assert the env the real worker would inherit (`{...process.env,...spec.env}`
 *  in the real `nodeProcessForkPort`). */
const mkSpecCapturingFork = (): { port: ProcessForkPort; specs: ProcessForkSpec[] } => {
  const specs: ProcessForkSpec[] = []
  const mkChild = (pid: number): ChildProcessHandle => ({
    pid,
    send: () => undefined,
    onMessage: () => () => undefined,
    onExit: () => () => undefined,
    kill: () => undefined,
  })
  return {
    specs,
    port: {
      fork(spec: ProcessForkSpec): ChildProcessHandle {
        specs.push(spec)
        return mkChild(3000 + specs.length)
      },
    },
  }
}

const noopScheduler: DelayScheduler = { schedule: () => 0, cancel: () => undefined }

const forkSpec = (over: Partial<SideAgentSpec> = {}): SideAgentSpec => ({
  task: "monitor the build",
  trigger: { kind: "interval", everyMs: 1000 },
  maxWakes: 5,
  maxTurnsPerWake: 2,
  ...over,
})

/** Spawn ONE daemon over the capturing fork at spawning depth `parentDepth` and
 *  return the env the forked worker inherited (merged like the real port does). */
const forkedWorkerEnv = (parentDepth: number | undefined): Record<string, string | undefined> => {
  const fk = mkSpecCapturingFork()
  const reg = createProcessSideAgentDaemonRegistry({
    fork: fk.port,
    scheduler: noopScheduler,
    now: () => 1,
    workerModulePath: "/abs/worker-entry.mjs",
    ...(parentDepth !== undefined ? { parentDepth } : {}),
  })
  reg.spawn(forkSpec())
  const spec = fk.specs[0]
  expect(spec).toBeDefined()
  // The real `nodeProcessForkPort` forks with `{ ...process.env, ...spec.env }`.
  return { ...(spec?.env ?? {}) }
}

describe("process registry — threads the spawning-agent depth across the fork boundary", () => {
  test("DRIFT GUARD: the registry's mirrored env key === the worker's SSOT const", () => {
    // The leaf registry mirrors the key (cannot value-import the child composition
    // root without dragging @/agent/@/llm into the pure leaf). Pin them lock-step:
    // if either drifts, threading silently no-ops (the worker reads a different key).
    expect(WORKER_PARENT_DEPTH_ENV_KEY).toBe(WORKER_PARENT_DEPTH_ENV)
  })

  test("a spawning depth N flows to the forked worker env ⇒ resolveDaemonDepth === N", () => {
    // RED pre-fix: the registry never set WORKER_PARENT_DEPTH_ENV, so the env is
    // absent and resolveDaemonDepth floors to MIN_DAEMON_DEPTH regardless of N.
    for (const n of [1, 2, 5]) {
      const env = forkedWorkerEnv(n)
      expect(env[WORKER_PARENT_DEPTH_ENV]).toBe(String(n))
      // The worker calls resolveDaemonDepth(process.env); prove the threaded value
      // drives the daemon depth to the REAL lineage, not the always-floor.
      expect(resolveDaemonDepth(env as EnvLike)).toBe(n)
    }
  })

  test("a DEEPER spawner ⇒ a proportionally deeper worker daemon (never shallower)", () => {
    const shallow = resolveDaemonDepth(forkedWorkerEnv(1) as EnvLike)
    const deep = resolveDaemonDepth(forkedWorkerEnv(4) as EnvLike)
    expect(deep).toBeGreaterThan(shallow)
    expect(deep).toBe(4)
  })

  test("FAIL-CLOSED: no spawning depth threaded ⇒ worker falls back to the floor", () => {
    // Unavailable lineage must NOT fabricate a shallow depth — it keeps the floor.
    const env = forkedWorkerEnv(undefined)
    expect(env[WORKER_PARENT_DEPTH_ENV]).toBeUndefined()
    expect(resolveDaemonDepth(env as EnvLike)).toBe(MIN_DAEMON_DEPTH)
  })

  test("PAIRED CONTROL: a threaded depth-0 root is still the floor, but is SET explicitly", () => {
    // A genuine root spawner (depth 0) threads "0" (distinct from absent): the
    // value is present and resolves to 0 — proving the seam carries even the root.
    const env = forkedWorkerEnv(0)
    expect(env[WORKER_PARENT_DEPTH_ENV]).toBe("0")
    expect(resolveDaemonDepth(env as EnvLike)).toBe(0)
  })
})
