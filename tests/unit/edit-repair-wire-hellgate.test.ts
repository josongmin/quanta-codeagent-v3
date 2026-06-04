/**
 * Hellgate — edit-repair composition adapters (TRACK edit-repair-wire).
 *
 * Proves the three composition adapters that let the edit-repair LOOP actually
 * run against real infra (LLMPort / DiagnosticsProvider / exec) — all infra
 * INJECTED so these tests use fakes only (no network, no real LSP, no shell).
 *
 *   - buildRepairReactor: tools-DENIED single-shot fast-model call that asks the
 *     model for a corrected edit, applies it via an injected apply fn, returns
 *     RepairAttempt. NO-THROW: a throwing llm/apply → applied:false (never
 *     escapes). The StreamInput it builds MUST carry tools:[] and fold the
 *     failure + customInstructions + target file into the prompt.
 *   - lintRepairCheck: ok(null) when the edit introduced no new diagnostics,
 *     ok(failure) when it did; infra fail → err(msg).
 *   - commandRepairCheck: exit 0 → ok(null); exit≠0 → ok(failure); throw → err.
 *
 * Plus a runRepairLoop smoke driving these adapters' fakes: it reaches green
 * within maxIters AND gives up (`exhausted`) at the cap.
 */

import { describe, expect, it } from "bun:test"
import { runRepairLoop } from "@/agent/edit-repair-loop/runner"
import type { Diagnostic, RepairFailure } from "@/agent/edit-repair-loop/types"
import {
  buildRepairReactor,
  commandRepairCheck,
  type ExecRunner,
  lintRepairCheck,
} from "@/agent/edit-repair-wire"
import type { LLMPort } from "@/llm/ports"
import type { StreamEvent, StreamInput } from "@/llm/types"
import { ok } from "@/shared"
import type { DiagnosticsProvider as ToolDiagnosticsProvider } from "@/tool/diagnostics"

// --- fakes -----------------------------------------------------------------

/** An LLMPort whose stream yields a fixed sequence of text deltas. Records the
 *  StreamInput it was handed so we can assert tools:[] + prompt content. */
const fakeLlm = (reply: string, capture?: { input?: StreamInput }): LLMPort => ({
  model: "fast-test",
  stream(input: StreamInput): AsyncIterable<StreamEvent> {
    if (capture) capture.input = input
    async function* gen(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: reply }
      yield { type: "message_stop", stop_reason: "end_turn" }
    }
    return gen()
  },
})

const throwingLlm = (): LLMPort => ({
  model: "boom",
  stream(): AsyncIterable<StreamEvent> {
    throw new Error("stream construction blew up")
  },
})

/** Yields a delta then THROWS mid-iteration — exercises the drain-loop throw
 *  path (distinct from a construction throw, which never enters `for await`). */
const midStreamThrowLlm = (): LLMPort => ({
  model: "boom-mid",
  stream(): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: "partial" }
      throw new Error("connection reset mid-stream")
    }
    return gen()
  },
})

/** Emits text, then a stream_reset (a backup provider took over) wiping the
 *  accumulated content, then nothing — so the drained reply is empty. */
const resetWipesLlm = (): LLMPort => ({
  model: "reset",
  stream(): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: "doomed text" }
      yield { type: "stream_reset" }
    }
    return gen()
  },
})

const diag = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  file: "/x/a.ts",
  line: 10,
  code: "TS2322",
  message: "Type 'string' is not assignable to type 'number'.",
  severity: "error",
  ...over,
})

// --- buildRepairReactor ----------------------------------------------------

