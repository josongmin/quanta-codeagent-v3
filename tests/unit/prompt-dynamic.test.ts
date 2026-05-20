import { describe, expect, test } from "bun:test"
import type { TurnContextInput } from "@/agent"
import { buildSystemPrompt, buildTurnContext } from "@/agent"
import type { Message } from "@/llm"

const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "do it" }] }]

const base = (over: Partial<TurnContextInput> = {}): TurnContextInput => ({
  baseMessages: seed,
  cwd: "/repo",
  planMode: false,
  ...over,
})

const reminderText = (m: Message): string => {
  const block = m.content[0]
  return block?.type === "text" ? block.text : ""
}

describe("buildTurnContext system block", () => {
  test("system is a single SystemBlock with the last block cache:true", () => {
    const { system } = buildTurnContext(base())
    expect(Array.isArray(system)).toBe(true)
    expect(system).toHaveLength(1)
    const last = system[system.length - 1]
    expect(last?.type).toBe("text")
    expect(last?.cache).toBe(true)
  })

  test("system defaults to the built-in prompt and stays byte-identical per turn", () => {
    const t1 = buildTurnContext(base({ cwd: "/a" }))
    const t2 = buildTurnContext(base({ cwd: "/b", planMode: true, memoryContext: "x" }))
    expect(t1.system[0]?.text).toBe(buildSystemPrompt())
    // Despite wildly different dynamic input, the cached prefix is unchanged.
    expect(t2.system).toEqual(t1.system)
  })

  test("caller-provided system overrides the built-in", () => {
    const { system } = buildTurnContext(base({ system: "CUSTOM BASE PROMPT" }))
    expect(system[0]?.text).toBe("CUSTOM BASE PROMPT")
    expect(system[0]?.cache).toBe(true)
    expect(system[0]?.text).not.toBe(buildSystemPrompt())
  })
})

describe("buildTurnContext dynamic context message", () => {
  test("appends exactly one trailing <system-reminder> user message", () => {
    const { messages } = buildTurnContext(base())
    expect(messages).toHaveLength(seed.length + 1)
    // base history is preserved verbatim and not mutated.
    expect(messages.slice(0, seed.length)).toEqual(seed)
    const tail = messages[messages.length - 1]
    expect(tail?.role).toBe("user")
    const text = reminderText(tail as Message)
    expect(text.startsWith("<system-reminder>\n")).toBe(true)
    expect(text.endsWith("\n</system-reminder>")).toBe(true)
  })

  test("does not mutate the caller's baseMessages array", () => {
    const input = base()
    const before = input.baseMessages.length
    buildTurnContext(input)
    expect(input.baseMessages).toHaveLength(before)
  })

  test("reminder always carries date and cwd", () => {
    const { messages } = buildTurnContext(base({ cwd: "/my/work/dir" }))
    const text = reminderText(messages[messages.length - 1] as Message)
    expect(text).toContain(`Working directory: /my/work/dir`)
    expect(text).toContain(`Today's date is ${new Date().toISOString().slice(0, 10)}.`)
  })

  test("plan-mode notice only appears when planMode is true", () => {
    const off = buildTurnContext(base({ planMode: false }))
    expect(reminderText(off.messages[off.messages.length - 1] as Message)).not.toContain(
      "PLAN MODE is active",
    )

    const on = buildTurnContext(base({ planMode: true }))
    expect(reminderText(on.messages[on.messages.length - 1] as Message)).toContain(
      "PLAN MODE is active",
    )
  })

  test("memory recall only when non-empty after trim", () => {
    const blank = buildTurnContext(base({ memoryContext: "   \n  " }))
    const blankText = reminderText(blank.messages[blank.messages.length - 1] as Message)
    expect(blankText).not.toContain("recalled")

    const withMem = buildTurnContext(base({ memoryContext: "  recalled fact  " }))
    const memText = reminderText(withMem.messages[withMem.messages.length - 1] as Message)
    expect(memText).toContain("recalled fact")
  })

  test("dynamic context is never absent — date+cwd are always present", () => {
    // There is always at least date + cwd, so a reminder message always rides.
    const { messages } = buildTurnContext(base())
    expect(messages.length).toBeGreaterThan(seed.length)
  })

  test("dynamic context rides as ONE message even with plan + memory", () => {
    const { messages } = buildTurnContext(base({ planMode: true, memoryContext: "remember this" }))
    const reminders = messages.filter((m) =>
      m.content.some((b) => b.type === "text" && b.text.includes("<system-reminder>")),
    )
    expect(reminders).toHaveLength(1)
    const text = reminderText(messages[messages.length - 1] as Message)
    expect(text).toContain("Working directory:")
    expect(text).toContain("PLAN MODE is active")
    expect(text).toContain("remember this")
  })
})

describe("buildTurnContext mode resolution (Phase 0)", () => {
  test("explicit mode wins over legacy planMode", () => {
    const out = buildTurnContext(base({ mode: "review", planMode: true }))
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    expect(text).toContain("REVIEW MODE is active")
    expect(text).not.toContain("PLAN MODE is active")
  })

  test("review mode emits findings-first notice", () => {
    const out = buildTurnContext(base({ mode: "review" }))
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    expect(text).toContain("REVIEW MODE is active")
    expect(text).toContain("findings-first")
  })

  test("audit mode emits 4-surface notice", () => {
    const out = buildTurnContext(base({ mode: "audit" }))
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    expect(text).toContain("AUDIT MODE is active")
    expect(text).toContain("four truth surfaces")
    expect(text).toContain("type, owner, wire, test")
  })

  test("default mode emits no mode notice (byte-identical to legacy)", () => {
    const out = buildTurnContext(base({ mode: "default" }))
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    expect(text).not.toContain("PLAN MODE is active")
    expect(text).not.toContain("REVIEW MODE is active")
    expect(text).not.toContain("AUDIT MODE is active")
  })

  test("planMode:true with no mode → effective plan mode (backward compat)", () => {
    const out = buildTurnContext(base({ planMode: true }))
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    expect(text).toContain("PLAN MODE is active")
  })
})

