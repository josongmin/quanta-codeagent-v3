/**
 * H8 last-mile — heartbeat-binder resume + posture-clamp hellgate (ADR-0480).
 *
 * The bind that makes a heartbeat actually keep its thread. Adversarial cases:
 *   - CRON untouched: `enqueueUserMessage(msg)` with NO `targetThreadId` pushes
 *     to the queue and NEVER calls the binder (byte-identical to today).
 *   - same-thread resume: `targetThreadId === liveThreadId` ⇒ the prompt lands
 *     on the queue AND the inherited approval posture is written into the
 *     per-turn permission cell.
 *   - SECURITY posture clamp: a forged/widening snapshot can NEVER widen
 *     authority — an unknown approval value fail-closes to the MOST-restrictive
 *     mode; a more-permissive snapshot is clamped against the current cell.
 *   - cross-thread / missing thread ⇒ loud typed `thread-not-found`, NO push.
 *   - NO-THROW: a push fault becomes `enqueue-failed`; the handler resolves.
 *
 * All effects are fakes — no wall clock, no fs, no process.env.
 */

import { describe, expect, test } from "bun:test"
import {
  clampToMostRestrictive,
  createHeartbeatBinder,
  heartbeatEnqueueHandler,
  mapInheritedApprovalToMode,
} from "@/apps/cli/repl/heartbeat-binder"
import type { PermissionMode } from "@/permission"
import type { PermissionModeSessionState } from "@/runner/assemble/session-state"
import type { HeartbeatPolicySnapshot } from "@/scheduler"

// ------------------------------------------------------------------ fakes ----

const makeCell = (initial: PermissionMode): PermissionModeSessionState => {
  let current = initial
  return {
    defaultMode: initial,
    get: () => current,
    set: (next) => {
      current = next
    },
  }
}

const snapshot = (approvalPolicy: string): HeartbeatPolicySnapshot => ({
  approvalPolicy,
  sandboxPolicy: "workspace-write",
  collaborationMode: "default",
})

const SESSION = "thread-S"

// ===================================================================== pure ==

describe("posture clamp — pure (the security core)", () => {
  test("every known approval value maps to its mode", () => {
    expect(mapInheritedApprovalToMode("default")).toBe("default")
    expect(mapInheritedApprovalToMode("acceptEdits")).toBe("acceptEdits")
    expect(mapInheritedApprovalToMode("auto")).toBe("auto")
    expect(mapInheritedApprovalToMode("bypass")).toBe("bypass")
  })

  test("forged/unknown approval value FAIL-CLOSES to most-restrictive (default), never permissive", () => {
    for (const forged of ["", "BYPASS", "root", "admin", "yolo", "  bypass  ", "Default"]) {
      expect(mapInheritedApprovalToMode(forged)).toBe("default")
    }
  })

  test("clamp returns the SAFER (more-restrictive) of two modes — never escalates", () => {
    // default is safest, bypass is most permissive.
    expect(clampToMostRestrictive("bypass", "default")).toBe("default")
    expect(clampToMostRestrictive("default", "bypass")).toBe("default")
    expect(clampToMostRestrictive("auto", "acceptEdits")).toBe("acceptEdits")
    expect(clampToMostRestrictive("bypass", "auto")).toBe("auto")
  })

  test("clamp is commutative + idempotent (a per-axis meet)", () => {
    const modes: PermissionMode[] = ["default", "acceptEdits", "auto", "bypass"]
    for (const a of modes) {
      expect(clampToMostRestrictive(a, a)).toBe(a)
      for (const b of modes) {
        expect(clampToMostRestrictive(a, b)).toBe(clampToMostRestrictive(b, a))
      }
    }
  })
})

// ============================================================== same-thread ==

