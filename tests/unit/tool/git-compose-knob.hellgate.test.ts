/**
 * Hellgate — `compose-authoring` KNOB + wiring + HARDER pure-parser edges
 * (deterministic, no network, no git spawn).
 *
 * Complements `git-compose.hellgate.test.ts` (which seals the TOOL surface) by
 * sealing:
 *   A. KNOB PARSE — strict equality on the literal "1"; everything else
 *      (typos, "0", "true", "on", whitespace, case, garbage, empty) ⇒ undefined.
 *   B. KNOB APPLY — env-flip folds the baseline cfg.llm into
 *      config.composeAuthoring.authorLLM (cli/agent surfaces); wrong surface
 *      (bench) ⇒ untouched; absent env ⇒ byte-identical (same ref).
 *   C. BUILDER — buildComposeAuthoringBlock returns [] when the slot is absent
 *      and exactly the two compose tools (wired to the slot's authorLLM) when
 *      present.
 *   D. HARDER parse edges for parseConventionalCommit / parsePrAuthored:
 *      multi-scope, breaking-change `!`, footer, body-only / no-blank-line,
 *      uppercase type rejected, header-only.
 *
 * Everything is DETERMINISTIC — structural / parse facts only, NO heuristic
 * scoring of message "quality", NO arbitrary thresholds.
 */

import { describe, expect, test } from "bun:test"
import { buildComposeAuthoringBlock } from "@/agent"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort, StreamEvent } from "@/llm"
import type { PermissionContext } from "@/permission"
import { type AnyKnob, applyKnobs, asAnyKnob, resolveKnobs, type Surface } from "@/runner/knobs"
import { composeAuthoringKnob } from "@/runner/knobs/knobs/compose-authoring"
import type { StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"
import { parseConventionalCommit, parsePrAuthored } from "@/tool/git/compose"

// ─── doubles ────────────────────────────────────────────────────────────────

/** Identity-bearing LLM double so we can assert the EXACT baseline ref is the
 *  one folded into the slot (the knob uses the session's baseline cfg.llm). */
class TaggedLLM implements LLMPort {
  readonly model = "tagged-baseline"
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit() {} } as StreamPort,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    llm: new TaggedLLM() as unknown as LLMPort,
    ...over,
  }) as AgentConfig

/** Resolve the knob via the framework for `surface`, then apply over baseCfg. */
const flip = (env: NodeJS.ProcessEnv, surface: Surface, base = baseCfg()): AgentConfig => {
  // Registry-INDEPENDENT: build the knob map from the imported object, not the
  // global `knobsForSurface(...)`. A sibling test's `__resetRegistry()` can wipe
  // the global registry (the full-suite contamination class), but this test
  // owns its knob map so it is order-independent. `applyKnobs` still enforces
  // `knob.surfaces.includes(surface)`, so the bench-exclusion case holds.
  const knobs: ReadonlyMap<string, AnyKnob> = new Map([
    [composeAuthoringKnob.id, asAnyKnob(composeAuthoringKnob)],
  ])
  const values = resolveKnobs({ surface, knobs, envVars: env })
  return applyKnobs(base, knobs, values, { surface })
}

// ─── A. KNOB PARSE (strict equality on "1") ──────────────────────────────────

describe("compose-authoring knob — parse strictness (NO heuristics)", () => {
  test('exact "1" ⇒ active', () => {
    expect(composeAuthoringKnob.parse("1")).toBe(true)
  })

  for (const raw of [
    "0",
    "2",
    "true",
    "on",
    "yes",
    "enable",
    " 1",
    "1 ",
    "1\n",
    "01",
    "",
    " ",
    "\t",
  ]) {
    test(`non-"1" raw ${JSON.stringify(raw)} ⇒ undefined (falls through)`, () => {
      expect(composeAuthoringKnob.parse(raw)).toBeUndefined()
    })
  }

  test("absent (undefined) ⇒ undefined", () => {
    expect(composeAuthoringKnob.parse(undefined)).toBeUndefined()
  })

  test("knob identity: id / envKey / category / bench excluded", () => {
    expect(composeAuthoringKnob.id).toBe("compose-authoring")
    expect(composeAuthoringKnob.envKey).toBe("QUANTA_COMPOSE_AUTHORING")
    expect(composeAuthoringKnob.category).toBe("tool")
    expect(composeAuthoringKnob.surfaces).not.toContain("bench")
    expect(composeAuthoringKnob.surfaces).toContain("cli")
    expect(composeAuthoringKnob.surfaces).toContain("agent-batch")
    expect(composeAuthoringKnob.surfaces).toContain("agent-interactive")
  })
})

// ─── B. KNOB APPLY (env-flip folds baseline llm) ─────────────────────────────

