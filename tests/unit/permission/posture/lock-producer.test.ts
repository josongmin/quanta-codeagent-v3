/**
 * RFC-05 E1 hellgate — CLOSED PRODUCER-BACKED LOCKS.
 *
 * RED rail (c): a producer-free lock label can be constructed.
 *
 * Two enforcement dimensions, both runtime-testable:
 *   1. `admitLock` fails closed for an unadmitted producer (defends against a
 *      cast that fabricates a producer-free reason).
 *   2. `isPostureLock` rejects a hand-built object literal (which cannot carry
 *      the private brand) — a producer-free "lock" is not a genuine lock.
 *
 * Non-vacuity: the `managed_policy` producer is present AND its removal (no
 * managed policy) removes the lock.
 */

import { describe, expect, test } from "bun:test"
import type { ControlPolicy } from "../../../../src/permission/permission-profile"
import {
  admitLock,
  isPostureLock,
  type LockProducerId,
  managedPolicyLock,
  type PostureLock,
  resolveLocks,
  UnadmittedLockProducerError,
} from "../../../../src/permission/posture/availability"

const ADMIN: ControlPolicy = { managedBy: "admin", auditRequired: true }
const TEAM: ControlPolicy = { managedBy: "team", auditRequired: false }
const USER: ControlPolicy = { managedBy: "user", auditRequired: false }

describe("admitLock — fails closed for a producer-free / unadmitted producer (RED rail c)", () => {
  test("throws UnadmittedLockProducerError for a cast-in producer-free id", () => {
    // A surface trying to synthesize Codex's `disabledByConfig` / cloud label
    // has no admitted producer for it. Even a cast must be rejected at runtime.
    expect(() => admitLock("disabledByConfig" as LockProducerId, "Disabled in config")).toThrow(
      UnadmittedLockProducerError,
    )
    expect(() => admitLock("unavailableForCloudWork" as LockProducerId, "Cloud")).toThrow(
      UnadmittedLockProducerError,
    )
    expect(() => admitLock("serverDefault" as LockProducerId, "Server")).toThrow(
      UnadmittedLockProducerError,
    )
  })

  test("mints a genuine lock for the admitted producer", () => {
    const lock = admitLock("managed_policy", "Managed by enterprise policy")
    expect(isPostureLock(lock)).toBe(true)
    expect(lock.reason).toBe("managed_policy")
    expect(lock.producer).toBe("managed_policy")
  })
})

describe("isPostureLock — a hand-built literal is not a genuine lock (RED rail c)", () => {
  test("rejects a producer-free object literal masquerading as a lock", () => {
    const fake = { reason: "disabledByConfig", producer: "config", label: "Disabled in config" }
    expect(isPostureLock(fake)).toBe(false)
  })

  test("rejects an empty object and non-records", () => {
    expect(isPostureLock({})).toBe(false)
    expect(isPostureLock(null)).toBe(false)
    expect(isPostureLock("managed_policy")).toBe(false)
  })

  test("accepts a genuinely-minted producer lock", () => {
    expect(isPostureLock(managedPolicyLock(ADMIN))).toBe(true)
  })
})

describe("PostureLock is nominally UNconstructible outside its module (compile-time)", () => {
  test("a producer-free object literal cannot satisfy PostureLock (validated by tsc)", () => {
    // The lock brand is a module-private `unique symbol`; external code cannot
    // name the key, so an object literal can never satisfy `PostureLock`. If the
    // nominal guard regressed, the `@ts-expect-error` would become unused and
    // `bun run typecheck:tests` would FAIL — a compile-time RED-on-injection.
    // @ts-expect-error — missing the private [LOCK_BRAND] key; unconstructible.
    const forged: PostureLock = { reason: "managed_policy", producer: "managed_policy", label: "x" }
    // The value is a runtime fake (not brand-carrying) -> the runtime guard also
    // rejects it, proving the two dimensions agree.
    expect(isPostureLock(forged)).toBe(false)
  })
})

describe("managed_policy producer — present and non-vacuous", () => {
  test("emits a lock for enterprise-managed policy (admin/team)", () => {
    const adminLock = managedPolicyLock(ADMIN)
    const teamLock = managedPolicyLock(TEAM)
    expect(adminLock).not.toBeNull()
    expect(teamLock).not.toBeNull()
    expect(adminLock?.reason).toBe("managed_policy")
    expect(isPostureLock(adminLock)).toBe(true)
  })

  test("REMOVING the managed policy removes the lock (non-vacuous)", () => {
    expect(managedPolicyLock(USER)).toBeNull()
    expect(managedPolicyLock(undefined)).toBeNull()
    expect(resolveLocks(USER)).toEqual([])
    expect(resolveLocks(undefined)).toEqual([])
  })

  test("resolveLocks surfaces exactly the managed lock when present", () => {
    const locks = resolveLocks(ADMIN)
    expect(locks.length).toBe(1)
    expect(locks[0]?.reason).toBe("managed_policy")
    expect(locks.every(isPostureLock)).toBe(true)
  })
})

describe("every minted lock carries an admitted producer + closed reason", () => {
  test("no lock ever exposes a producer-free reason", () => {
    const locks = [...resolveLocks(ADMIN), ...resolveLocks(TEAM)]
    for (const lock of locks) {
      expect(lock.reason).toBe("managed_policy")
      expect(lock.producer).toBe("managed_policy")
    }
  })
})
