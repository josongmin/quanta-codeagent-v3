import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { TurnContextInput } from "@/agent/prompt"
import { buildSystemPrompt, buildTurnContext } from "@/agent/prompt"
import {
  ANTI_PLATITUDE,
  AUTONOMOUS_PREAMBLE,
  type DirectiveConfig,
  MEMORY_VERIFY,
  PARALLEL_TOOLS,
  PROGRESS_NARRATION,
  READ_COMPLETENESS,
  selectActiveDirectives,
  THINK_FREQUENCY,
} from "@/agent/prompt-directives"
import type { Message } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"

/**
 * §5 PROMPT-LEVEL DIRECTIVE BUNDLE hellgate (jun-06).
 *
 * Seven cheap behavioral PROMPT DIRECTIVES, each a DEFAULT-OFF gated section
 * spliced into the per-turn DYNAMIC `<system-reminder>` (mirrors C3 brief-mode).
 *
 * Invariants (TDD red→green):
 *   1. each knob ON ⇒ its directive text appears in the per-turn reminder.
 *   2. each knob OFF ⇒ its directive text is ABSENT.
 *   3. ALL OFF ⇒ the per-turn reminder is BYTE-IDENTICAL to the frozen golden
 *      (the headline default-OFF safety invariant) — proven both via the
 *      injected all-false slice AND via env (every knob unset).
 *   4. multiple ON ⇒ directives concatenate in a STABLE, deterministic order.
 *   5. directives ride the DYNAMIC slot ONLY — the static cache prefix is
 *      identical ON vs OFF, and never mentions any directive (no duplication
 *      into the cached body).
 *   6. defang safety — no directive text carries `<system-reminder>` tokens.
 */

const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }]

const ALL_OFF: DirectiveConfig = {
  directiveAutonomous: false,
  directiveReadComplete: false,
  directiveProgress: false,
  directiveMemoryVerify: false,
  directiveThinkFreq: false,
  directiveAntiPlatitude: false,
  directiveParallelTools: false,
}

const base = (over: Partial<TurnContextInput> = {}): TurnContextInput => ({
  baseMessages: seed,
  cwd: "/repo",
  now: () => Date.parse("2026-06-05T00:00:00Z"),
  // Inject an all-OFF slice by default so these tests are independent of the
  // ambient env knobs (the production path resolves from runtimeConfig()).
  directiveConfig: ALL_OFF,
  ...over,
})

const reminderText = (m: Message): string => {
  const block = m.content[0]
  return block?.type === "text" ? block.text : ""
}

const tailText = (input: TurnContextInput): string => {
  const { messages } = buildTurnContext(input)
  return reminderText(messages[messages.length - 1] as Message)
}

/** FROZEN GOLDEN: the legacy (pre-bundle) no-directive reminder tail, pinned to
 *  the fixed clock + cwd + no other dynamic context. Identical to the brief-mode
 *  golden — proves the bundle adds ZERO bytes when every knob is off. */
const GOLDEN_TAIL =
  "<system-reminder>\nToday's date is 2026-06-05.\nWorking directory: /repo\n</system-reminder>"

/** Each knob field → its marker text, in declaration order. */
const DIRECTIVES: ReadonlyArray<{
  readonly key: keyof DirectiveConfig
  readonly text: string
  readonly marker: string
}> = [
  { key: "directiveAutonomous", text: AUTONOMOUS_PREAMBLE, marker: "AUTONOMOUS MODE:" },
  { key: "directiveReadComplete", text: READ_COMPLETENESS, marker: "READ COMPLETENESS:" },
  { key: "directiveProgress", text: PROGRESS_NARRATION, marker: "PROGRESS NARRATION:" },
  { key: "directiveMemoryVerify", text: MEMORY_VERIFY, marker: "MEMORY VERIFY:" },
  { key: "directiveThinkFreq", text: THINK_FREQUENCY, marker: "THINKING BUDGET:" },
  { key: "directiveAntiPlatitude", text: ANTI_PLATITUDE, marker: "VOICE: substance only." },
  { key: "directiveParallelTools", text: PARALLEL_TOOLS, marker: "PARALLEL TOOLS:" },
]

