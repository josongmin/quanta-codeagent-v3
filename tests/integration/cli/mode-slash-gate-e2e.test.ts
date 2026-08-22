import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModeCycleStore, MODE_CYCLE } from "@/apps/cli/mode-cycle"
import { runSlashCommand } from "@/apps/cli/slash-commands"
import type { SlashContext } from "@/apps/cli/slash-contract"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import {
  buildPostureAuthority,
  createPermissionModeAdapter,
  createSeededPosturePersistence,
} from "@/runner/assemble/session-authorities"
import { createRuntimeFromAgentConfigBase } from "@/sdk/runtime"
import { defaultTools, ToolRegistry } from "@/tool"
import { RecordingStream } from "../_harness"

/**
 * #13 — `/mode` END-TO-END behavioral proof (the full chain a user drives).
 *
 * The sibling `mode-cycle-permission-live-e2e` proves a RAW
 * `permissionModeState.set()` flips the gate. THIS test closes the remaining
 * gap: that the USER-FACING `/mode bypass` SLASH does it — the slash mutates the
 * shared `ModeCycleStore`, the session loop's per-turn projection
 * (`permissionModeState.set(store.current().permissionMode)`) carries the
 * posture to the engine cell, and the admissibility gate then auto-allows the
 * write. So: slash → store → projection → real gate decision → real file effect.
 * Lives under tests/integration/cli/ (the fence-allowed path that may import
 * @/apps/cli).
 */

const root = mkdtempSync(join(tmpdir(), "mode-slash-gate-"))

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

const writePatch = (file: string): string =>
  ["*** Begin Patch", `*** Update File: ${file}`, "@@", "-beta", "+BETA", "*** End Patch"].join(
    "\n",
  )

class PatchEachTurnLLM implements LLMPort {
  readonly model = "mode-slash-gate-model"
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

describe("#13 — /mode slash drives the live permission gate (e2e)", () => {
  test("/mode bypass slash → store → per-turn projection → gate auto-allows the write", async () => {
    const cwd = makeWorkspace("slash-live")
    const permissionModeState = createPermissionModeAdapter(
      buildPostureAuthority({
        threadId: "session",
        persistence: createSeededPosturePersistence("session", "default"),
        reviewerAvailability: { hasAutoReview: false, hasGuardianReview: false },
      }),
    )
    const permission: PermissionContext = {
      get mode() {
        return permissionModeState.get()
      },
      set mode(next) {
        permissionModeState.set(next)
      },
    }
    // The surface-owned mode-cycle store + the EXACT `/mode` ctx adapter shape
    // surface-compose builds (get/set over MODE_CYCLE).
    const store = createModeCycleStore()
    const modeCtx: SlashContext = {
      out: () => undefined,
      err: () => undefined,
      cwd,
      mode: {
        get: () => store.current().key,
        set: (key: string) => {
          const known = MODE_CYCLE.map((p) => p.key)
          if (!known.includes(key as (typeof known)[number])) {
            return { kind: "unknown" as const, known }
          }
          store.set(key as (typeof known)[number])
          return "ok" as const
        },
        list: () => MODE_CYCLE.map((p) => p.key),
      },
    }
    // The session loop's per-turn `beforeTurn` projection, replicated verbatim
    // (the source-match test pins that session-loop.ts runs exactly this line).
    const projectPosture = async (): Promise<void> => {
      permissionModeState.set(store.current().permissionMode)
      // The delegating set lands on the next durable publish; flush it so the
      // next turn's gate reads the projected posture live.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    let confirmCalls = 0
    const { runtime } = await createRuntimeFromAgentConfigBase({
      base: {
        llm: new PatchEachTurnLLM(),
        registry: new ToolRegistry(defaultTools),
        stream: new RecordingStream(),
        permission,
        permissionModeState,
        messages: [],
        system: "test",
        cwd,
        maxTurns: 3,
        signal: new AbortController().signal,
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
      // Turn 1 — default posture: project, run, the write is gated + denied.
      await projectPosture()
      await session.input.append("patch it")
      await session.turn.run()
      expect(confirmCalls).toBeGreaterThan(0)
      expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("alpha\nbeta\n")

      // User types `/mode bypass` — the SLASH mutates the shared store.
      const confirmsBefore = confirmCalls
      const code = await runSlashCommand("/mode bypass", modeCtx)
      expect(code).toBe(0)
      expect(store.current().permissionMode).toBe("bypass")

      // Turn 2 — the loop projects the store's posture, the gate auto-allows.
      await projectPosture()
      await session.input.append("patch it again")
      await session.turn.run()
      expect(confirmCalls).toBe(confirmsBefore) // no approval prompt under bypass
      expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("alpha\nBETA\n")
    } finally {
      await session.close()
      await runtime.close()
    }
  })
})