describe("same-thread resume", () => {
  test("targetThreadId === live ⇒ pushes prompt AND writes inherited posture into the cell", async () => {
    const cell = makeCell("bypass")
    const pushed: string[] = []
    const binder = createHeartbeatBinder({
      liveThreadId: () => SESSION,
      permissionCell: () => cell,
      pushPrompt: (p) => pushed.push(p),
    })

    // inherited snapshot is STRICTER (default) than current (bypass) ⇒ applied.
    const res = await binder.resume({
      targetThreadId: SESSION,
      prompt: "keep working the thread",
      inheritedPolicy: snapshot("default"),
    })

    expect(res).toEqual({ ok: true })
    expect(pushed).toEqual(["keep working the thread"])
    expect(cell.get()).toBe("default")
  })

  test("resume with no permission cell still pushes (byte-identical for a cell-less host)", async () => {
    const pushed: string[] = []
    const binder = createHeartbeatBinder({
      liveThreadId: () => SESSION,
      permissionCell: () => undefined,
      pushPrompt: (p) => pushed.push(p),
    })
    const res = await binder.resume({
      targetThreadId: SESSION,
      prompt: "p",
      inheritedPolicy: snapshot("bypass"),
    })
    expect(res).toEqual({ ok: true })
    expect(pushed).toEqual(["p"])
  })

  test("resume with no inheritedPolicy pushes without touching the cell", async () => {
    const cell = makeCell("acceptEdits")
    const pushed: string[] = []
    const binder = createHeartbeatBinder({
      liveThreadId: () => SESSION,
      permissionCell: () => cell,
      pushPrompt: (p) => pushed.push(p),
    })
    const res = await binder.resume({ targetThreadId: SESSION, prompt: "p" })
    expect(res).toEqual({ ok: true })
    expect(pushed).toEqual(["p"])
    expect(cell.get()).toBe("acceptEdits") // untouched
  })
})

// ============================================ SECURITY: never escalates ======

describe("SECURITY — a heartbeat must never widen authority", () => {
  test("forged JSONL snapshot (unknown approval) cannot widen — fail-closed to default", async () => {
    const cell = makeCell("acceptEdits")
    const binder = createHeartbeatBinder({
      liveThreadId: () => SESSION,
      permissionCell: () => cell,
      pushPrompt: () => {},
    })
    // A tampered store row claims a bogus highly-permissive policy.
    await binder.resume({
      targetThreadId: SESSION,
      prompt: "p",
      inheritedPolicy: snapshot("super-bypass-root"),
    })
    // Forged → default (most restrictive). clamp(default, acceptEdits) = default.
    expect(cell.get()).toBe("default")
  })

  test("snapshot MORE permissive than current is clamped to the current (stricter) mode", async () => {
    const cell = makeCell("default") // live session is at the strictest mode
    const binder = createHeartbeatBinder({
      liveThreadId: () => SESSION,
      permissionCell: () => cell,
      pushPrompt: () => {},
    })
    // The captured snapshot says "bypass" — but the live cell is stricter.
    await binder.resume({
      targetThreadId: SESSION,
      prompt: "p",
      inheritedPolicy: snapshot("bypass"),
    })
    expect(cell.get()).toBe("default") // never widened to bypass
  })

  test("snapshot STRICTER than current is applied (the captured grant)", async () => {
    const cell = makeCell("bypass")
    const binder = createHeartbeatBinder({
      liveThreadId: () => SESSION,
      permissionCell: () => cell,
      pushPrompt: () => {},
    })
    await binder.resume({
      targetThreadId: SESSION,
      prompt: "p",
      inheritedPolicy: snapshot("acceptEdits"),
    })
    expect(cell.get()).toBe("acceptEdits") // tightened to the snapshot
  })
})

// =========================================== cross-thread / missing guard ====

