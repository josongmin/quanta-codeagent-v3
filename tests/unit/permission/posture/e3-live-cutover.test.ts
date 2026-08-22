/**
 * RFC-05 E3 — behavior-live cutover: the posture AUTHORITY is the mode SSOT.
 *
 * These owner-local rails pin the two behavioral REDs of the cutover (the third,
 * the direct-writer completeness ratchet, is `e3-direct-writer-ratchet.test.ts`):
 *
 *   (RED rail a) a permission-mode write goes THROUGH the posture revision. The
 *   delegating adapter's `set` advances the authority revision and the live
 *   `read()` view — a mode change is a posture mutation, not an out-of-band cell
 *   poke. RED before the cutover: the mode write hit a bare `let current` cell
 *   with no revision at all.
 *
 *   (RED rail b) a FRESH runtime AGREES with the restored posture view. Building
 *   a new authority over the same durable persistence reconstructs the last
 *   effective mode without any event replay — fresh-runtime behavior equals the
 *   restored view. A managed-policy change on that resume takes effect.
 *
 * Every invariant carries a red-on-injection note so the rail is non-vacuous.
 */

import { describe, expect, test } from "bun:test"
import type { ControlPolicy } from "../../../../src/permission/permission-profile"
import { createPostureAuthority } from "../../../../src/permission/posture/authority"
import type {
  PosturePersistedRecord,
  PosturePersistencePort,
} from "../../../../src/permission/posture/ports"
import type { PostureRecord, ReviewerAvailability } from "../../../../src/permission/posture/types"
import {
  buildPostureAuthority,
  buildThreadPostureBinding,
  createInMemoryPosturePersistence,
  createPermissionModeAdapter,
  createSeededPosturePersistence,
  deriveManagedMode,
} from "../../../../src/runner/assemble/session-authorities/build-posture"

const AVAIL: ReviewerAvailability = { hasAutoReview: false, hasGuardianReview: false }

/** Drain the adapter's fire-and-forget delegating write chain (a real surface
 *  writes mode before a turn; the durable publish + revision bump land across the
 *  authority's serialized persist hops). A macrotask boundary flushes the entire
 *  cascading microtask queue the chain schedules. */
const drain = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("RFC-05 E3 — RED rail a: a mode write flows through the posture revision", () => {
  test("the delegating adapter advances the authority revision + live view on set", async () => {
    const authority = buildPostureAuthority({
      threadId: "live",
      persistence: createSeededPosturePersistence("live", "default"),
      reviewerAvailability: AVAIL,
    })
    const adapter = createPermissionModeAdapter(authority)
    // Seeded from `default` (current behavior) at revision 0.
    expect(adapter.get()).toBe("default")
    expect(authority.read().revision).toBe(0)

    adapter.set("bypass")
    await drain()

    // RED-ON-INJECTION: make `createPermissionModeAdapter.set` write a local cell
    // instead of delegating to `authority.set` ⇒ revision stays 0 ⇒ RED.
    expect(authority.read().revision).toBe(1)
    // The gate getter reads the NEW mode live off the authority — not a snapshot.
    expect(adapter.get()).toBe("bypass")
    expect(authority.read().effective.effectiveMode).toBe("bypass")
  })

  test("successive sets each land on the current revision (serialized, none dropped)", async () => {
    const authority = buildPostureAuthority({
      threadId: "live",
      persistence: createSeededPosturePersistence("live", "default"),
      reviewerAvailability: AVAIL,
    })
    const adapter = createPermissionModeAdapter(authority)
    adapter.set("acceptEdits")
    adapter.set("bypass")
    adapter.set("auto")
    await drain()
    // RED-ON-INJECTION: read a STALE revision at call time (not inside the chained
    // continuation) ⇒ later sets stale-reject ⇒ mode is not "auto" / revision < 3.
    expect(adapter.get()).toBe("auto")
    expect(authority.read().revision).toBe(3)
  })
})

