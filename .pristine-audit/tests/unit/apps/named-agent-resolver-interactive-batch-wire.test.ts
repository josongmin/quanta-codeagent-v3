/**
 * F2 (round-2) — named-agent resolver is wired on the PRIMARY surfaces, not
 * only headless `apps/agent`.
 *
 * The headless `apps/agent` surface threads `loadNamedAgents(cwd)` onto its
 * `AssembleRequestPartial.namedAgentResolver`; `buildBaseFromArgs` lifts it onto
 * `AgentConfig.namedAgentResolver`, which the SubagentRunner consults per spawn.
 * Round-2 found this was ABSENT on the interactive CLI/REPL and `quanta batch`,
 * so a `.quanta/agents/foo.md` + a model `agent_type:"foo"` silently no-op'd on
 * the primary surface. These tests pin the two newly-wired legs:
 *
 *   A (interactive REPL + web-daemon host leg): the shared interactive
 *      turn-assembler PRESERVES `namedAgentResolver` from its per-turn base onto
 *      the assembled `AgentConfig`. The CLI surface sets it via the runtime
 *      overlay (`composeCliRuntimeContext` → `loadNamedAgents(boot.cwd)`), which
 *      `buildBootstrapBaseShape` lifts onto the base — so once it is on the base
 *      the per-turn assembly must carry it. Absent ⇒ slot omitted (default-OFF).
 *
 *   B (batch leg): `buildBaseFromArgs` lifts a partial's `namedAgentResolver`
 *      onto the base — the exact mechanism the `quanta batch` path now drives by
 *      setting `partial.namedAgentResolver = await loadNamedAgents(cwd)` before
 *      assembling the row-dispatch parent.
 *
 *   C (surface-wiring): both primary surfaces actually CALL `loadNamedAgents`
 *      and thread the result (source assertion — the silent no-op was a MISSING
 *      call site, so its presence is the regression guard).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { NamedAgentResolver } from "@/agent"
import { assembleAgentConfig, buildInteractiveTurnAssembler } from "@/host/runtime"
import { buildBaseFromArgs } from "@/host/runtime/agent-arg-builder"
import { defaultTools, ToolRegistry } from "@/tool"

// A trivial structural resolver — the runner depends only on the port shape.
const fakeResolver: NamedAgentResolver = { resolve: () => undefined }

// Minimal per-turn base the interactive turn-assembler accepts (mirrors the
// interactive-turn-assembler integration fixture, plus the resolver under test).
const baseTurnDeps = (extra: Record<string, unknown>) =>
  ({
    llm: { model: "test", async *stream() {} },
    registry: new ToolRegistry(defaultTools),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [],
    system: "test",
    cwd: process.cwd(),
    maxTurns: 4,
    signal: new AbortController().signal,
    ...extra,
  }) as unknown as Parameters<ReturnType<typeof buildInteractiveTurnAssembler>>[1]

describe("F2 — interactive turn-assembler carries namedAgentResolver from base", () => {
  test("present on the per-turn base ⇒ carried onto the assembled AgentConfig", () => {
    const assemble = buildInteractiveTurnAssembler({}, {})
    const cfg = assemble([], baseTurnDeps({ namedAgentResolver: fakeResolver }))
    expect((cfg as { namedAgentResolver?: NamedAgentResolver }).namedAgentResolver).toBe(
      fakeResolver,
    )
  })

  test("absent on the base ⇒ slot OMITTED on the AgentConfig (byte-identical default-OFF)", () => {
    const assemble = buildInteractiveTurnAssembler({}, {})
    const cfg = assemble([], baseTurnDeps({}))
    expect(Object.hasOwn(cfg, "namedAgentResolver")).toBe(false)
  })

  test("assembleAgentConfig spreads namedAgentResolver from req.base directly", () => {
    const cfg = assembleAgentConfig(
      {
        mode: "interactive",
        base: baseTurnDeps({ namedAgentResolver: fakeResolver }) as never,
      } as never,
      {},
    )
    expect((cfg as { namedAgentResolver?: NamedAgentResolver }).namedAgentResolver).toBe(
      fakeResolver,
    )
  })
})

describe("F2 — batch leg: buildBaseFromArgs lifts a partial resolver (the path quanta batch drives)", () => {
  test("partial.namedAgentResolver ⇒ base.namedAgentResolver", () => {
    const base = buildBaseFromArgs({
      mode: "headless",
      dials: undefined,
      namedAgentResolver: fakeResolver,
    } as Parameters<typeof buildBaseFromArgs>[0])
    expect((base as { namedAgentResolver?: NamedAgentResolver }).namedAgentResolver).toBe(
      fakeResolver,
    )
  })

  test("no partial resolver ⇒ base slot OMITTED (no .quanta/agents ⇒ byte-identical)", () => {
    const base = buildBaseFromArgs({ mode: "headless", dials: undefined })
    expect(Object.hasOwn(base, "namedAgentResolver")).toBe(false)
  })
})

describe("F2 — both primary surfaces wire loadNamedAgents (source assertion)", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..")

  test("quanta batch path loads + threads loadNamedAgents onto the assemble partial", () => {
    const src = readFileSync(join(repoRoot, "src/apps/cli/index.ts"), "utf8")
    expect(src).toContain("loadNamedAgents")
    // The resolver is set on the partial that feeds buildBaseFromArgs.
    expect(src).toMatch(/batchPartial\.namedAgentResolver\s*=/)
  })

  test("interactive CLI/REPL loads loadNamedAgents(boot.cwd) and overlays the resolver", () => {
    const src = readFileSync(join(repoRoot, "src/apps/cli/repl/runtime-context-compose.ts"), "utf8")
    // Uses the SESSION-resolved jailed cwd, not raw process.cwd().
    expect(src).toContain("loadNamedAgents(boot.cwd)")
    expect(src).toContain("namedAgentResolver")
  })

  test("host overlay → base lift exists (RuntimeBootstrapOverlay.namedAgentResolver)", () => {
    const src = readFileSync(
      join(repoRoot, "src/host/runtime/internal/context-binding/base.ts"),
      "utf8",
    )
    expect(src).toMatch(
      /whenDefined\("namedAgentResolver",\s*args\.overlay\?\.namedAgentResolver\)/,
    )
  })
})
