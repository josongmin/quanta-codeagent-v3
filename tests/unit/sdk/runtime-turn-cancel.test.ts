/**
 * S1 (jul-16 SDK ticket 01, S0-2 ruling) — the `turn.cancel` verb on
 * RuntimeSession: the ONE sanctioned additive surface change. The command has
 * existed in the protocol union + kernel scheduler all along; the verb is pure
 * dispatch delegation. These tests prove the delegation END-TO-END against the
 * real kernel (no dispatch spy): a mid-flight `session.turn.cancel()` aborts
 * the SAME AbortSignal the in-flight host turn observes.
 */
import { describe, expect, test } from "bun:test"
import type { AgentOutcome } from "@/agent"
import { createSingleSessionRuntimeHost } from "@/host/runtime"
import { createRuntime } from "@/sdk/runtime"

const manifest = {
  approvals: "none" as const,
  tools: false,
  memory: false,
  artifacts: false,
  subagents: false,
  automation: false,
  shellSnapshot: false,
  transport: "inproc" as const,
}

describe("RuntimeSession turn.cancel verb", () => {
  test("cancel mid-flight aborts the signal the host turn observes (real kernel delegation)", async () => {
    let turnEntered: (() => void) | undefined
    const turnEnteredGate = new Promise<void>((resolve) => {
      turnEntered = resolve
    })
    let observedAbort = false

    const runtime = await createRuntime({
      host: createSingleSessionRuntimeHost(() => ({
        describe: () => ({
          sessionId: "cancel-session",
          permissionMode: "default",
          capabilityManifest: manifest,
        }),
        runTurn: async ({ signal }: { signal?: AbortSignal }) =>
          new Promise<{ outcome: AgentOutcome; messages: [] }>((resolve) => {
            const settle = () => {
              observedAbort = signal?.aborted === true
              resolve({
                outcome: { reason: "aborted", turns: 1, messages: [] } as AgentOutcome,
                messages: [],
              })
            }
            if (signal?.aborted === true) {
              settle()
              return
            }
            // Park until the CONCURRENT turn.cancel aborts us — the only exit.
            signal?.addEventListener("abort", settle, { once: true })
            turnEntered?.()
          }),
        close: async () => undefined,
      })),
    })
    const session = await runtime.createSession({ cwd: "/tmp", permissionMode: "default" })

    await session.input.append("long running thing")
    const running = session.turn.run()
    await turnEnteredGate

    // The new verb — dispatch delegation into the kernel's cancel registry.
    const cancelResult = await session.turn.cancel({ commandId: "cancel-cmd-1" })
    expect(cancelResult.revision).toBeGreaterThan(0)

    // The parked turn only resolves because the cancel aborted ITS signal.
    await running
    expect(observedAbort).toBe(true)

    await session.close()
    await runtime.close()
  })

  test("cancel on an IDLE session is a clean no-op dispatch (resolves, no throw, state intact)", async () => {
    const runtime = await createRuntime({
      host: createSingleSessionRuntimeHost(() => ({
        describe: () => ({
          sessionId: "idle-cancel-session",
          permissionMode: "default",
          capabilityManifest: manifest,
        }),
        runTurn: async () => ({
          outcome: { reason: "completed", turns: 1, messages: [] } as AgentOutcome,
          messages: [],
        }),
        close: async () => undefined,
      })),
    })
    const session = await runtime.createSession({ cwd: "/tmp", permissionMode: "default" })

    const before = await session.snapshot()
    const result = await session.turn.cancel()
    expect(result.revision).toBe(before.revision)
    expect((await session.snapshot()).state.status).toBe("idle")

    await session.close()
    await runtime.close()
  })
})