describe("buildRepairReactor", () => {
  const failure: RepairFailure = {
    check: "lints",
    diagnostics: [diag()],
    output: "",
  }

  it("builds tools:[] StreamInput, folds failure + instructions + file in prompt, applies edit", async () => {
    const cap: { input?: StreamInput } = {}
    let applied: { file: string; content: string } | null = null
    const reactor = buildRepairReactor(fakeLlm("here is the corrected code", cap), {
      apply: async (file, content) => {
        applied = { file, content }
        return ok(undefined)
      },
    })

    const attempt = await reactor({
      file: "/x/a.ts",
      failure,
      customInstructions: "do not change the public signature",
      iteration: 0,
    })

    expect(attempt.applied).toBe(true)
    // tools are DENIED on the repair call.
    expect(cap.input?.tools).toEqual([])
    // prompt folds the file, the failing diagnostic, and the custom instruction.
    const prompt = JSON.stringify(cap.input?.messages)
    expect(prompt).toContain("/x/a.ts")
    expect(prompt).toContain("TS2322")
    expect(prompt).toContain("do not change the public signature")
    // the model's reply was applied to the target file.
    expect(applied).not.toBeNull()
    expect((applied as unknown as { file: string }).file).toBe("/x/a.ts")
    expect((applied as unknown as { content: string }).content).toContain("corrected code")
  })

  it("NO-THROW: a throwing llm → applied:false", async () => {
    const reactor = buildRepairReactor(throwingLlm(), {
      apply: async () => ok(undefined),
    })
    const attempt = await reactor({
      file: "/x/a.ts",
      failure,
      customInstructions: "",
      iteration: 0,
    })
    expect(attempt.applied).toBe(false)
    expect(attempt.rationale.length).toBeGreaterThan(0)
  })

  it("NO-THROW: a stream that throws mid-iteration → applied:false", async () => {
    let appliedCalled = false
    const reactor = buildRepairReactor(midStreamThrowLlm(), {
      apply: async () => {
        appliedCalled = true
        return ok(undefined)
      },
    })
    const attempt = await reactor({
      file: "/x/a.ts",
      failure,
      customInstructions: "",
      iteration: 0,
    })
    expect(attempt.applied).toBe(false)
    expect(attempt.rationale.length).toBeGreaterThan(0)
    // a mid-stream failure must NOT reach apply (no half-baked edit lands).
    expect(appliedCalled).toBe(false)
  })

  it("stream_reset wipes accumulated text → empty reply → applied:false", async () => {
    let appliedCalled = false
    const reactor = buildRepairReactor(resetWipesLlm(), {
      apply: async () => {
        appliedCalled = true
        return ok(undefined)
      },
    })
    const attempt = await reactor({
      file: "/x/a.ts",
      failure,
      customInstructions: "",
      iteration: 0,
    })
    expect(attempt.applied).toBe(false)
    expect(appliedCalled).toBe(false)
  })

  it("NO-THROW: a throwing apply fn → applied:false", async () => {
    const reactor = buildRepairReactor(fakeLlm("fixed"), {
      apply: async () => {
        throw new Error("disk full")
      },
    })
    const attempt = await reactor({
      file: "/x/a.ts",
      failure,
      customInstructions: "",
      iteration: 0,
    })
    expect(attempt.applied).toBe(false)
  })

  it("apply fn returning err → applied:false (not a throw)", async () => {
    const reactor = buildRepairReactor(fakeLlm("fixed"), {
      apply: async () => ({ ok: false as const, error: "patch did not anchor" }),
    })
    const attempt = await reactor({
      file: "/x/a.ts",
      failure,
      customInstructions: "",
      iteration: 0,
    })
    expect(attempt.applied).toBe(false)
    expect(attempt.rationale).toContain("anchor")
  })

  it("empty model reply → applied:false (nothing to apply)", async () => {
    const reactor = buildRepairReactor(fakeLlm("   "), {
      apply: async () => ok(undefined),
    })
    const attempt = await reactor({
      file: "/x/a.ts",
      failure,
      customInstructions: "",
      iteration: 0,
    })
    expect(attempt.applied).toBe(false)
  })

  it("aborted before dispatch → applied:false, no llm call", async () => {
    let called = false
    const llm: LLMPort = {
      stream(): AsyncIterable<StreamEvent> {
        called = true
        async function* g(): AsyncGenerator<StreamEvent> {}
        return g()
      },
    }
    const reactor = buildRepairReactor(llm, { apply: async () => ok(undefined) })
    const ctrl = new AbortController()
    ctrl.abort()
    const attempt = await reactor(
      { file: "/x/a.ts", failure, customInstructions: "", iteration: 0 },
      ctrl.signal,
    )
    expect(attempt.applied).toBe(false)
    expect(called).toBe(false)
  })

  it("aborted DURING the stream (before apply) → applied:false, apply NOT reached", async () => {
    // Signal flips to aborted while the stream is being drained: the reactor's
    // post-drain abort gate must short-circuit so no half-baked edit lands.
    const ctrl = new AbortController()
    let appliedCalled = false
    const llm: LLMPort = {
      model: "abort-mid",
      stream(): AsyncIterable<StreamEvent> {
        async function* g(): AsyncGenerator<StreamEvent> {
          yield { type: "text_delta", delta: "some corrected code" }
          // caller aborts mid-drain, after content was produced.
          ctrl.abort()
          yield { type: "message_stop", stop_reason: "end_turn" }
        }
        return g()
      },
    }
    const reactor = buildRepairReactor(llm, {
      apply: async () => {
        appliedCalled = true
        return ok(undefined)
      },
    })
    const attempt = await reactor(
      { file: "/x/a.ts", failure, customInstructions: "", iteration: 0 },
      ctrl.signal,
    )
    expect(attempt.applied).toBe(false)
    expect(attempt.rationale).toContain("abort")
    expect(appliedCalled).toBe(false)
  })

  it("happy path is single-shot: exactly ONE stream + ONE apply (no hidden retry)", async () => {
    let streamCalls = 0
    let applyCalls = 0
    const llm: LLMPort = {
      model: "count",
      stream(): AsyncIterable<StreamEvent> {
        streamCalls += 1
        async function* g(): AsyncGenerator<StreamEvent> {
          yield { type: "text_delta", delta: "fixed" }
          yield { type: "message_stop", stop_reason: "end_turn" }
        }
        return g()
      },
    }
    const reactor = buildRepairReactor(llm, {
      apply: async () => {
        applyCalls += 1
        return ok(undefined)
      },
    })
    const attempt = await reactor({
      file: "/x/a.ts",
      failure,
      customInstructions: "",
      iteration: 0,
    })
    expect(attempt.applied).toBe(true)
    expect(streamCalls).toBe(1)
    expect(applyCalls).toBe(1)
  })

  it("forwards the abort signal into the injected apply fn", async () => {
    const ctrl = new AbortController()
    let seen: AbortSignal | undefined
    const reactor = buildRepairReactor(fakeLlm("fixed"), {
      apply: async (_file, _content, signal) => {
        seen = signal
        return ok(undefined)
      },
    })
    await reactor({ file: "/x/a.ts", failure, customInstructions: "", iteration: 0 }, ctrl.signal)
    expect(seen).toBe(ctrl.signal)
  })
})