const onlyOn = (key: keyof DirectiveConfig): DirectiveConfig => ({ ...ALL_OFF, [key]: true })

describe("§5 directive bundle — each knob ON ⇒ its text present, others absent", () => {
  for (const { key, text, marker } of DIRECTIVES) {
    test(`${key} ON ⇒ "${marker}" spliced into the dynamic tail`, () => {
      const tail = tailText(base({ directiveConfig: onlyOn(key) }))
      expect(tail).toContain(marker)
      expect(tail).toContain(text)
      // No other directive leaks in.
      for (const other of DIRECTIVES) {
        if (other.key === key) continue
        expect(tail).not.toContain(other.marker)
      }
    })

    test(`${key} OFF ⇒ "${marker}" absent`, () => {
      expect(tailText(base())).not.toContain(marker)
    })
  }
})

describe("§5 directive bundle — ALL OFF ⇒ byte-identical golden (headline)", () => {
  test("injected all-false slice ⇒ tail equals frozen golden", () => {
    expect(tailText(base())).toBe(GOLDEN_TAIL)
  })

  test("directiveConfig omitted + env unset ⇒ tail equals frozen golden", () => {
    const origs: Record<string, string | undefined> = {}
    const vars = [
      "QUANTA_DIRECTIVE_AUTONOMOUS",
      "QUANTA_DIRECTIVE_READ_COMPLETE",
      "QUANTA_DIRECTIVE_PROGRESS",
      "QUANTA_DIRECTIVE_MEMORY_VERIFY",
      "QUANTA_DIRECTIVE_THINK_FREQ",
      "QUANTA_DIRECTIVE_ANTI_PLATITUDE",
      "QUANTA_DIRECTIVE_PARALLEL_TOOLS",
    ]
    for (const v of vars) {
      origs[v] = process.env[v]
      delete process.env[v]
    }
    __resetRuntimeConfig()
    try {
      // No directiveConfig override ⇒ buildDynamicContext resolves from runtimeConfig().
      const input: TurnContextInput = {
        baseMessages: seed,
        cwd: "/repo",
        now: () => Date.parse("2026-06-05T00:00:00Z"),
      }
      expect(tailText(input)).toBe(GOLDEN_TAIL)
    } finally {
      for (const v of vars) {
        if (origs[v] === undefined) delete process.env[v]
        else process.env[v] = origs[v]
      }
      __resetRuntimeConfig()
    }
  })

  test("selectActiveDirectives(all-false) returns the empty string", () => {
    expect(selectActiveDirectives(ALL_OFF)).toBe("")
  })
})

describe("§5 directive bundle — multiple ON ⇒ stable deterministic order", () => {
  test("all seven ON ⇒ markers appear in DIRECTIVE_ORDER (declaration order)", () => {
    const allOn = Object.fromEntries(
      DIRECTIVES.map(({ key }) => [key, true]),
    ) as unknown as DirectiveConfig
    const tail = tailText(base({ directiveConfig: allOn }))
    const positions = DIRECTIVES.map(({ marker }) => tail.indexOf(marker))
    for (const p of positions) expect(p).toBeGreaterThanOrEqual(0)
    const sorted = [...positions].sort((a, b) => a - b)
    expect(positions).toEqual(sorted)
  })

  test("order is identical across repeated builds (no Math.random)", () => {
    const allOn = Object.fromEntries(
      DIRECTIVES.map(({ key }) => [key, true]),
    ) as unknown as DirectiveConfig
    const a = selectActiveDirectives(allOn)
    const b = selectActiveDirectives(allOn)
    expect(a).toBe(b)
  })

  test("subset ON ⇒ only those, in stable relative order", () => {
    const cfg: DirectiveConfig = {
      ...ALL_OFF,
      directiveReadComplete: true,
      directiveParallelTools: true,
    }
    const out = selectActiveDirectives(cfg)
    expect(out.indexOf("READ COMPLETENESS:")).toBeGreaterThanOrEqual(0)
    expect(out.indexOf("PARALLEL TOOLS:")).toBeGreaterThan(out.indexOf("READ COMPLETENESS:"))
    expect(out).not.toContain("AUTONOMOUS MODE:")
  })
})

