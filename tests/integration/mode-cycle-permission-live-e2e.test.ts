import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { createPermissionModeSessionState } from "@/runner/assemble"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import { defaultTools, ToolRegistry } from "@/tool"
import { RecordingStream } from "./_harness"

/**
 * ADR-0303 — END-TO-END proof that the engine-owned permission posture is read
 * LIVE by the admissibility gate on the NEXT turn (not only the next session).
 *
 * This drives a REAL runtime turn through the shared interactive turn-assembler
 * (the same path `apps/agent` + `apps/web-daemon` use). It mirrors exactly what
 * `bootstrap-session.ts` constructs: an accessor-backed `permission.mode` over a
 * `PermissionModeSessionState`. The test holds that cell directly, flips it
 * mid-session, and asserts the gate's decision on the very next turn changes —
 * closing the gap that the isolated unit hellgate could not (the real per-turn
 * base → gate threading).
 */

const root = mkdtempSync(join(tmpdir(), "mode-cycle-perm-live-"))

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

const writePatch = (file: string): string =>
  ["*** Begin Patch", `*** Update File: ${file}`, "@@", "-beta", "+BETA", "*** End Patch"].join(
    "\n",
  )

const lastUserText = (messages: readonly Message[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== "user") continue
    for (const block of message.content) {
      if (block.type === "text") return block.text
    }
  }
  return ""
}

/** Emits an `apply_patch` (a write — gated under "default", auto-allowed under
 *  "bypass") on every main turn so the permission posture is what decides. */
class PatchEachTurnLLM implements LLMPort {
  readonly model = "perm-live-model"
  private calls = 0
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    yield { type: "tool_use_start", id: `apply-${this.calls}`, name: "apply_patch" }
    yield { type: "tool_use_end", id: `apply-${this.calls}`, input: { patch: writePatch("f.txt") } }
    yield { type: "message_stop", stop_reason: "tool_use" }
  }
}

const makeWorkspace = (name: string): string => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "f.txt"), "alpha\nbeta\n")
  return dir
}

describe("ADR-0303 — permission posture is live per-turn (e2e)", () => {
  test("a mid-session permissionModeState.set() flips the gate decision on the next turn", async () => {
    const cwd = makeWorkspace("live")
    // Mirror bootstrap-session.ts: accessor-backed permission over the engine cell.
    const permissionModeState = createPermissionModeSessionState({ defaultMode: "default" })
    const permission: PermissionContext = {
      get mode() {
        return permissionModeState.get()
      },
      set mode(next) {
        permissionModeState.set(next)
      },
    }
    let confirmCalls = 0
    const { runtime } = await createRuntimeFromAgentConfigBase({
      base: {
        llm: new PatchEachTurnLLM(),
        registry: new ToolRegistry(defaultTools),
        stream: new RecordingStream(),
        permission,
        // the engine-owned cell threaded onto the base, exactly as the runtime
        // wires `args.boot.permissionModeState` → snapshot.
        permissionModeState,
        messages: [],
        system: "test",
        cwd,
        maxTurns: 3,
        signal: new AbortController().signal,
        // record-only confirmer that DENIES, so a gated write never applies and
        // the file content is an unambiguous witness of the posture decision.
        onConfirm: async () => {
          confirmCalls += 1
          return { decision: "deny" as const }
        },
      } as Parameters<typeof createRuntimeFromAgentConfigBase>[0]["base"],
      turnAssembler: buildInteractiveTurnAssembler(),
      history: [],
      state: undefined,
      idMeta: undefined,
      shutdown: async () => undefined,
    })
    const session = await runtime.createSession({ cwd, permissionMode: "default" })
    try {
      // Turn 1 — posture "default": the write is gated, the confirmer denies,
      // the file is untouched.
      await session.input.append("patch it")
      await session.turn.run()
      expect(confirmCalls).toBeGreaterThan(0)
      expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("alpha\nbeta\n")

      // Mid-session shift+tab → engine cell flips to a posture that auto-allows
      // edits. NO new session is created.
      const confirmsBefore = confirmCalls
      permissionModeState.set("bypass")

      // Turn 2 — the SAME session: the gate must read the NEW posture live and
      // apply the write without asking.
      await session.input.append("patch it again")
      await session.turn.run()
      expect(confirmCalls).toBe(confirmsBefore) // no further approval prompts
      expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("alpha\nBETA\n")
    } finally {
      await session.close()
      await runtime.close()
    }
  })
})
