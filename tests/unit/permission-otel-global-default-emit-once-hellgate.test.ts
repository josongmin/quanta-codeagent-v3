/**
 * HELLGATE — `evaluateStack` global-default fall-through emits the
 * `quanta.permission.decision` counter EXACTLY ONCE (P3 OTel double-count).
 *
 * Defect class
 * ------------
 * `evaluateStack` walks the 5-level precedence stack and, when no axis (post-
 * denial / per-thread / per-host) pins the action and the host is `unpinned`,
 * falls through to the global default by RETURNING `evaluate(action, ctx)`
 * verbatim. `evaluate` itself emits the decision through the shared recorder
 * seam with `stackSource: "global-default"`.
 *
 * The double-count bug appears the moment that fall-through is "helpfully"
 * wrapped in a second emit — e.g. `return emit(evaluate(...), {...})` or a
 * trailing `emitPermissionDecision(...)`. Then a single global-default verdict
 * produces TWO counter increments, so a dashboard over-counts every
 * global-default allow/ask/deny by 2x whenever the permission-stack feature is
 * enabled. This battery pins the invariant: ONE decision ⇒ ONE counter row,
 * with the correct `global-default` source, and the verdict VALUE unchanged.
 *
 * Anti-theater: re-introducing any second emit on the fall-through (or removing
 * the `evaluate` emit and double-emitting in the stack) makes the exact-count
 * assertions fail. Verified by temporary neutralization during development.
 *
 * Source under test:
 *   src/permission/policy.ts — evaluateStack precedence level 5 fall-through.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetPermissionRecorder,
  computeActionSignature,
  createPermissionStore,
  evaluateStack,
  type PermissionDecisionRecord,
  type PermissionRecorder,
  setPermissionRecorder,
} from "@/permission"

afterEach(() => {
  __resetPermissionRecorder()
})

interface Harness {
  store: Awaited<ReturnType<typeof createPermissionStore>> extends never
    ? never
    : ReturnType<typeof createPermissionStore>
  decisions: PermissionDecisionRecord[]
  cleanup: () => Promise<void>
}

const mkHarness = async (): Promise<Harness> => {
  const tmp = await mkdtemp(join(tmpdir(), "quanta-otel-once-"))
  const store = createPermissionStore({ filePath: join(tmp, "state.json"), debounceMs: 0 })
  await store.load()
  const decisions: PermissionDecisionRecord[] = []
  const recorder: PermissionRecorder = {
    onDecision: (r) => {
      decisions.push(r)
    },
    onPostDenialEvent: () => {},
  }
  setPermissionRecorder(recorder)
  return {
    store: store as Harness["store"],
    decisions,
    cleanup: async () => {
      __resetPermissionRecorder()
      await store.flush()
      await rm(tmp, { recursive: true, force: true })
    },
  }
}

/** The fall-through only triggers when EVERY higher precedence axis is silent:
 *  no post-denial override, no per-thread record, host `unpinned`. A brand-new
 *  store + a never-pinned host id satisfies all three. */
const sig = (args: Record<string, unknown>): string =>
  computeActionSignature({ tool: "write", workdir: "/repo", args })

describe("hellgate — global-default fall-through emits exactly once", () => {
  test("mutating action under `default` mode ⇒ exactly ONE 'prompt' counter", async () => {
    const h = await mkHarness()
    try {
      evaluateStack(
        { tool: "write", input: { path: "a.txt" }, isReadOnly: false },
        { mode: "default" },
        {
          threadId: "t1",
          hostId: "host-never-pinned",
          actionSignature: sig({ path: "a.txt" }),
          workdir: "/repo",
        },
        { store: h.store },
      )
      // EXACTLY ONE emit — not two. A double-emit wrapper would push the count
      // to 2 and trip this assertion.
      expect(h.decisions.length).toBe(1)
      const rec = h.decisions[0]
      expect(rec?.outcome).toBe("prompt")
      expect(rec?.stackSource).toBe("global-default")
      // VALUE unchanged: the synchronous fall-through still ASKS on a mutating
      // action under `default`.
      expect(rec?.stackVerdict).toBe("ask")
    } finally {
      await h.cleanup()
    }
  })

  test("mutating action under `bypass` mode ⇒ exactly ONE 'allow' counter", async () => {
    const h = await mkHarness()
    try {
      evaluateStack(
        { tool: "write", input: { path: "b.txt" }, isReadOnly: false },
        { mode: "bypass" },
        {
          threadId: "t2",
          hostId: "host-never-pinned-2",
          actionSignature: sig({ path: "b.txt" }),
          workdir: "/repo",
        },
        { store: h.store },
      )
      expect(h.decisions.length).toBe(1)
      const rec = h.decisions[0]
      expect(rec?.outcome).toBe("allow")
      expect(rec?.stackSource).toBe("global-default")
      expect(rec?.stackVerdict).toBe("allow")
    } finally {
      await h.cleanup()
    }
  })

  test("mutating action under `acceptEdits` mode ⇒ exactly ONE 'allow' counter", async () => {
    const h = await mkHarness()
    try {
      evaluateStack(
        { tool: "edit", input: { path: "c.txt" }, isReadOnly: false },
        { mode: "acceptEdits" },
        {
          threadId: "t3",
          hostId: "host-never-pinned-3",
          actionSignature: computeActionSignature({
            tool: "edit",
            workdir: "/repo",
            args: { path: "c.txt" },
          }),
          workdir: "/repo",
        },
        { store: h.store },
      )
      expect(h.decisions.length).toBe(1)
      expect(h.decisions[0]?.outcome).toBe("allow")
      expect(h.decisions[0]?.stackSource).toBe("global-default")
    } finally {
      await h.cleanup()
    }
  })

  test("aggregate: N fall-through decisions ⇒ exactly N counter rows (no 2x inflation)", async () => {
    const h = await mkHarness()
    try {
      const N = 5
      for (let i = 0; i < N; i++) {
        evaluateStack(
          { tool: "write", input: { path: `f${i}.txt` }, isReadOnly: false },
          { mode: "default" },
          {
            threadId: `thread-${i}`,
            hostId: `host-unpinned-${i}`,
            actionSignature: sig({ path: `f${i}.txt` }),
            workdir: "/repo",
          },
          { store: h.store },
        )
      }
      // The defect would yield 2N. The invariant is exactly N.
      expect(h.decisions.length).toBe(N)
      // Every row is the global-default axis (no spurious second axis emit).
      expect(h.decisions.every((d) => d.stackSource === "global-default")).toBe(true)
    } finally {
      await h.cleanup()
    }
  })
})
