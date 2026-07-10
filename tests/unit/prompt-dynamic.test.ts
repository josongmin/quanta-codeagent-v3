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

  test("captures effective prompt policy metadata without leaking prompt text", () => {
    const out = buildTurnContext(
      base({
        baseMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "<conversation summary>\ncarry forward only" }],
          },
        ],
        mode: "review",
        system: "CUSTOM BASE",
        repoRules: {
          sourcePath: "/repo/AGENTS.md",
          entrypoint: "AGENTS.md",
          body: "repo-authority",
          loadedAt: 1,
        },
        sessionCtx: "session-static",
        userAppend: "user-static",
        promptSurfaceProfile: {
          envPosture: "frozen",
          promptPack: "batch",
          verifyStrategy: "reproduce-first",
        },
        activeLevers: {
          budgetMeter: true,
          budgetLedger: false,
          subagentTurnGate: true,
        },
        globRules: [
          {
            sourcePath: "/repo/.cursor/rules/react.mdc",
            globs: ["*.tsx"],
            alwaysApply: false,
            body: "tsx only",
          },
        ],
        changedPaths: ["src/App.tsx"],
        activeSkills: [{ name: "rr", description: "review skill" }],
        memoryContext: "remember this",
        hookPromptInjects: [{ injectBeforeUser: "hook-before", injectAfterSystem: "hook-after" }],
        mentionInjectionMessages: [{ role: "user", content: [{ type: "text", text: "@foo" }] }],
      }),
    )

    expect(out.promptPolicy).toEqual({
      mode: "review",
      baseSystem: "caller_provided",
      systemLayout: "four_section",
      repoRulesPresent: true,
      sessionCtxPresent: true,
      userAppendPresent: true,
      selectedGlobRuleNames: ["react.mdc"],
      activeSkillNames: ["rr"],
      workingStatePresent: false,
      memoryContextPresent: true,
      contextChangeCount: 0,
      mentionInjectionCount: 1,
      hookContext: "both",
      summaryPrefix: "conversation_summary",
      surfaceProfile: {
        envPosture: "frozen",
        promptPack: "batch",
        verifyStrategy: "reproduce-first",
      },
      activeLevers: {
        budgetMeter: true,
        budgetLedger: false,
        subagentTurnGate: true,
      },
      // ADR-0538 Phase 2 — additive fired-notice-atom manifest. This turn is
      // `mode:"review"`, so the review mode-notice atom fires on the per-turn
      // `message.system_reminder` channel; the manifest reports its variantId
      // (redaction-safe — names only, never prompt text). A `default`/non-brief
      // turn fires NO notice atom, so both keys are ABSENT (snapshot byte-
      // identical to the pre-ADR-0538 shape).
      firedAtomIds: ["NOTICE-REVIEW"],
      byChannel: { "message.system_reminder": ["NOTICE-REVIEW"] },
    })
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

  test("repoRules stay in the static system while workingState still precedes memory hints", () => {
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
    const wsIdx = text.indexOf("## Working state")
    const memIdx = text.indexOf("memory-hint-marker")
    expect(out.system.some((block) => block.text.includes("## Repo-local rules"))).toBe(true)
    expect(text).not.toContain("## Repo-local rules")
    expect(wsIdx).toBeGreaterThanOrEqual(0)
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

  test("repoRules block appears in the static project_md section with the entrypoint citation", () => {
    const out = buildTurnContext(base({ repoRules: rules }))
    const projectMd = out.system.find((block) => block.text.includes("## Repo-local rules"))
    expect(projectMd?.text).toContain("## Repo-local rules (from AGENTS.md)")
    expect(projectMd?.text).toContain("no heuristics; fail-closed; front-door build only")
  })

  test("repoRules are not duplicated into the dynamic reminder when sectioned", () => {
    const out = buildTurnContext(base({ repoRules: rules, memoryContext: "memory-hint-marker" }))
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    expect(text).not.toContain("## Repo-local rules")
    expect(text).toContain("memory-hint-marker")
    expect(out.system.some((block) => block.text.includes("## Repo-local rules"))).toBe(true)
  })

  test("absent repoRules ⇒ no block (byte-identical for repos without rule files)", () => {
    const out = buildTurnContext(base())
    const text = reminderText(out.messages[out.messages.length - 1] as Message)
    expect(text).not.toContain("Repo-local rules")
    expect(out.system.some((block) => block.text.includes("Repo-local rules"))).toBe(false)
  })

  test("repoRules activates 4-section preset — base prefix block stays byte-stable", () => {
    // Claude Desktop 1.7196 `systemPromptSectionCache` pattern: repo-local
    // rules ride as a SEPARATE cached section (`project_md`) so a CLAUDE.md
    // edit only invalidates the trailing affected breakpoint while the base
    // section stays warm. Legacy invariant (no shift at all) is retired —
    // see ADR-prompt-sections-default-on.
    const withoutRules = buildTurnContext(base()).system
    const withRules = buildTurnContext(base({ repoRules: rules })).system
    // Legacy single-block when no rules.
    expect(withoutRules).toHaveLength(1)
    // Sectioned (base + project_md) when rules are present.
    expect(withRules.length).toBeGreaterThanOrEqual(2)
    // Base section is identical in both — only the trailing project_md is new.
    expect(withRules[0]).toEqual(withoutRules[0] as (typeof withRules)[0])
    // Project_md carries the rule body and is cache:true.
    expect(withRules[1]?.text).toContain(rules.body)
    expect(withRules[1]?.cache).toBe(true)
  })
})

// jul-9 audit S1: ARCHITECT/EDITOR mode notices are production-reachable (editor is a
// MUTATING mode whose "minimal surgical diffs" contract lives ONLY in the notice string)
// but had ZERO content/wiring guards — the e2e matrix covered only plan/review/audit
// (BLOCKING_MODES). Pin that both notices route through `modeNotice` into the trailing
// reminder with their distinctive contract, and don't cross-leak.
describe("buildTurnContext — architect/editor mode notice injection (S1)", () => {
  const tailReminder = (over: Partial<TurnContextInput>): string => {
    const { messages } = buildTurnContext(base(over))
    const tail = messages[messages.length - 1]
    return tail ? reminderText(tail) : ""
  }

  test("architect mode injects its READ-ONLY design-first notice", () => {
    const r = tailReminder({ mode: "architect" })
    expect(r).toContain("<system-reminder>")
    expect(r).toContain("ARCHITECT MODE is active")
    expect(r).toContain("Do NOT modify anything") // read-only posture
    expect(r).not.toContain("EDITOR MODE is active") // no cross-leak
  })

  test("editor mode injects its MINIMAL-SURGICAL-diffs notice (mutating posture)", () => {
    const r = tailReminder({ mode: "editor" })
    expect(r).toContain("<system-reminder>")
    expect(r).toContain("EDITOR MODE is active")
    expect(r).toContain("MINIMAL, SURGICAL diffs only") // the mutating-mode contract
    expect(r).toContain("Always read before editing")
    // editor is MUTATING — it must NOT carry a "do not modify" line (would contradict posture)
    expect(r).not.toContain("Do NOT modify anything")
  })

  test("default mode carries NO architect/editor notice (byte-identical legacy)", () => {
    const r = tailReminder({})
    expect(r).not.toContain("ARCHITECT MODE is active")
    expect(r).not.toContain("EDITOR MODE is active")
  })
})
