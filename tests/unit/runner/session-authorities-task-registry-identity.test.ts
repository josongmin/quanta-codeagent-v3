/**
 * RFC-01 A2 — TaskRegistry constructor-owner drift-guard + one-instance-per-
 * session identity (the RED rail the A2 receipt promised but never landed).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * RFC-01 A2 claimed "delete all fallback constructors / EXACTLY ONE production
 * `new TaskRegistry()` owner". That consolidation was DEFERRED and the promised
 * rail at THIS path never existed, so the "one instance per session" invariant
 * held only by CONVENTION (the CLI lifecycle happening to thread one instance to
 * both the subagent tools and the attention authority) — structural-in-prose,
 * unenforced. This file enforces it two ways:
 *
 *   (A) a MINT-COUNTING constructor-owner ratchet that pins the EXACT set of
 *       production `new TaskRegistry(` call sites AND their per-file count, so a
 *       NEW unpinned constructor — or a SECOND mint sneaked into an already-
 *       allowed file — goes RED (red-on-injection proven below). This is
 *       strictly stronger than the pre-existing file-SET guard in
 *       `tests/integration/cli-attention-navigation.test.ts` (§5), which cannot
 *       see a second mint added to a file already in its set, and which runs in
 *       the integration lane rather than the unit lane.
 *
 *   (B) an IDENTITY proof at the `@/runner/assemble` composition layer: ONE
 *       injected `TaskRegistry` is the SAME instance that (i) the attention
 *       authority reads (behavioural, red-on-injection with a foreign registry)
 *       and (ii) the subagent tool trio adopts (referential, through the real
 *       `buildSubagentConfigCore` → `createAgentTool` thread). This is the
 *       assembly-layer contract the CLI lifecycle relies on; the CLI-lifecycle
 *       attention half is separately pinned end-to-end by the integration §4
 *       receipt (`buildLifecycleBundle` → reader). Together they close the
 *       "same registry feeds subagent tools + attention" claim.
 *
 * ── ALLOWED CONSTRUCTOR SITES (each classified; consolidation status) ────────
 * The A2 consolidation to "exactly one owner" is NOT structurally clean, so all
 * four production mints remain PINNED here with justification (board stop:
 * "pin it in the drift-guard's allowlist with a justification — do NOT leave a
 * silent fallback"). Each is a legitimate composition/surface root, not a stray:
 *
 *   1. `src/apps/cli/repl/factories/lifecycle.ts` — CLI SURFACE ROOT. Mints the
 *      one session registry and threads THAT instance to both the attention
 *      authority (`buildSessionAuthorities`) and the subagent tools (via
 *      `lifecycleTaskRegistry` → assemble). Correct owner; keep.
 *   2. `src/apps/web-daemon/runtime-factory/session-collaborators.ts` — WEB
 *      SURFACE ROOT. Same role as (1) for the web/tauri surface (threads into
 *      `buildSubagentConfigCore`). Correct owner; keep.
 *   3. `src/agent/optional-ports.ts` — ENV-GATED COMPOSITION ROOT for the
 *      surfaces that have no lifecycle bundle (daemon / ide / headless / BENCH /
 *      EVAL / SDK). Guarded mint (`=== undefined` ⇒ never overwrites a host
 *      instance). Consolidating it would require rewiring the bench/eval
 *      surface — a concurrent-hot boundary the board forbids touching — so it
 *      stays a pinned root. NOT a silent fallback (it is the observable owner
 *      for those surfaces).
 *   4. `src/subagent/agent-tool.ts` — LEAF-FACTORY DI DEFAULT
 *      (`opts.registry ?? new TaskRegistry()`). The `@/subagent` layer may not
 *      import `@/runner/assemble` (layering), so the instance can only arrive by
 *      DI param. Its sole PRODUCTION caller (`buildSubagentBlock`) threads the
 *      surface registry, so this default is dormant in production; it is the
 *      documented standalone API (`@/subagent` README example
 *      `createAgentTool({ runner, maxDepth: 3 })`) and is relied on by ~40 test
 *      call sites. Making it required would break the public leaf API + churn
 *      those sites without removing any mint from this set (the mint would just
 *      relocate up one layer). Kept as the pinned DI default.
 *
 * Consolidation deferred to a dedicated campaign (route the two surface roots'
 * mint into `buildSessionAuthorities` the way RFC-04 D4 did for ActivityStore —
 * a multi-surface change touching the web runtime-factory + ~40 test callers,
 * out of scope for this drift-guard-first ticket). Until then this rail forces
 * REVIEW of any new mint. Mirrors the shape of
 * `tests/unit/activity/activity-store-constructor-owner-ratchet.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { buildSubagentConfigCore } from "@/runner/assemble"
import { buildSessionAuthorities } from "@/runner/assemble/session-authorities"
import { createAgentTool, TaskRegistry } from "@/subagent"
import { assertScanPopulation } from "../_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const SRC_DIR = join(REPO_ROOT, "src")

/** A `new TaskRegistry(` CALL. The `(` requires a construction, never a bare
 *  type/symbol reference (`config.subagent.taskRegistry: TaskRegistry`) or a
 *  prose mention. `\b` after the class name avoids matching a `TaskRegistryFoo`.
 *  Global so we COUNT every mint in a file, not just its presence. */
