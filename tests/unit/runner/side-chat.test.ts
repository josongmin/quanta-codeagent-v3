/**
 * Lock down the isolation invariants of `runSideChat` — the Claude Code A9
 * side-chat pattern: a quick question answered in an ISOLATED agent loop with
 * no side effects on the main session.
 *
 * Tests:
 *   1. Default tool allowlist filter — only read-only tools registered.
 *   2. Forbidden mutating tools are dropped even when passed via toolAllowlist.
 *   3. Main session message history is NEVER mutated (referential + content).
 *   4. Main session store/sessionId is NOT propagated (isolated deps view).
 *   5. Context inheritance "none" → empty inherited messages.
 *   6. Context inheritance "system" → empty inherited messages (system is
 *      conveyed via `OrchestrateDeps.system`, not history).
 *   7. Context inheritance "last-turn" → inherits last user/assistant pair.
 *   8. `maxTurns` is clamped to SIDE_CHAT_MAX_TURNS_CAP.
 *   9. Abort signal is forwarded to the assembled config.
 *  10. Empty allowlist ⇒ empty registry, side-chat still runs (text-only).
 *  11. answerText comes from the LAST assistant message text blocks only.
 *  12. Token accounting is reported on the result (default zero — no store
 *      wired so the loop cannot fold it into main metrics).
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig, AgentOutcome } from "@/agent"
import type { Message } from "@/llm"
import {
  buildSideChatHistory,
  buildSideChatRegistry,
  extractAnswerText,
  type OrchestrateDeps,
  runSideChat,
  SIDE_CHAT_DEFAULT_READ_ONLY,
  SIDE_CHAT_FORBIDDEN,
  SIDE_CHAT_MAX_TURNS_CAP,
} from "@/runner"
import { defaultTools, ToolRegistry } from "@/tool"

/** Build a minimal `OrchestrateDeps` stub. Most fields are unused because the
 *  injected `assembleConfig` captures the deps view and asserts on it without
 *  invoking the LLM. */
const stubDeps = (signal: AbortSignal): OrchestrateDeps =>
  ({
    llm: { stream: async function* () {} } as never,
    registry: new ToolRegistry(defaultTools),
    stream: { emit: () => undefined } as never,
    permission: { mode: "default" } as never,
    system: "main-session-system",
    cwd: "/tmp",
    maxTurns: 99,
    signal,
    onConfirm: async () => false,
    store: { magic: "MAIN_STORE_DO_NOT_PROPAGATE" } as never,
    sessionId: "main-session-id",
    embedder: { magic: "MAIN_EMBEDDER" } as never,
    memoryConfig: { magic: "MAIN_MEM" } as never,
    planMode: true,
    metrics: { magic: "MAIN_METRICS" } as never,
    run: { magic: "MAIN_RUN" } as never,
    subagentConfig: { magic: "MAIN_SUBAGENT" } as never,
    skillsConfig: undefined,
    compactionBreakerConfig: { magic: "MAIN_BREAKER" } as never,
    verifyGuardConfig: { magic: "MAIN_VG" } as never,
    summarizerLlm: { magic: "MAIN_SUM" } as never,
    onShellEvent: undefined,
    workMetricsSink: { magic: "MAIN_WM" } as never,
  }) satisfies OrchestrateDeps

/** Build a fake assembleConfig that captures every `(messages, deps)`
 *  invocation. The captured config is returned in a shape `runAgent` accepts;
 *  we substitute the LLM with a one-shot fake assistant response. */
interface CaptureSlot {
  messagesSeen?: Message[]
  depsSeen?: OrchestrateDeps
  configSeen?: AgentConfig
}

const makeAssembler = (
  cap: CaptureSlot,
  outcomeMessages: Message[] = [],
): ((m: Message[], d: OrchestrateDeps) => AgentConfig) => {
  return (messages, deps) => {
    cap.messagesSeen = messages
    cap.depsSeen = deps
    // Build a real AgentConfig with a fake LLM that yields one assistant
    // message + end_turn. The loop will see this and return.
    const config: AgentConfig = {
      llm: {
        async *stream() {
          for (const m of outcomeMessages) {
            for (const block of m.content) {
              if (block.type === "text") {
                yield { type: "text_delta", delta: block.text }
              }
            }
          }
          yield { type: "message_stop", stop_reason: "end_turn" }
        },
      } as never,
      registry: deps.registry,
      stream: deps.stream,
      permission: deps.permission,
      messages,
      system: deps.system,
      cwd: deps.cwd,
      maxTurns: deps.maxTurns,
      signal: deps.signal,
      onConfirm: deps.onConfirm,
    }
    cap.configSeen = config
    return config
  }
}