describe("buildTurnContext working state (Phase 6 — Codex memory L3)", () => {
  const rules = {
    sourcePath: "/repo/AGENTS.md",
    entrypoint: "AGENTS.md" as const,
    body: "no heuristics; fail-closed",
    loadedAt: 0,
  }

  test("non-empty workingState renders a ## Working state block", () => {
    const out = buildTurnContext(
      base({
        workingState: {
          ownerShortlist: [{ file: "a.ts", reason: "primary" }],
          blockers: [],
          nextStepQueue: [],
          deferredValidation: [],
        },
      }),
    )
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    expect(text).toContain("## Working state")
    expect(text).toContain("a.ts")
    expect(text).toContain("primary")
  })

  test("empty workingState ⇒ no block (byte-identical when nothing to carry)", () => {
    const out = buildTurnContext(
      base({
        workingState: {
          ownerShortlist: [],
          blockers: [],
          nextStepQueue: [],
          deferredValidation: [],
        },
      }),
    )
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    expect(text).not.toContain("## Working state")
  })

  test("workingState block sits between repoRules and memory hints", () => {
    const out = buildTurnContext(
      base({
        repoRules: rules,
        workingState: {
          ownerShortlist: [{ file: "owner.ts", reason: "primary" }],
          blockers: [],
          nextStepQueue: [],
          deferredValidation: [],
        },
        memoryContext: "memory-hint-marker",
      }),
    )
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    const repoIdx = text.indexOf("## Repo-local rules")
    const wsIdx = text.indexOf("## Working state")
    const memIdx = text.indexOf("memory-hint-marker")
    expect(repoIdx).toBeGreaterThanOrEqual(0)
    expect(wsIdx).toBeGreaterThan(repoIdx)
    expect(memIdx).toBeGreaterThan(wsIdx)
  })

  test("workingState never shifts the cached system prefix", () => {
    const withoutWs = buildTurnContext(base()).system
    const withWs = buildTurnContext(
      base({
        workingState: {
          ownerShortlist: [{ file: "a.ts", reason: "p" }],
          blockers: [],
          nextStepQueue: [],
          deferredValidation: [],
        },
      }),
    ).system
    expect(withWs).toEqual(withoutWs)
  })
})

describe("buildTurnContext memory hints label (Phase 6 — routing-hint trust)", () => {
  // The "Memory hints (routing hints only — not proof)" H2 is rendered by
  // memory.ts `formatBlock` so there's exactly ONE H2 per memory block (no
  // dual-H2 prefix). buildTurnContext appends the labelled body as-is.
  test("a memoryContext already carrying the routing-hint header passes through verbatim", () => {
    const labelled = "## Memory hints (routing hints only — not proof)\n- (fact) uses Postgres 16"
    const out = buildTurnContext(base({ memoryContext: labelled }))
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    // Exactly one occurrence — no double-label.
    const occurrences = text.split("## Memory hints").length - 1
    expect(occurrences).toBe(1)
    expect(text).toContain("uses Postgres 16")
  })

  test("absent memoryContext ⇒ no routing-hint label", () => {
    const out = buildTurnContext(base())
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    expect(text).not.toContain("Memory hints (routing hints only")
  })
})

describe("buildTurnContext repo-local rules (Phase 0)", () => {
  const rules = {
    sourcePath: "/repo/AGENTS.md",
    entrypoint: "AGENTS.md" as const,
    body: "no heuristics; fail-closed; front-door build only",
    loadedAt: 0,
  }

  test("repoRules block appears with the entrypoint citation", () => {
    const out = buildTurnContext(base({ repoRules: rules }))
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    expect(text).toContain("## Repo-local rules (from AGENTS.md)")
    expect(text).toContain("no heuristics; fail-closed; front-door build only")
  })

  test("repoRules block precedes memory hints (repo authority > routing hint)", () => {
    const out = buildTurnContext(base({ repoRules: rules, memoryContext: "memory-hint-marker" }))
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    const repoIdx = text.indexOf("## Repo-local rules")
    const memIdx = text.indexOf("memory-hint-marker")
    expect(repoIdx).toBeGreaterThanOrEqual(0)
    expect(memIdx).toBeGreaterThanOrEqual(0)
    expect(repoIdx).toBeLessThan(memIdx)
  })

  test("absent repoRules ⇒ no block (byte-identical for repos without rule files)", () => {
    const out = buildTurnContext(base())
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    expect(text).not.toContain("Repo-local rules")
  })

  test("repoRules block does NOT shift the cached system prefix", () => {
    const withoutRules = buildTurnContext(base()).system
    const withRules = buildTurnContext(base({ repoRules: rules })).system
    // Repo-local rules ride in the dynamic reminder, NEVER in the cached prefix.
    expect(withRules).toEqual(withoutRules)
  })
})
