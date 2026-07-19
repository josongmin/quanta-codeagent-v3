import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConfirmDecision } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext, PermissionStore, ToolAction } from "@/permission"
import { __resetDefaultPermissionStore, createPermissionStore } from "@/permission"
import { __resetShellSandbox } from "@/runtime"
import type { PerCallSandboxAvailability, PerCallSandboxPort } from "@/runtime/os-sandbox"
import { runtimeConfigFromEnv } from "@/shared"
import { defaultTools, ToolRegistry } from "@/tool"
import { maybeWireBashSandboxEscalation } from "@/host/runtime/sandbox-escalation-wire"
import { __setBashPerCallSandboxFactory } from "@/tool/bash/per-call-factory"
import { __setBashSandboxEscalationHandler } from "@/tool/bash/sandbox-escalation-wire"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/**
 * REAL-LOOP FAKE-LLM e2e for the sandbox-block → escalation-retry loop
 * (`sandbox-escalation` feature). Prior coverage is unit-level: the machine
 * (`classifySandboxDenial` + orchestrator + post-denial store) is hellgate-proven
 * in isolation, and the LIVE wire hellgate
 * (`tests/unit/sandbox-escalation-bash-wire-hellgate.test.ts`) drives the REAL
 * `bashTool.execute` DIRECTLY — but NEVER through `runAgent`
 * (`runAgent × scripted == 0`). This closes that: a SCRIPTED LLM issues a
 * `bash mode="read"` tool call, the loop dispatches it through the real gate +
 * real bash tool, the (fake) APPLIED sandbox DENIES it, and the host-installed
 * escalation handler runs the user-gated HITL loop ACROSS the tool result —
 * with GROUND TRUTH on whether the approved retry actually re-ran the command
 * UNSANDBOXED.
 *
 * The escalation handler is a MODULE-LEVEL singleton the bash tool consults
 * (`__setBashSandboxEscalationHandler`), installed by the host wire
 * (`maybeWireBashSandboxEscalation`) — NOT carried on `AgentConfig`. So we
 * install it (with an injected `onConfirm` authority + gate-shared permission
 * store) exactly as the composition root's assembler does, then run `runAgent`.
 *
 * The fake per-call sandbox APPLIES (`sandboxApplied:true`) and rewrites the
 * argv to emit a high-confidence `Sandbox: deny(1) ...` stderr + exit 1; the
 * UNSANDBOXED re-run (no per-call wrap) runs the ORIGINAL command (which
 * succeeds). So an APPROVED escalation flips the tool_result from failure to
 * success — observable in the loop's `out.messages` tool_result — while a DENY
 * leaves it blocked (the original command never runs unsandboxed).
 */

const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]
const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** Scripted LLM: turn 1 issues the sandboxed bash call, then finishes. Records
 *  every tool_result content it SEES on the follow-up turn (so we can assert the
 *  model observed the escalation disposition across the turn boundary). */
class ScriptLLM implements LLMPort {
  readonly model = "sandbox-esc-test-model"
  calls = 0
  readonly toolResultsSeen: string[] = []
  constructor(private readonly command: string) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    for (const m of input.messages) {
      for (const b of m.content) {
        if (b.type === "tool_result") this.toolResultsSeen.push(b.content)
      }
    }
    this.calls += 1
    if (this.calls === 1) {
      // Deliberately `mode:"read"` — that is the ONLY mode that acquires the
      // per-call sandbox wrap, so it is the mode the escalation path fires for.
      for (const e of toolUse("b1", "bash", { command: this.command, mode: "read" })) yield e
      return
    }
    for (const e of text("done")) yield e
  }
}

/** A fake per-call sandbox that APPLIES and rewrites the argv so the SANDBOXED
 *  spawn fails with a Seatbelt-deny stderr (the high-confidence block signal).
 *  The UNSANDBOXED re-run runs the ORIGINAL command verbatim. */
const blockingSandbox = (): PerCallSandboxPort => ({
  availability: (): PerCallSandboxAvailability => ({ supported: true }),
  wrap: (_argv, _cwd) => ({
    argv: ["bash", "-lc", 'echo "Sandbox: app(1) deny(1) file-write-data" 1>&2; exit 1'],
    sandboxApplied: true,
  }),
})

const allToolResults = (out: { messages: { content: { type: string }[] }[] }): string[] =>
  out.messages.flatMap((m) =>
    m.content
      .filter((b): b is { type: "tool_result"; content: string } => b.type === "tool_result")
      .map((b) => b.content),
  )