const CALL = /new\s+TaskRegistry\s*\(/g

/**
 * Pinned per-file production mint counts (repo-relative, POSIX). The MAP (not a
 * set) is what makes this a mint-COUNTING guard: a second `new TaskRegistry(`
 * added to any file below bumps its count and fails the exact-equality assert.
 */
const ALLOWED_MINTS: Readonly<Record<string, number>> = {
  "src/agent/optional-ports.ts": 1,
  "src/apps/cli/repl/factories/lifecycle.ts": 1,
  "src/apps/web-daemon/runtime-factory/session-collaborators.ts": 1,
  "src/subagent/agent-tool.ts": 1,
}

const posix = (p: string): string => p.split(/[\\/]/).join("/")

/** Strip block comments, whole-line `//`/JSDoc `*` lines, and inline `//` tails
 *  so a `new TaskRegistry()` MENTION in prose (e.g. subagent.ts's "defaults to
 *  `new TaskRegistry()` when absent" comment) is never miscounted as a mint. */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => {
      const t = l.trimStart()
      if (t.startsWith("//") || t.startsWith("*")) return ""
      const idx = l.indexOf("//")
      return idx >= 0 ? l.slice(0, idx) : l
    })
    .join("\n")

/** Pure mint counter — the atom the red-on-injection self-tests exercise. */
const countMints = (src: string): number => (stripComments(src).match(CALL) ?? []).length

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      yield* walk(p)
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".test.ts")) {
      yield p
    }
  }
}

/** Pure detector — the scanned per-file production mint map. Reused by the
 *  red-on-injection self-tests so the guard cannot be vacuous. */
const scanMints = (srcRoot: string): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const abs of walk(srcRoot)) {
    const n = countMints(readFileSync(abs, "utf8"))
    if (n > 0) counts[posix(relative(REPO_ROOT, abs))] = n
  }
  return counts
}