describe("runSideChat — isolation invariants", () => {
  test("default tool allowlist filters to read-only tools only", async () => {
    const cap: CaptureSlot = {}
    const abort = new AbortController()
    const deps = stubDeps(abort.signal)
    await runSideChat({
      prompt: "what's the test command?",
      deps,
      assembleConfig: makeAssembler(cap, [
        { role: "assistant", content: [{ type: "text", text: "bun test" }] },
      ]),
      mainHistory: [],
      signal: abort.signal,
    })
    expect(cap.depsSeen).toBeDefined()
    const sideReg = cap.depsSeen?.registry as ToolRegistry
    // Every tool registered MUST be in the default allowlist (no leakage).
    for (const spec of sideReg.specs()) {
      expect(SIDE_CHAT_DEFAULT_READ_ONLY).toContain(spec.name)
    }
    // None of the forbidden tools may appear in the filtered registry.
    for (const forbidden of SIDE_CHAT_FORBIDDEN) {
      expect(sideReg.has(forbidden)).toBe(false)
    }
  })

  test("forbidden tools are dropped even when explicitly listed", async () => {
    const cap: CaptureSlot = {}
    const abort = new AbortController()
    await runSideChat({
      prompt: "hi",
      deps: stubDeps(abort.signal),
      assembleConfig: makeAssembler(cap, [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ]),
      mainHistory: [],
      // Smuggle in forbidden tools — the runner MUST drop them.
      toolAllowlist: ["read", "write", "edit", "bash", "apply_patch", "grep"],
      signal: abort.signal,
    })
    const sideReg = cap.depsSeen?.registry as ToolRegistry
    expect(sideReg.has("read")).toBe(true)
    expect(sideReg.has("grep")).toBe(true)
    expect(sideReg.has("write")).toBe(false)
    expect(sideReg.has("edit")).toBe(false)
    expect(sideReg.has("bash")).toBe(false)
    expect(sideReg.has("apply_patch")).toBe(false)
  })

  test("main history is NEVER mutated (referential + content invariant)", async () => {
    const cap: CaptureSlot = {}
    const abort = new AbortController()
    const original: Message[] = [
      { role: "user", content: [{ type: "text", text: "main turn 1" }] },
      { role: "assistant", content: [{ type: "text", text: "main reply 1" }] },
    ]
    const snapshot = JSON.stringify(original)
    const lenBefore = original.length
    await runSideChat({
      prompt: "side question",
      deps: stubDeps(abort.signal),
      assembleConfig: makeAssembler(cap, [
        { role: "assistant", content: [{ type: "text", text: "side answer" }] },
      ]),
      mainHistory: original,
      contextInheritance: "last-turn",
      signal: abort.signal,
    })
    // Content identical AND length unchanged — the inherited pair was COPIED.
    expect(JSON.stringify(original)).toBe(snapshot)
    expect(original.length).toBe(lenBefore)
  })

  test("isolated deps view: main store / metrics / memory dropped", async () => {
    const cap: CaptureSlot = {}
    const abort = new AbortController()
    const mainDeps = stubDeps(abort.signal)
    await runSideChat({
      prompt: "hi",
      deps: mainDeps,
      assembleConfig: makeAssembler(cap, [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ]),
      mainHistory: [],
      signal: abort.signal,
    })
    const sideDeps = cap.depsSeen
    expect(sideDeps).toBeDefined()
    if (sideDeps === undefined) throw new Error("unreachable")
    // None of the side-effecting fields may pass through.
    expect(sideDeps.store).toBeUndefined()
    expect(sideDeps.embedder).toBeUndefined()
    expect(sideDeps.memoryConfig).toBeUndefined()
    expect(sideDeps.metrics).toBeUndefined()
    expect(sideDeps.run).toBeUndefined()
    expect(sideDeps.subagentConfig).toBeUndefined()
    expect(sideDeps.compactionBreakerConfig).toBeUndefined()
    expect(sideDeps.verifyGuardConfig).toBeUndefined()
    expect(sideDeps.summarizerLlm).toBeUndefined()
    expect(sideDeps.workMetricsSink).toBeUndefined()
    // Plan mode is a sticky main posture — never inherited.
    expect(sideDeps.planMode).toBe(false)
    // SessionId is namespaced under main but DIFFERENT.
    expect(sideDeps.sessionId).not.toBe(mainDeps.sessionId)
    expect(sideDeps.sessionId.startsWith("side:main-session-id:")).toBe(true)
    // The non-side-effecting passthroughs (system / cwd / permission /
    // onConfirm / stream / llm) ARE preserved verbatim.
    expect(sideDeps.system).toBe(mainDeps.system)
    expect(sideDeps.cwd).toBe(mainDeps.cwd)
    expect(sideDeps.llm).toBe(mainDeps.llm)
  })

  test("inheritance=none ⇒ messages starts with the user prompt only", async () => {
    const cap: CaptureSlot = {}
    const abort = new AbortController()
    const main: Message[] = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
    ]
    await runSideChat({
      prompt: "q",
      deps: stubDeps(abort.signal),
      assembleConfig: makeAssembler(cap, [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ]),
      mainHistory: main,
      contextInheritance: "none",
      signal: abort.signal,
    })
    const seen = cap.messagesSeen ?? []
    expect(seen.length).toBe(1)
    expect(seen[0]?.role).toBe("user")
    expect((seen[0]?.content[0] as { type: "text"; text: string }).text).toBe("q")
  })

  test("inheritance=system (default) ⇒ same shape as 'none' (system is in deps.system)", async () => {
    const cap: CaptureSlot = {}
    const abort = new AbortController()
    await runSideChat({
      prompt: "q",
      deps: stubDeps(abort.signal),
      assembleConfig: makeAssembler(cap, [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ]),
      mainHistory: [{ role: "user", content: [{ type: "text", text: "irrelevant" }] }],
      // contextInheritance defaults to "system"
      signal: abort.signal,
    })
    const seen = cap.messagesSeen ?? []
    expect(seen.length).toBe(1)
    expect((seen[0]?.content[0] as { type: "text"; text: string }).text).toBe("q")
    // And the system prompt is forwarded via deps.system.
    expect(cap.depsSeen?.system).toBe("main-session-system")
  })

  test("inheritance=last-turn ⇒ last user/assistant pair is prepended", async () => {
    const cap: CaptureSlot = {}
    const abort = new AbortController()
    const main: Message[] = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "u2" }] },
      { role: "assistant", content: [{ type: "text", text: "a2" }] },
    ]
    await runSideChat({
      prompt: "follow-up",
      deps: stubDeps(abort.signal),
      assembleConfig: makeAssembler(cap, [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ]),
      mainHistory: main,
      contextInheritance: "last-turn",
      signal: abort.signal,
    })
    const seen = cap.messagesSeen ?? []
    expect(seen.length).toBe(3) // u2, a2, q
    expect((seen[0]?.content[0] as { type: "text"; text: string }).text).toBe("u2")
    expect((seen[1]?.content[0] as { type: "text"; text: string }).text).toBe("a2")
    expect((seen[2]?.content[0] as { type: "text"; text: string }).text).toBe("follow-up")
  })

  test("maxTurns is clamped to SIDE_CHAT_MAX_TURNS_CAP", async () => {
    const cap: CaptureSlot = {}
    const abort = new AbortController()
    await runSideChat({
      prompt: "q",
      deps: stubDeps(abort.signal),
      assembleConfig: makeAssembler(cap, [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ]),
      mainHistory: [],
      // Try to smuggle 999 — must be clamped to the cap.
      maxTurns: 999,
      signal: abort.signal,
    })
    expect(cap.depsSeen?.maxTurns).toBe(SIDE_CHAT_MAX_TURNS_CAP)
  })

  test("maxTurns floor: 0 / negative are clamped UP to 1", async () => {
    const cap: CaptureSlot = {}
    const abort = new AbortController()
    await runSideChat({
      prompt: "q",
      deps: stubDeps(abort.signal),
      assembleConfig: makeAssembler(cap, [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ]),
      mainHistory: [],
      maxTurns: 0,
      signal: abort.signal,
    })
    expect(cap.depsSeen?.maxTurns).toBe(1)
  })

  test("abort signal is forwarded to the assembled config", async () => {
    const cap: CaptureSlot = {}
    const abort = new AbortController()
    await runSideChat({
      prompt: "q",
      deps: stubDeps(abort.signal),
      assembleConfig: makeAssembler(cap, [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ]),
      mainHistory: [],
      signal: abort.signal,
    })
    expect(cap.depsSeen?.signal).toBe(abort.signal)
  })

  test("answerText concatenates text blocks of the LAST assistant message", async () => {
    const abort = new AbortController()
    const cap: CaptureSlot = {}
    const result = await runSideChat({
      prompt: "two-part?",
      deps: stubDeps(abort.signal),
      assembleConfig: makeAssembler(cap, [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Part A. " },
            { type: "text", text: "Part B." },
          ],
        },
      ]),
      mainHistory: [],
      signal: abort.signal,
    })
    expect(result.answerText).toBe("Part A. Part B.")
  })

  test("toolsAvailable reflects the post-filter registry size", async () => {
    const cap: CaptureSlot = {}
    const abort = new AbortController()
    const result = await runSideChat({
      prompt: "q",
      deps: stubDeps(abort.signal),
      assembleConfig: makeAssembler(cap, [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ]),
      mainHistory: [],
      // Explicit small allowlist (every name is in defaultTools)
      toolAllowlist: ["read", "grep"],
      signal: abort.signal,
    })
    expect(result.toolsAvailable).toBe(2)
  })

  test("cost accounting is reported separately from main (default zero)", async () => {
    const cap: CaptureSlot = {}
    const abort = new AbortController()
    const result = await runSideChat({
      prompt: "q",
      deps: stubDeps(abort.signal),
      assembleConfig: makeAssembler(cap, [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ]),
      mainHistory: [],
      signal: abort.signal,
    })
    // Token counters are returned as data on the result — the side-chat path
    // does NOT add them to any main-session sink (main `metrics` is dropped
    // by the deps filter, asserted in the "isolated deps view" test above).
    expect(typeof result.inputTokens).toBe("number")
    expect(typeof result.outputTokens).toBe("number")
  })
})

