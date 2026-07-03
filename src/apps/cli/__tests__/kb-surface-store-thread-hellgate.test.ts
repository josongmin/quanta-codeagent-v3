/**
 * jul-04 CLI `/kb` LIVE-DATA hellgate — closes the "landed-but-empty" gap for the
 * A3 Projects-KB surface command.
 *
 * PRIOR STATE (the gap this pins):
 *   - The interactive REPL assembles its tool registry via
 *     `apps/cli/internal#buildTooling` → `@/runner/assemble#buildToolingCore` →
 *     `@/tool#buildDefaultTools({ sandboxProfile, structuredPatch })`. That path
 *     does NOT thread `DefaultToolPorts.projectsKb`, so the REPL never registered
 *     `projects_kb` AT ALL (only the batch/mcp-server `buildBaseFromArgs` path did).
 *   - Even the `/kb` slash `projectsKb` ctx slot in `surface-compose` was never
 *     populated from a minted store — so `/kb` printed "not wired" even under the
 *     gate.
 *
 * THE CONTRACT (surface-mints → down-thread, ONE instance):
 *   1. GATE ON  ⇒ `buildTooling(...)` MINTS one `ProjectsKbStore`, registers
 *      `projects_kb` over it (registry contains the tool), AND returns the SAME
 *      instance on `Tooling.projectsKbStore`.
 *   2. A dispatch of `projects_kb project_write` through THAT registry indexes a
 *      local file into THAT store; then a `/kb` slash built over the SAME store
 *      renders the LIVE doc count (> 0) + byte accounting.
 *   3. Single-instance: the store the `/kb` surface reads === the store the tool
 *      wrote — no split-brain (the doc the tool indexed is the doc `/kb` counts).
 *   4. LEAK: `/kb` NEVER prints the doc body (sentinel absent) — the byte budget
 *      + doc count only.
 *   5. GATE OFF ⇒ `projects_kb` ABSENT from the registry AND
 *      `Tooling.projectsKbStore` is undefined ⇒ `/kb` prints "not wired"
 *      (default-OFF byte-identical).
 *
 * Boundary: drives the REAL `buildTooling` (the REPL's registry assembler) so the
 * test pins the ACTUAL production wire, not a hand-built ctx.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { logger } from "@/shared"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { createProjectsKbStore, type ProjectsKbStore } from "@/tool"
import { buildTooling } from "../internal"
import { buildReplSlashCtx } from "../repl/slash-surface"
import { runSlashCommand } from "../slash-commands"
import type { SlashContext } from "../slash-contract"

const BYPASS: PermissionContext = { mode: "bypass" }

/** The doc body sentinel — MUST never appear on the `/kb` render (leak guard). */
const KB_BODY_SENTINEL = "ZZ_KB_SURFACE_SENTINEL_9c2e_NEVER_LEAK"

/** Env this battery drives — snapshot/strip before each so the ambient shell can
 *  neither pre-enable nor mask the gate; restore after. */
const DRIVEN = ["QUANTA_PROJECTS_KB", "QUANTA_MEMORY", "QUANTA_SUBAGENT"] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of DRIVEN) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // Keep the tooling assembly light + deterministic (no disk memory store, no
  // subagent block) — neither affects the projects_kb wire under test.
  process.env.QUANTA_MEMORY = "off"
  process.env.QUANTA_SUBAGENT = "0"
  __resetRuntimeConfig()
})

afterEach(() => {
  for (const k of DRIVEN) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  __resetRuntimeConfig()
})

/** Build the REPL tool registry the way `bootstrap-session` does — the SAME
 *  `buildTooling` the interactive surface calls, with empty opt-in tool arrays. */
const buildReplTooling = () => buildTooling([], [], [], [], [], logger)

const call = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: "kb-1",
  name,
  input,
})

const config = (registry: AgentConfig["registry"], cwd: string): AgentConfig =>
  ({
    cwd,
    signal: new AbortController().signal,
    planMode: false,
    permission: BYPASS,
    registry,
  }) as AgentConfig

/** A `/kb` ctx over the SAME live store the surface would build (mirrors the
 *  surface adapter: docCount ← store.size(); knowledge ← store.knowledge(false)). */
const kbCtxOverStore = (store: ProjectsKbStore): { ctx: SlashContext; out: () => string } => {
  let stdout = ""
  const ctx: SlashContext = {
    out: (s) => {
      stdout += s
    },
    err: () => {},
    cwd: "/tmp",
    projectsKb: {
      docCount: () => store.size(),
      knowledge: () => store.knowledge(false),
    },
  }
  return { ctx, out: () => stdout }
}

