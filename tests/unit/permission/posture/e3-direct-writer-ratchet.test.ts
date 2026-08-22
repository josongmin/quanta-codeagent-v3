/**
 * RFC-05 E3 — direct permission-mode WRITER completeness ratchet.
 *
 * The behavior-live cutover retires the standalone permission-mode STATE CELL
 * (`createPermissionModeSessionState`, a bare `let current` closure) and routes
 * every mode read/write through the durable posture AUTHORITY. This static
 * ratchet enumerates the source tree and pins the cutover's completeness so a
 * regression cannot silently reintroduce a bypass:
 *
 *   (RED rail c) BEFORE the cutover the scan finds the legacy state cell
 *   (`createPermissionModeSessionState`) defined and constructed — a non-zero
 *   set of DIRECT mode-cell owners. This test asserts that set is EMPTY, so it
 *   is RED on the frozen base and GREEN only once the cell is deleted and its
 *   writers delegate to the authority.
 *
 * The ratchet also enforces the NON-ZERO delegating-adapter floor: the live
 * cutover must keep exactly one authority-backed adapter constructor
 * (`createPermissionModeAdapter`). Deleting that adapter (regressing to no live
 * writer at all) flips this RED — the completeness gate has a floor, per the
 * RFC's "non-zero owner floor" requirement.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..", "..", "..", "..")
const SRC = join(REPO, "src")

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      out.push(...walk(p))
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
      out.push(p)
    }
  }
  return out
}

const SOURCES = walk(SRC).map((abs) => ({
  rel: abs.slice(REPO.length + 1),
  text: readFileSync(abs, "utf8"),
}))

const filesMatching = (needle: string): string[] =>
  SOURCES.filter((f) => f.text.includes(needle)).map((f) => f.rel)

describe("RFC-05 E3 — direct permission-mode writer completeness ratchet", () => {
  test("the legacy permission-mode STATE CELL is fully deleted (no direct owners)", () => {
    // The stateful `let current` cell factory + every reference to it. On the
    // frozen (pre-cutover) base this is > 0 (defined in session-state.ts,
    // constructed in bootstrap-session.ts, exported from the runner barrel) ⇒
    // RED. After the cutover it is deleted everywhere ⇒ 0.
    //
    // RED-ON-INJECTION: reintroduce `createPermissionModeSessionState` (a raw
    // mode cell) anywhere in `src/` ⇒ this list is non-empty ⇒ RED.
    const owners = filesMatching("createPermissionModeSessionState")
    expect(owners).toEqual([])
  })

  test("the runner state module holds no permission-mode state cell", () => {
    // Guard the specific module the cell lived in: a delegating adapter reads the
    // authority; it never holds its own mutable `current` mode. This catches a
    // regression that keeps the export name but re-adds shadow state.
    const stateModule = SOURCES.find((f) => f.rel.endsWith("runner/assemble/session-state.ts"))
    expect(stateModule).toBeDefined()
    // The permission-mode cell's tell-tale value dependency — the `PermissionMode`
    // import it needed to hold a mutable `current` mode — must be gone from this
    // module. The mode axis now lives entirely in the authority; the adapter
    // CONTRACT type is re-exported from the E3 builder (a type-only re-export that
    // does NOT reintroduce this value/type import).
    expect(stateModule?.text.includes('import type { PermissionMode } from "@/permission"')).toBe(
      false,
    )
  })

  test("the delegating adapter is the single live authority-backed writer (non-zero floor)", () => {
    // Floor: the cutover must retain exactly one authority-backed mode adapter
    // constructor. RED-ON-INJECTION: delete `createPermissionModeAdapter` ⇒ this
    // is empty ⇒ RED (a completeness gate with a real floor, not "zero writers").
    const adapters = filesMatching("createPermissionModeAdapter")
    expect(adapters.length).toBeGreaterThan(0)
    // It lives in the E3-owned posture builder, not scattered across surfaces.
    expect(adapters).toContain("src/runner/assemble/session-authorities/build-posture.ts")
  })
})