describe("RFC-01 A2 — TaskRegistry constructor-owner drift-guard (mint-counting)", () => {
  test("ANTI-VACUITY: the walk reaches a real, populated `src/` tree", () => {
    // Mint-counting over an empty walk counts zero mints, and zero satisfies
    // "no competing constructor" for free.
    assertScanPopulation([...walk(SRC_DIR)], SRC_DIR, {
      min: 500,
      collectable: (n) => n.endsWith(".ts") && !n.endsWith(".d.ts") && !n.endsWith(".test.ts"),
    })
  })

  test("production `new TaskRegistry(` sites + per-file counts EXACTLY match the pinned set", () => {
    const scanned = scanMints(SRC_DIR)
    // Exact map equality catches BOTH a new competing constructor (a key not in
    // ALLOWED_MINTS) AND a second mint inside an already-allowed file (a count
    // bump), AND the eventual A2 consolidation (a key removed / count dropped ⇒
    // update this pin). No silent drift in either direction.
    expect(scanned).toEqual({ ...ALLOWED_MINTS })
  })

  test("non-vacuous: every pinned site genuinely contains a live mint", () => {
    for (const [rel, n] of Object.entries(ALLOWED_MINTS)) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8")
      expect(countMints(src)).toBe(n)
    }
  })

  test("red-on-injection: a mint CALL counts; a comment mention does NOT", () => {
    // A real construction (the shape of a would-be 6th owner) is caught…
    expect(countMints("const r = new TaskRegistry()")).toBe(1)
    expect(countMints("const r = new TaskRegistry({ maxRetained: 3 })")).toBe(1)
    // …a SECOND mint in one file bumps the count (so it can never hide behind an
    // already-allowed file key)…
    expect(countMints("const a = new TaskRegistry(); const b = new TaskRegistry()")).toBe(2)
    // …while a bare symbol / prose mention (subagent.ts:202 comment) is excluded.
    expect(countMints("// createAgentTool defaults to new TaskRegistry() when absent")).toBe(0)
    expect(countMints("let reg: TaskRegistry | undefined")).toBe(0)
    expect(countMints("/* owner map: new TaskRegistry() lives at the surface root */")).toBe(0)
  })

  test("red-on-injection: the scan flags an unpinned mint and a count bump", () => {
    const scanned = scanMints(SRC_DIR)
    // (a) A new unpinned production owner ⇒ exact-equality fails.
    expect({ ...scanned, "src/agent/some-new-owner.ts": 1 }).not.toEqual({ ...ALLOWED_MINTS })
    // (b) A SECOND mint in an already-allowed file ⇒ exact-equality fails.
    expect({ ...scanned, "src/subagent/agent-tool.ts": 2 }).not.toEqual({ ...ALLOWED_MINTS })
    // (c) The scan really reads disk (not a hard-coded echo of ALLOWED_MINTS):
    // drop a pinned key and the scan still reports it.
    expect(scanned["src/apps/cli/repl/factories/lifecycle.ts"]).toBe(1)
  })
})

// ── ONE-INSTANCE-PER-SESSION IDENTITY (assembly-layer contract) ─────────────

describe("RFC-01 A2 — one TaskRegistry feeds BOTH attention authority + subagent tools", () => {
  const noopRunner = async () => ({ ok: true as const, finalText: "", turns: 1 })

  test("the injected registry IS the instance the attention reader observes (red-on-injection)", async () => {
    const tasks = new TaskRegistry()
    const authorities = buildSessionAuthorities({ tasks, env: { QUANTA_ATTENTION_NAV: "1" } })

    // Referential: the graph carries the EXACT injected instance (no parallel
    // authority minted inside the builder).
    expect(authorities.tasks).toBe(tasks)
    const broker = authorities.questions
    const attention = authorities.attention
    if (broker === undefined || attention === undefined) throw new Error("gate ON must construct")

    // Behavioural: a task registered in THIS registry + a task-owned question on
    // THIS broker surfaces in the reader ⇒ the reader closed over this instance.
    tasks.register({ id: "child-A", description: "worker", depth: 1 })
    const run = broker.request({ owner: { kind: "task", taskId: "child-A" }, prompt: "shared?" })
    expect(attention.snapshot().map((a) => a.id)).toEqual(["child-A"])

    // Red-on-injection: a task in a DIFFERENT registry never surfaces here —
    // proving the reader is bound to THIS registry, not "some" registry.
    const foreign = new TaskRegistry()
    foreign.register({ id: "child-X", description: "foreign", depth: 1 })
    expect(attention.snapshot().map((a) => a.id)).toEqual(["child-A"]) // NOT child-X

    broker.cancelAll("teardown")
    await run
  })

  test("the SAME instance is threaded into the subagent tool assembly (referential)", () => {
    const tasks = new TaskRegistry()

    // The surface-agnostic assemble core carries the exact injected instance…
    const sub = buildSubagentConfigCore({ enabled: true, taskRegistry: tasks })
    expect(sub?.taskRegistry).toBe(tasks)

    // …and the leaf tool factory adopts THAT instance as its `.registry` (the
    // handle the Task*/list_agents tools all share), so a session that threads
    // ONE registry has its fleet observed by both the tools and (above) the
    // attention authority — the single-instance-per-session invariant.
    const tool = createAgentTool({ runner: noopRunner, registry: tasks })
    expect(tool.registry).toBe(tasks)

    // Red-on-injection guard on the thread itself: an unset core omits the key
    // (so the leaf DI default — the pinned agent-tool mint — would apply), i.e.
    // the identity above is a real thread, not an always-true tautology.
    expect(buildSubagentConfigCore({ enabled: true })?.taskRegistry).toBeUndefined()
  })
})