// --- lintRepairCheck -------------------------------------------------------

/** Tool-side diagnostics provider fake: returns scripted DiagnosticItems per
 *  call so we can simulate pre vs post snapshots. */
const fakeToolProvider = (
  snapshots: Array<
    Array<{
      severity: "error" | "warning" | "information" | "hint"
      message: string
      line: number
      code?: string
    }>
  >,
): ToolDiagnosticsProvider => {
  let call = 0
  return {
    unavailableReason: () => "n/a",
    open: async () => {
      const idx = Math.min(call, snapshots.length - 1)
      call += 1
      const items = snapshots[idx] ?? []
      return {
        diagnostics: async (_filePath: string) =>
          items.map((i) => ({
            severity: i.severity,
            message: i.message,
            range: { start: { line: i.line, character: 0 } },
            ...(i.code ? { code: i.code } : {}),
          })),
        stop: async () => undefined,
      }
    },
  }
}

describe("lintRepairCheck", () => {
  it("ok(null) when the edit introduced no new diagnostics", async () => {
    // pre snapshot already taken; post identical → no introduced. The pre
    // snapshot is in the loop's 1-based coordinate space (line 11 = the tool's
    // 0-based line 10 after the adapter's +1 mapping).
    const pre: Diagnostic[] = [diag({ line: 11, column: 1 })]
    const provider = fakeToolProvider([
      [{ severity: "error", message: diag().message, line: 10, code: "TS2322" }],
    ])
    const check = lintRepairCheck(provider, "/x/a.ts", "/x", pre)
    const r = await check()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBeNull()
  })

  it("ok(failure) listing introduced diagnostics when the edit added a lint", async () => {
    const pre: Diagnostic[] = []
    const provider = fakeToolProvider([
      [{ severity: "error", message: "new error", line: 4, code: "TS1005" }],
    ])
    const check = lintRepairCheck(provider, "/x/a.ts", "/x", pre)
    const r = await check()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).not.toBeNull()
      expect(r.value?.check).toBe("lints")
      expect(r.value?.diagnostics.length).toBe(1)
      expect(r.value?.diagnostics[0]?.code).toBe("TS1005")
    }
  })

  it("infra unavailable (open → null) → err(msg)", async () => {
    const provider: ToolDiagnosticsProvider = {
      unavailableReason: () => "no language server",
      open: async () => null,
    }
    const check = lintRepairCheck(provider, "/x/a.ts", "/x", [])
    const r = await check()
    expect(r.ok).toBe(false)
  })

  it("NO-THROW: a throwing provider → err(msg)", async () => {
    const provider: ToolDiagnosticsProvider = {
      unavailableReason: () => "x",
      open: async () => {
        throw new Error("spawn failed")
      },
    }
    const check = lintRepairCheck(provider, "/x/a.ts", "/x", [])
    const r = await check()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("spawn failed")
  })

  it("NO-THROW + no session leak: diagnostics() throws → err AND session.stop() still runs", async () => {
    let stopped = false
    const provider: ToolDiagnosticsProvider = {
      unavailableReason: () => "x",
      open: async () => ({
        diagnostics: async () => {
          throw new Error("analysis crashed")
        },
        stop: async () => {
          stopped = true
        },
      }),
    }
    const check = lintRepairCheck(provider, "/x/a.ts", "/x", [])
    const r = await check()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("analysis crashed")
    // the finally-block must close the session even on the throw path.
    expect(stopped).toBe(true)
  })

  it("opens and stops EXACTLY ONE session per invocation (no leak, no double-open)", async () => {
    let opens = 0
    let stops = 0
    const provider: ToolDiagnosticsProvider = {
      unavailableReason: () => "x",
      open: async () => {
        opens += 1
        return {
          diagnostics: async () => [],
          stop: async () => {
            stops += 1
          },
        }
      },
    }
    const check = lintRepairCheck(provider, "/x/a.ts", "/x", [])
    await check()
    expect(opens).toBe(1)
    expect(stops).toBe(1)
  })
})