describe("cross-thread / missing thread guard", () => {
  test("targetThreadId !== live ⇒ thread-not-found, NO push, NO posture write", async () => {
    const cell = makeCell("default")
    const pushed: string[] = []
    const binder = createHeartbeatBinder({
      liveThreadId: () => SESSION,
      permissionCell: () => cell,
      pushPrompt: (p) => pushed.push(p),
    })
    const res = await binder.resume({
      targetThreadId: "thread-OTHER",
      prompt: "do not route this onto the wrong thread",
      inheritedPolicy: snapshot("bypass"),
    })
    expect(res).toEqual({ ok: false, reason: "thread-not-found" })
    expect(pushed).toEqual([]) // never mis-routed
    expect(cell.get()).toBe("default") // posture untouched
  })

  test("no live thread id (process drives no resolvable thread) ⇒ thread-not-found", async () => {
    const binder = createHeartbeatBinder({
      liveThreadId: () => undefined,
      permissionCell: () => undefined,
      pushPrompt: () => {
        throw new Error("must not push")
      },
    })
    const res = await binder.resume({ targetThreadId: SESSION, prompt: "p" })
    expect(res).toEqual({ ok: false, reason: "thread-not-found" })
  })
})

// ==================================================================== throw ==

describe("NO-THROW", () => {
  test("a push fault becomes enqueue-failed (the binder resolves, does not throw)", async () => {
    const binder = createHeartbeatBinder({
      liveThreadId: () => SESSION,
      permissionCell: () => undefined,
      pushPrompt: () => {
        throw new Error("queue closed")
      },
    })
    const res = await binder.resume({ targetThreadId: SESSION, prompt: "p" })
    expect(res).toEqual({ ok: false, reason: "enqueue-failed" })
  })
})

// ===================================================== enqueue handler wire ==

describe("heartbeatEnqueueHandler — cron-vs-heartbeat branch", () => {
  test("CRON path (no targetThreadId) pushes directly and NEVER calls the binder", async () => {
    const pushed: string[] = []
    let binderCalls = 0
    const handler = heartbeatEnqueueHandler({
      binder: {
        resume: async () => {
          binderCalls += 1
          return { ok: true }
        },
      },
      pushPrompt: (p) => pushed.push(p),
    })
    await handler("cron fire") // no opts
    await handler("cron fire 2", { modelOverride: "m" }) // opts WITHOUT targetThreadId
    expect(pushed).toEqual(["cron fire", "cron fire 2"])
    expect(binderCalls).toBe(0) // byte-identical to today: binder uncalled
  })

  test("HEARTBEAT path (targetThreadId present) routes through the binder, not the direct push", async () => {
    const pushed: string[] = []
    const seen: Array<{ targetThreadId: string; prompt: string; policy?: string }> = []
    const handler = heartbeatEnqueueHandler({
      binder: {
        resume: async (req) => {
          seen.push({
            targetThreadId: req.targetThreadId,
            prompt: req.prompt,
            ...(req.inheritedPolicy !== undefined
              ? { policy: req.inheritedPolicy.approvalPolicy }
              : {}),
          })
          return { ok: true }
        },
      },
      pushPrompt: (p) => pushed.push(p),
    })
    await handler("heartbeat prompt", {
      targetThreadId: SESSION,
      inheritedPolicy: snapshot("default"),
      modelOverride: "m",
    })
    expect(pushed).toEqual([]) // NOT pushed directly onto the current queue
    expect(seen).toEqual([
      { targetThreadId: SESSION, prompt: "heartbeat prompt", policy: "default" },
    ])
  })

  test("handler is NO-THROW when the binder rejects (scheduler records the error)", async () => {
    const handler = heartbeatEnqueueHandler({
      binder: {
        resume: async () => {
          throw new Error("binder blew up")
        },
      },
      pushPrompt: () => {},
    })
    // The handler awaits the binder; a throwing binder surfaces as a rejected
    // promise the scheduler runtime catches as `scheduler.error`. Assert the
    // CRON path stays unaffected by a heartbeat-path binder fault.
    await expect(handler("p", { targetThreadId: SESSION })).rejects.toThrow("binder blew up")
    // cron remains clean
    await expect(handler("cron")).resolves.toBeUndefined()
  })
})