describe("buildSideChatRegistry — pure helper", () => {
  test("source registry is NOT mutated", () => {
    const source = new ToolRegistry(defaultTools)
    const before = source
      .specs()
      .map((s) => s.name)
      .sort()
    buildSideChatRegistry(source, ["read", "grep", "write"])
    const after = source
      .specs()
      .map((s) => s.name)
      .sort()
    expect(after).toEqual(before)
  })

  test("dedup unknown names silently", () => {
    const source = new ToolRegistry(defaultTools)
    const reg = buildSideChatRegistry(source, ["read", "nonexistent_xyz"])
    expect(reg.has("read")).toBe(true)
    expect(reg.has("nonexistent_xyz")).toBe(false)
    expect(reg.specs().length).toBe(1)
  })
})

describe("buildSideChatHistory — inheritance modes", () => {
  test("returns empty for 'none' regardless of history", () => {
    const main: Message[] = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
    ]
    expect(buildSideChatHistory(main, "none")).toEqual([])
  })

  test("returns empty for 'system' (system carried via deps.system)", () => {
    const main: Message[] = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
    ]
    expect(buildSideChatHistory(main, "system")).toEqual([])
  })

  test("'last-turn' returns the last user+assistant pair", () => {
    const main: Message[] = [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "u2" }] },
      { role: "assistant", content: [{ type: "text", text: "a2" }] },
    ]
    const out = buildSideChatHistory(main, "last-turn")
    expect(out.length).toBe(2)
    expect(out[0]?.role).toBe("user")
    expect(out[1]?.role).toBe("assistant")
  })

  test("'last-turn' returns empty when no assistant message exists", () => {
    const main: Message[] = [{ role: "user", content: [{ type: "text", text: "u1" }] }]
    expect(buildSideChatHistory(main, "last-turn")).toEqual([])
  })

  test("'last-turn' returns empty for empty history", () => {
    expect(buildSideChatHistory([], "last-turn")).toEqual([])
  })
})

describe("extractAnswerText", () => {
  test("returns empty string when no assistant message exists", () => {
    const outcome: AgentOutcome = {
      reason: "completed",
      turns: 0,
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    }
    expect(extractAnswerText(outcome)).toBe("")
  })

  test("returns the LAST assistant text only", () => {
    const outcome: AgentOutcome = {
      reason: "completed",
      turns: 2,
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: [{ type: "text", text: "q2" }] },
        { role: "assistant", content: [{ type: "text", text: "a2" }] },
      ],
    }
    expect(extractAnswerText(outcome)).toBe("a2")
  })

  test("ignores non-text blocks", () => {
    const outcome: AgentOutcome = {
      reason: "completed",
      turns: 1,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hello " },
            { type: "tool_use", id: "x", name: "read", input: {} },
            { type: "text", text: "world." },
          ],
        },
      ],
    }
    expect(extractAnswerText(outcome)).toBe("Hello world.")
  })
})