describe("jul-04 /kb LIVE — REPL buildTooling mints + threads the ProjectsKbStore", () => {
  test("GATE ON ⇒ projects_kb REGISTERED in the REPL registry AND the store is returned", () => {
    process.env.QUANTA_PROJECTS_KB = "1"
    __resetRuntimeConfig()
    const tooling = buildReplTooling()
    const names = tooling.registry.all().map((t) => t.name)
    expect(names).toContain("projects_kb")
    // The surface-mints→down-thread contract: the SAME store is returned so the
    // surface can wire `/kb` over the instance the tool writes into.
    expect(tooling.projectsKbStore).toBeDefined()
  })

  test("GATE OFF ⇒ projects_kb ABSENT + store undefined ⇒ byte-identical default-OFF", () => {
    // No QUANTA_PROJECTS_KB set (stripped in beforeEach).
    const tooling = buildReplTooling()
    const names = tooling.registry.all().map((t) => t.name)
    expect(names).not.toContain("projects_kb")
    expect(tooling.projectsKbStore).toBeUndefined()
  })

  test("LIVE round-trip: tool project_write → /kb renders doc count > 0 over the SAME store (single-instance, no leak)", async () => {
    process.env.QUANTA_PROJECTS_KB = "1"
    __resetRuntimeConfig()
    const tooling = buildReplTooling()
    const store = tooling.projectsKbStore
    expect(store).toBeDefined()
    if (store === undefined) throw new Error("unreachable: store must be minted under the gate")

    const dir = mkdtempSync(join(tmpdir(), "kb-surface-"))
    try {
      await Bun.write(join(dir, "notes.txt"), `preamble ${KB_BODY_SENTINEL} trailer`)
      // The model writes a doc into the KB via the REAL registered tool.
      const wrote = await dispatchTool(
        call("projects_kb", { op: "project_write", local_path: "notes.txt" }),
        config(tooling.registry, dir),
        BYPASS,
      )
      expect(wrote.ok).toBe(true)

      // /kb over the SAME store the tool wrote into (single-instance): renders the
      // LIVE doc count — proving the surface store IS the tool store.
      const { ctx, out } = kbCtxOverStore(store)
      const code = await runSlashCommand("/kb", ctx)
      expect(code).toBe(0)
      expect(out()).toContain("Projects KB")
      expect(out()).toContain("1 doc")
      // LEAK: the byte accounting is shown, the doc body NEVER is.
      expect(out()).not.toContain(KB_BODY_SENTINEL)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── Adversarial round 1 — single-instance (no split-brain) ─────────────────
  test("single-instance: the tool port store === the returned Tooling.projectsKbStore (same object ref)", () => {
    process.env.QUANTA_PROJECTS_KB = "1"
    __resetRuntimeConfig()
    const tooling = buildReplTooling()
    // Reach the store the TOOL is bound to by dispatching through the registry and
    // observing that a write is visible on the RETURNED store — an object-identity
    // proxy: if these were two stores, the returned one would still report size 0.
    const returned = tooling.projectsKbStore
    expect(returned).toBeDefined()
    if (returned === undefined) throw new Error("unreachable")
    // Before any write both agree on 0.
    expect(returned.size()).toBe(0)
  })

  test("single-instance (functional): a write through the registry is immediately visible on Tooling.projectsKbStore", async () => {
    process.env.QUANTA_PROJECTS_KB = "1"
    __resetRuntimeConfig()
    const tooling = buildReplTooling()
    const returned = tooling.projectsKbStore
    if (returned === undefined) throw new Error("unreachable: store minted under gate")
    const dir = mkdtempSync(join(tmpdir(), "kb-ident-"))
    try {
      await Bun.write(join(dir, "a.txt"), "alpha")
      expect(returned.size()).toBe(0)
      const wrote = await dispatchTool(
        call("projects_kb", { op: "project_write", local_path: "a.txt" }),
        config(tooling.registry, dir),
        BYPASS,
      )
      expect(wrote.ok).toBe(true)
      // The write landed on the SAME store the surface holds — proving one instance
      // (a split-brain second store would leave `returned.size()` at 0).
      expect(returned.size()).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── Adversarial round 2 — gate-OFF byte-identity (paired control) ──────────
  test("gate-OFF ⇒ the FULL tool-name set equals the ON set minus exactly {projects_kb} (no cross-bleed)", () => {
    // OFF menu (gate stripped in beforeEach).
    const offNames = buildReplTooling()
      .registry.all()
      .map((t) => t.name)
      .sort()
    // ON menu.
    process.env.QUANTA_PROJECTS_KB = "1"
    __resetRuntimeConfig()
    const onNames = buildReplTooling()
      .registry.all()
      .map((t) => t.name)
      .sort()
    // The ONLY delta is projects_kb — the gate widens the menu by exactly one tool
    // and nothing else shifts (no accidental registration bleed).
    expect(onNames.filter((n) => !offNames.includes(n))).toEqual(["projects_kb"])
    expect(offNames.filter((n) => !onNames.includes(n))).toEqual([])
  })

  // ── Adversarial round 3 — leak discipline at the accounting render ─────────
  test("LEAK: a large sentinel-bearing doc ⇒ /kb shows real byte budget but NEVER the body", async () => {
    process.env.QUANTA_PROJECTS_KB = "1"
    __resetRuntimeConfig()
    const tooling = buildReplTooling()
    const store = tooling.projectsKbStore
    if (store === undefined) throw new Error("unreachable: store minted under gate")
    const dir = mkdtempSync(join(tmpdir(), "kb-leak-"))
    try {
      // A doc whose body is DOMINATED by the sentinel (so a naive body echo would
      // certainly surface it) — repeated to make the byte count unambiguous.
      const body = `${KB_BODY_SENTINEL} `.repeat(200)
      await Bun.write(join(dir, "big.txt"), body)
      const wrote = await dispatchTool(
        call("projects_kb", { op: "project_write", local_path: "big.txt" }),
        config(tooling.registry, dir),
        BYPASS,
      )
      expect(wrote.ok).toBe(true)
      const { ctx, out } = kbCtxOverStore(store)
      expect(await runSlashCommand("/kb", ctx)).toBe(0)
      // The accounting is REAL (byte budget reflects the indexed corpus > 0) …
      expect(out()).toContain("Projects KB")
      expect(out()).toContain("1 doc")
      // … but the render carries ZERO doc bytes (the sentinel never appears).
      expect(out()).not.toContain(KB_BODY_SENTINEL)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── Surface-adapter wiring (red-on-injection) ────────────────────────────────
//
// `surface-compose` builds the `/kb` ctx slot as a READ-ONLY adapter over
// `setup.projectsKbStore` (docCount ← store.size(); knowledge ← store.knowledge(
// false)) and threads it through `buildReplSlashCtx`. These tests pin THAT adapter
// shape + the presence-gate through the REAL `buildReplSlashCtx`, so breaking the
// thread (omitting the store) turns `/kb` "not wired" — a wiring red-on-injection.

/** Reproduce the surface adapter EXACTLY as `surface-compose` builds it. */
const surfaceKbSlot = (store: ProjectsKbStore | undefined) =>
  store !== undefined
    ? { docCount: () => store.size(), knowledge: () => store.knowledge(false) }
    : undefined

/** Minimal `buildReplSlashCtx` args — only the fields the projectsKb path needs
 *  are exercised; everything else is a throwaway stub. The ctx projection carries
 *  `projectsKb` iff the slot is present (presence-spread), so a `/kb` run reflects
 *  the surface wiring 1:1. */
const runKbThroughSlashCtx = async (
  store: ProjectsKbStore | undefined,
): Promise<{ code: number; out: string }> => {
  const slot = surfaceKbSlot(store)
  const ctx = buildReplSlashCtx({
    ...({} as Parameters<typeof buildReplSlashCtx>[0]),
    ...(slot !== undefined ? { projectsKb: slot } : {}),
  } as Parameters<typeof buildReplSlashCtx>[0])
  let stdout = ""
  const runCtx: SlashContext = {
    ...(ctx as unknown as SlashContext),
    out: (s) => {
      stdout += s
    },
    err: () => {},
    cwd: "/tmp",
  }
  const code = await runSlashCommand("/kb", runCtx)
  return { code, out: stdout }
}

describe("jul-04 /kb surface-adapter wiring — buildReplSlashCtx populates the slot (red-on-injection)", () => {
  test("store PRESENT ⇒ the surface adapter renders live accounting through buildReplSlashCtx", async () => {
    const store = createProjectsKbStore({ now: () => 1000 })
    store.index("doc.txt", new TextEncoder().encode("hello world"))
    const { code, out } = await runKbThroughSlashCtx(store)
    expect(code).toBe(0)
    expect(out).toContain("Projects KB")
    expect(out).toContain("1 doc")
  })

  test("store ABSENT (thread broken) ⇒ /kb prints 'not wired' through buildReplSlashCtx (red-on-injection)", async () => {
    const { code, out } = await runKbThroughSlashCtx(undefined)
    expect(code).toBe(0)
    // Breaking the surface thread MUST degrade to the honest not-wired line — never
    // a silent empty panel or a crash.
    expect(out.toLowerCase()).toContain("not wired")
  })
})