describe("§5 directive bundle — static cache prefix untouched + no duplication", () => {
  const sys = (input: TurnContextInput) => buildTurnContext(input).system

  test("system blocks identical ON vs OFF", () => {
    const allOn = Object.fromEntries(
      DIRECTIVES.map(({ key }) => [key, true]),
    ) as unknown as DirectiveConfig
    expect(sys(base({ directiveConfig: allOn }))).toEqual(sys(base()))
  })

  test("static system prompt never carries any directive marker (no dup into cache)", () => {
    const prompt = buildSystemPrompt()
    for (const { marker } of DIRECTIVES) expect(prompt).not.toContain(marker)
  })
})

describe("§5 directive bundle — defang safety", () => {
  test("no directive text carries <system-reminder> tokens", () => {
    for (const { text } of DIRECTIVES) {
      expect(text.toLowerCase()).not.toContain("<system-reminder")
      expect(text.toLowerCase()).not.toContain("</system-reminder")
    }
  })

  test("outer wrapper stays well-formed with all directives on", () => {
    const allOn = Object.fromEntries(
      DIRECTIVES.map(({ key }) => [key, true]),
    ) as unknown as DirectiveConfig
    const tail = tailText(base({ directiveConfig: allOn }))
    expect(tail.startsWith("<system-reminder>\n")).toBe(true)
    expect(tail.endsWith("\n</system-reminder>")).toBe(true)
  })
})

describe('§5 directive bundle — env knob wiring (strict === "1")', () => {
  const vars = [
    "QUANTA_DIRECTIVE_AUTONOMOUS",
    "QUANTA_DIRECTIVE_READ_COMPLETE",
    "QUANTA_DIRECTIVE_PROGRESS",
    "QUANTA_DIRECTIVE_MEMORY_VERIFY",
    "QUANTA_DIRECTIVE_THINK_FREQ",
    "QUANTA_DIRECTIVE_ANTI_PLATITUDE",
    "QUANTA_DIRECTIVE_PARALLEL_TOOLS",
  ]
  const origs: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const v of vars) origs[v] = process.env[v]
    for (const v of vars) delete process.env[v]
    __resetRuntimeConfig()
  })
  afterEach(() => {
    for (const v of vars) {
      if (origs[v] === undefined) delete process.env[v]
      else process.env[v] = origs[v]
    }
    __resetRuntimeConfig()
  })

  test('QUANTA_DIRECTIVE_AUTONOMOUS="1" ⇒ directive splices via the production path', () => {
    process.env.QUANTA_DIRECTIVE_AUTONOMOUS = "1"
    __resetRuntimeConfig()
    const input: TurnContextInput = {
      baseMessages: seed,
      cwd: "/repo",
      now: () => Date.parse("2026-06-05T00:00:00Z"),
    }
    expect(tailText(input)).toContain("AUTONOMOUS MODE:")
  })

  test('a loose value ("true") does NOT enable the directive (strict 1)', () => {
    process.env.QUANTA_DIRECTIVE_PARALLEL_TOOLS = "true"
    __resetRuntimeConfig()
    const input: TurnContextInput = {
      baseMessages: seed,
      cwd: "/repo",
      now: () => Date.parse("2026-06-05T00:00:00Z"),
    }
    expect(tailText(input)).not.toContain("PARALLEL TOOLS:")
  })
})