// --- commandRepairCheck ----------------------------------------------------

describe("commandRepairCheck", () => {
  const exec0: ExecRunner = async () => ({ exitCode: 0, output: "all tests pass" })
  const exec1: ExecRunner = async () => ({ exitCode: 1, output: "1 failing" })
  const execThrow: ExecRunner = async () => {
    throw new Error("ENOENT bun")
  }

  it("exit 0 → ok(null)", async () => {
    const r = await commandRepairCheck(exec0, "bun test")()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBeNull()
  })

  it("exit 1 → ok(failure) carrying exitCode + output", async () => {
    const r = await commandRepairCheck(exec1, "bun test")()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).not.toBeNull()
      expect(r.value?.check).toBe("command")
      expect(r.value?.exitCode).toBe(1)
      expect(r.value?.output).toContain("1 failing")
    }
  })

  it("NO-THROW: a throwing exec → err(msg)", async () => {
    const r = await commandRepairCheck(execThrow, "bun test")()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("ENOENT")
  })

  it("forwards the abort signal + the exact command into the injected runner", async () => {
    const ctrl = new AbortController()
    let seenCmd: string | undefined
    let seenSig: AbortSignal | undefined
    const exec: ExecRunner = async (command, signal) => {
      seenCmd = command
      seenSig = signal
      return { exitCode: 0, output: "" }
    }
    await commandRepairCheck(exec, "bun test ./x")(ctrl.signal)
    expect(seenCmd).toBe("bun test ./x")
    expect(seenSig).toBe(ctrl.signal)
  })
})

// --- runRepairLoop smoke (adapters wired to fakes) -------------------------

describe("runRepairLoop driven by these adapters", () => {
  it("reaches green within maxIters", async () => {
    // command fails once, reactor applies, command then passes.
    let runs = 0
    const exec: ExecRunner = async () => {
      runs += 1
      return runs === 1 ? { exitCode: 1, output: "fail" } : { exitCode: 0, output: "ok" }
    }
    const reactor = buildRepairReactor(fakeLlm("fixed code"), { apply: async () => ok(undefined) })

    const report = await runRepairLoop(
      { file: "/x/a.ts", checkKind: "command", maxIters: 3 },
      { check: commandRepairCheck(exec, "bun test"), reactor },
    )
    expect(report.green).toBe(true)
    expect(report.stop.kind).toBe("green")
    expect(report.attempts).toBe(1)
  })

  it("gives up (exhausted) at the cap when never green", async () => {
    const exec: ExecRunner = async () => ({ exitCode: 1, output: "still failing" })
    const reactor = buildRepairReactor(fakeLlm("attempted fix"), {
      apply: async () => ok(undefined),
    })

    const report = await runRepairLoop(
      { file: "/x/a.ts", checkKind: "command", maxIters: 2 },
      { check: commandRepairCheck(exec, "bun test"), reactor },
    )
    expect(report.green).toBe(false)
    expect(report.stop.kind).toBe("exhausted")
    expect(report.attempts).toBe(2)
  })
})
