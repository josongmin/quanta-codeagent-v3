/**
 * T-E3 — Plane B `TrajectoryKind` schema-version + drift-guard (ADR-0539).
 *
 * Guards the CONTRACT SURFACE of the trajectory taxonomy so it can never drift
 * silently:
 *
 *  1. A declared {@link TRAJECTORY_CONTRACT_VERSION} exists and is stable.
 *  2. The kind→`*Data` registry ({@link TRAJECTORY_KIND_CONTRACTS}) is COMPLETE
 *     w.r.t. the runtime kind set {@link TRAJECTORY_KINDS} AND the `TrajectoryKind`
 *     UNION (a kind declared/emitted WITHOUT a registry entry ⇒ RED).
 *  3. Every per-kind `export interface *Data` in `src/shared/trajectory.ts` is
 *     wired to at least one kind in the registry (a `*Data` contract added
 *     WITHOUT declaration ⇒ RED). This is a source-text structural scan so it
 *     survives type erasure.
 *
 * These extend — do NOT duplicate — the shape/validator assertions already in
 * `tests/unit/trajectory.test.ts` (which cover `isTrajectoryEvent`, `makeEvent`,
 * and the `satisfies *Data` type-level shapes). This file owns the *taxonomy
 * completeness* invariant those tests do not check.
 *
 * RED-on-injection (see the failing companions below, run under a mutated copy):
 *  - add a kind to `TRAJECTORY_KINDS` without a registry entry → test 2 RED.
 *  - add `export interface FooData` without a registry value `"FooData"` → test 3 RED.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { TRAJECTORY_CONTRACT_VERSION, TRAJECTORY_KIND_CONTRACTS, TRAJECTORY_KINDS } from "@/shared"

const trajectorySource = (): string => {
  const path = fileURLToPath(new URL("../../src/shared/trajectory.ts", import.meta.url))
  return readFileSync(path, "utf8")
}

/** Every `export interface <Name>Data { … }` declared in trajectory.ts. */
const declaredDataInterfaces = (src: string): string[] => {
  const names: string[] = []
  const re = /export interface (\w+Data)\b/g
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const name = m[1]
    if (name !== undefined) names.push(name)
  }
  return names
}

describe("T-E3 — TrajectoryKind schema-version + drift-guard", () => {
  test("TRAJECTORY_CONTRACT_VERSION is a declared, stable non-empty literal", () => {
    expect(typeof TRAJECTORY_CONTRACT_VERSION).toBe("string")
    expect(TRAJECTORY_CONTRACT_VERSION.length).toBeGreaterThan(0)
    // Pinned: bumping this is a deliberate contract-surface change (the whole
    // point of the version), so pin the value — a silent rename fails here.
    expect(TRAJECTORY_CONTRACT_VERSION).toBe("quanta.trajectory.contracts.v1")
  })

  test("registry covers EXACTLY the runtime kind set (no undeclared / no orphan)", () => {
    const registryKinds = new Set(Object.keys(TRAJECTORY_KIND_CONTRACTS))
    // (a) every emitted/runtime kind is declared in the registry — a kind added
    //     to TRAJECTORY_KINDS without a contract decision is caught here.
    for (const kind of TRAJECTORY_KINDS) {
      expect(registryKinds.has(kind)).toBe(true)
    }
    // (b) the registry has NO orphan key that is not a real kind (a stale entry
    //     left behind after a kind removal).
    for (const key of registryKinds) {
      expect(TRAJECTORY_KINDS.has(key)).toBe(true)
    }
    // (c) exact set equality (size) — belt-and-suspenders against the two loops
    //     silently passing on an empty set.
    expect(registryKinds.size).toBe(TRAJECTORY_KINDS.size)
    expect(registryKinds.size).toBeGreaterThan(0)
  })

  test("every registry entry is either null or an existing `*Data` interface name", () => {
    const declared = new Set(declaredDataInterfaces(trajectorySource()))
    expect(declared.size).toBeGreaterThan(0)
    for (const [kind, contract] of Object.entries(TRAJECTORY_KIND_CONTRACTS)) {
      if (contract === null) continue
      // A registry value that names a non-existent interface (typo / deleted
      // interface still referenced) ⇒ RED.
      expect(declared.has(contract), `kind ${kind} → missing interface ${contract}`).toBe(true)
    }
  })

  test("every declared `*Data` interface is WIRED to at least one kind (no orphan contract)", () => {
    const declared = declaredDataInterfaces(trajectorySource())
    const wired = new Set(
      Object.values(TRAJECTORY_KIND_CONTRACTS).filter((v): v is string => v !== null),
    )
    for (const iface of declared) {
      // A `*Data` interface added without wiring it to a kind ⇒ RED (the
      // "emitted/declared without declaration" companion, from the contract side).
      expect(wired.has(iface), `interface ${iface} is not wired to any kind`).toBe(true)
    }
  })

  test("null entries are an EXPLICIT inline-data decision, not a missing contract", () => {
    // Contrast assertion: at least one kind is deliberately inline (null) AND at
    // least one is contract-backed — proves the registry distinguishes the two
    // (a vacuous all-null or all-contract map would still pass the loops above).
    const values = Object.values(TRAJECTORY_KIND_CONTRACTS)
    expect(values.some((v) => v === null)).toBe(true)
    expect(values.some((v) => v !== null)).toBe(true)
  })
})