describe("compose-authoring knob — apply env-flip", () => {
  test("absent env ⇒ config.composeAuthoring untouched (byte-identical: same ref)", () => {
    const base = baseCfg()
    const out = flip({}, "cli", base)
    expect(out).toBe(base)
    expect(out.composeAuthoring).toBeUndefined()
  })

  test('QUANTA_COMPOSE_AUTHORING="0" ⇒ untouched (no flip)', () => {
    const base = baseCfg()
    const out = flip({ QUANTA_COMPOSE_AUTHORING: "0" }, "cli", base)
    expect(out).toBe(base)
    expect(out.composeAuthoring).toBeUndefined()
  })

  test('="1" on cli ⇒ composeAuthoring.authorLLM === the baseline cfg.llm (exact ref)', () => {
    const base = baseCfg()
    const out = flip({ QUANTA_COMPOSE_AUTHORING: "1" }, "cli", base)
    expect(out.composeAuthoring).toBeDefined()
    expect(out.composeAuthoring?.authorLLM).toBe(base.llm)
  })

  for (const surface of ["agent-batch", "agent-interactive"] as const) {
    test(`="1" on ${surface} ⇒ wired`, () => {
      const out = flip({ QUANTA_COMPOSE_AUTHORING: "1" }, surface)
      expect(out.composeAuthoring).toBeDefined()
    })
  }

  test('="1" on bench ⇒ knob not offered ⇒ untouched (measurement isolation)', () => {
    const base = baseCfg()
    const out = flip({ QUANTA_COMPOSE_AUTHORING: "1" }, "bench", base)
    expect(out).toBe(base)
    expect(out.composeAuthoring).toBeUndefined()
  })

  test("apply is PURE — does not mutate the input config", () => {
    const base = baseCfg()
    flip({ QUANTA_COMPOSE_AUTHORING: "1" }, "cli", base)
    expect(base.composeAuthoring).toBeUndefined()
  })
})

// ─── C. BUILDER (default-OFF registry seam) ──────────────────────────────────

describe("buildComposeAuthoringBlock", () => {
  test("slot absent ⇒ [] (byte-identical default-OFF)", () => {
    expect(buildComposeAuthoringBlock(baseCfg())).toEqual([])
  })

  test("slot present ⇒ exactly the two compose tools", () => {
    const llm = new TaggedLLM() as unknown as LLMPort
    const tools = buildComposeAuthoringBlock(baseCfg({ composeAuthoring: { authorLLM: llm } }))
    expect(tools.map((t) => t.name).sort()).toEqual(["git_compose_commit", "git_compose_pr"])
    for (const t of tools) {
      expect(t.isReadOnly()).toBe(true)
      expect(t.hitlTier?.({})).toBe("none")
    }
  })
})

// ─── D. HARDER conventional-commit / PR parse edges ──────────────────────────

describe("parseConventionalCommit — harder edges", () => {
  test("multi-scope (comma inside scope) captured verbatim", () => {
    const p = parseConventionalCommit("feat(api,db): widen the column")
    expect(p.conventional).toBe(true)
    expect(p.type).toBe("feat")
    expect(p.scope).toBe("api,db")
    expect(p.subject).toBe("widen the column")
  })

  test("breaking-change `!` after scope ⇒ conventional, scope clean, `!` not in subject", () => {
    const p = parseConventionalCommit("feat(core)!: drop the legacy flag")
    expect(p.conventional).toBe(true)
    expect(p.type).toBe("feat")
    expect(p.scope).toBe("core")
    expect(p.subject).toBe("drop the legacy flag")
  })

  test("breaking-change `!` with no scope", () => {
    const p = parseConventionalCommit("refactor!: rename the port")
    expect(p.conventional).toBe(true)
    expect(p.type).toBe("refactor")
    expect(p.scope).toBeUndefined()
    expect(p.subject).toBe("rename the port")
  })

  test("body with footer — everything after the blank line is body (footer included)", () => {
    const p = parseConventionalCommit(
      "fix(loop): stop double yield\n\nThe stream re-entered.\n\nBREAKING CHANGE: removed onYield\nRefs: #42",
    )
    expect(p.conventional).toBe(true)
    expect(p.subject).toBe("stop double yield")
    expect(p.body).toContain("The stream re-entered.")
    expect(p.body).toContain("BREAKING CHANGE: removed onYield")
    expect(p.body).toContain("Refs: #42")
  })

  test("body-only with no blank-line separator ⇒ lines after header become body", () => {
    const p = parseConventionalCommit("docs: add readme\nmore detail right after")
    expect(p.conventional).toBe(true)
    expect(p.subject).toBe("add readme")
    expect(p.body).toBe("more detail right after")
  })

  test("uppercase type ⇒ NOT conventional (grammar requires lowercase) — typed, no throw", () => {
    const p = parseConventionalCommit("FEAT: shout")
    expect(p.conventional).toBe(false)
    expect(p.subject).toBe("FEAT: shout")
  })

  test("header only, no body ⇒ empty body", () => {
    const p = parseConventionalCommit("chore: tidy")
    expect(p.conventional).toBe(true)
    expect(p.body).toBe("")
  })

  test("empty / whitespace input ⇒ typed, conventional:false, no throw", () => {
    expect(parseConventionalCommit("").conventional).toBe(false)
    expect(parseConventionalCommit("   \n  ").conventional).toBe(false)
  })
})

describe("parsePrAuthored — harder edges", () => {
  test("multiline body inside <BODY> preserved", () => {
    const p = parsePrAuthored(
      "<TITLE>\nAdd X\n</TITLE>\n<BODY>\n## Summary\n- a\n- b\n## Test plan\n- ran tests\n</BODY>",
    )
    expect(p.structured).toBe(true)
    expect(p.title).toBe("Add X")
    expect(p.body).toContain("## Test plan")
  })

  test("title with leading blank lines (free text) ⇒ first NON-empty line is title", () => {
    const p = parsePrAuthored("\n\nReal title here\n\nbody line")
    expect(p.structured).toBe(false)
    expect(p.title).toBe("Real title here")
    expect(p.body).toBe("body line")
  })

  test("empty input ⇒ empty title + body, structured:false, no throw", () => {
    const p = parsePrAuthored("")
    expect(p.structured).toBe(false)
    expect(p.title).toBe("")
    expect(p.body).toBe("")
  })
})