describe("RFC-05 E3 — RED rail b: a fresh runtime agrees with the restored view", () => {
  test("a new authority over the same durable persistence restores the last mode", async () => {
    const persistence = createInMemoryPosturePersistence()
    const first = buildPostureAuthority({
      threadId: "t",
      persistence,
      reviewerAvailability: AVAIL,
    })
    const adapter = createPermissionModeAdapter(first)
    adapter.set("bypass")
    await drain()
    expect(first.read().effective.effectiveMode).toBe("bypass")

    // "Restart": a FRESH authority reads the SAME persistence — no event replay.
    const fresh = buildPostureAuthority({
      threadId: "t",
      persistence,
      reviewerAvailability: AVAIL,
    })
    // RED-ON-INJECTION: build the fresh authority from `runtime.mode`/a new empty
    // port instead of the durable persistence ⇒ this is "default" ⇒ RED.
    expect(fresh.read().effective.effectiveMode).toBe("bypass")
    expect(fresh.read().revision).toBe(1)
  })

  test("a managed-policy change on resume forces the effective mode", async () => {
    const persistence = createInMemoryPosturePersistence()
    const first = buildPostureAuthority({
      threadId: "t",
      persistence,
      reviewerAvailability: AVAIL,
    })
    createPermissionModeAdapter(first).set("bypass")
    await drain()

    // Resume UNDER a managed policy: effectiveMode is forced to the restrictive
    // floor even though the persisted requested mode is `bypass`.
    const managed: { read(): ControlPolicy | undefined } = {
      read: () => ({ managedBy: "admin", auditRequired: true }),
    }
    const resumed = buildPostureAuthority({
      threadId: "t",
      persistence,
      reviewerAvailability: AVAIL,
      managedPolicy: managed,
    })
    // RED-ON-INJECTION: stop deriving managedMode from the policy ⇒ this is
    // "bypass" ⇒ RED.
    expect(resumed.read().effective.effectiveMode).toBe("default")
    // Paired control: resume UNMANAGED ⇒ the persisted `bypass` stands.
    const resumedOpen = buildPostureAuthority({
      threadId: "t",
      persistence,
      reviewerAvailability: AVAIL,
    })
    expect(resumedOpen.read().effective.effectiveMode).toBe("bypass")
  })
})

describe("RFC-05 E3 — managed-mode derivation (restrict-only, deterministic)", () => {
  test("an enterprise-managed policy forces the restrictive floor; user/absent does not", () => {
    expect(deriveManagedMode({ managedBy: "admin", auditRequired: false })).toBe("default")
    expect(deriveManagedMode({ managedBy: "team", auditRequired: false })).toBe("default")
    // RED-ON-INJECTION: force "default" unconditionally ⇒ these two become
    // "default" ⇒ RED (proves the clamp is gated on the managed producer).
    expect(deriveManagedMode({ managedBy: "user", auditRequired: false })).toBeUndefined()
    expect(deriveManagedMode(undefined)).toBeUndefined()
  })
})

describe("RFC-05 E3 — defaults are COPIED at thread creation (thread-copy boundary)", () => {
  test("two threads created across a default change retain distinct modes after restart", async () => {
    const persistence = createInMemoryPosturePersistence()
    let currentDefault: PostureRecord = {
      threadPermission: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "read-only" },
      },
      askOutsidePlan: true,
      mode: "acceptEdits",
    }
    const defaults = {
      readDefault: () => currentDefault,
      writeDefault: async () => undefined,
    }

    // Thread A is created while the default mode is `acceptEdits`.
    const a = await buildThreadPostureBinding({
      threadId: "A",
      persistence,
      defaults,
      reviewerAvailability: AVAIL,
    })
    expect(a.read().effective.effectiveMode).toBe("acceptEdits")

    // The future-thread default changes to `bypass`...
    currentDefault = { ...currentDefault, mode: "bypass" }

    // ...thread B copies the NEW default; thread A is unaffected.
    const b = await buildThreadPostureBinding({
      threadId: "B",
      persistence,
      defaults,
      reviewerAvailability: AVAIL,
    })
    expect(b.read().effective.effectiveMode).toBe("bypass")

    // RESTART both: a fresh authority per thread restores each thread's OWN
    // copied value — the default change never reached back into A.
    const aRestart = buildPostureAuthority({
      threadId: "A",
      persistence,
      reviewerAvailability: AVAIL,
    })
    const bRestart = buildPostureAuthority({
      threadId: "B",
      persistence,
      reviewerAvailability: AVAIL,
    })
    // RED-ON-INJECTION: LAZY-read the default at construction instead of COPYING
    // it ⇒ A restores `bypass` ⇒ RED.
    expect(aRestart.read().effective.effectiveMode).toBe("acceptEdits")
    expect(bRestart.read().effective.effectiveMode).toBe("bypass")
  })
})

/** Direct authority construction is exercised elsewhere; this import keeps the
 *  seeded-port helper honest against the raw authority contract. */
const _portContract: (rec?: PosturePersistedRecord) => PosturePersistencePort = () =>
  createInMemoryPosturePersistence()
void _portContract
void createPostureAuthority