describe("sandbox-escalation — real loop + fake LLM, block → HITL escalation across turns", () => {
  let dir: string
  let store: PermissionStore

  const wireWith = (approve: boolean): void => {
    const onConfirm = async (_a: ToolAction): Promise<ConfirmDecision> => ({
      decision: approve ? "allow" : "deny",
    })
    maybeWireBashSandboxEscalation(
      { onConfirm, admissibility: { permissionStore: store } } as never,
      runtimeConfigFromEnv({ QUANTA_SANDBOX_ESCALATION: "1" }),
    )
  }

  const runOnce = async (command: string, label: string) => {
    const llm = new ScriptLLM(command)
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          // bypass ⇒ the mode-policy gate ADMITS the bash call to execution, so
          // the story is the ESCALATION path (not a gate deny of the bash call).
          permission: { mode: "bypass" } as PermissionContext,
          cwd: dir,
          maxTurns: 6,
        }),
      ),
      15_000,
      label,
    )
    return { out, llm }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "sbxesc-loop-e2e-"))
    __resetShellSandbox()
    __resetDefaultPermissionStore()
    store = createPermissionStore({ filePath: join(dir, "perm-state.json"), debounceMs: 0 })
    await store.load()
    __setBashPerCallSandboxFactory(() => blockingSandbox())
  })
  afterEach(async () => {
    __resetShellSandbox()
    __setBashPerCallSandboxFactory(undefined)
    __setBashSandboxEscalationHandler(undefined)
    __resetDefaultPermissionStore()
    // The escalation seeds a post-denial record (a store mutation → debounced
    // flush); settle it BEFORE removing the dir so the async flush doesn't race
    // the rmSync into an ENOENT.
    await store.flush().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  test("block + APPROVE ⇒ the escalation RETRY re-runs the command UNSANDBOXED (failure → success) through the loop", async () => {
    wireWith(true)
    const { out, llm } = await runOnce("echo unsandboxed-ok", "sbx-esc-approve")
    expect(out.reason).toBe("completed")

    // GROUND TRUTH: the approved retry actually re-ran the ORIGINAL command
    // unsandboxed — its stdout reached the tool_result the loop fed back.
    const results = allToolResults(out)
    const escResult = results.find((c) => c.includes("blocked by the OS sandbox"))
    expect(escResult).toBeDefined()
    expect(escResult ?? "").toContain("unsandboxed-ok") // the retry RAN
    expect((escResult ?? "").toLowerCase()).toContain("approved")

    // The model saw the escalation outcome on its follow-up turn (cross-turn).
    expect(llm.toolResultsSeen.some((c) => c.includes("unsandboxed-ok"))).toBe(true)
  })

  test("block + DENY ⇒ the loop gets the DENIAL and the command NEVER runs unsandboxed (stays blocked)", async () => {
    wireWith(false)
    const { out } = await runOnce("echo SHOULD-NOT-RUN", "sbx-esc-deny")
    expect(out.reason).toBe("completed")

    const results = allToolResults(out)
    const escResult = results.find((c) => c.includes("blocked by the OS sandbox"))
    expect(escResult).toBeDefined()
    // GROUND TRUTH: the denied escalation left the block standing — the original
    // command's stdout NEVER appears (no unsandboxed re-run happened).
    expect(escResult ?? "").not.toContain("SHOULD-NOT-RUN")
    expect((escResult ?? "").toLowerCase()).toContain("declined")
  })

  test("CONTROL: knob OFF (no handler installed) ⇒ the block surfaces as a PLAIN failure, no escalation note", async () => {
    // The wire is a no-op when the knob is off (clears any handler). Through the
    // loop, a sandboxed nonzero exit then surfaces byte-identically — no
    // escalation note, and the original command never runs unsandboxed. This
    // proves the APPROVE test's success is the ESCALATION path, not the bash
    // tool independently retrying.
    maybeWireBashSandboxEscalation(
      { onConfirm: async () => true } as never,
      runtimeConfigFromEnv({}),
    )
    const { out } = await runOnce("echo never-unsandboxed", "sbx-esc-off")
    expect(out.reason).toBe("completed")
    const results = allToolResults(out)
    const anyEsc = results.some((c) => c.includes("blocked by the OS sandbox"))
    expect(anyEsc).toBe(false)
    expect(results.some((c) => c.includes("never-unsandboxed"))).toBe(false)
  })
})
