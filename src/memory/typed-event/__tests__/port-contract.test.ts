/**
 * ★ HELLGATE — ADR-0320 port surface (compile-time assertion).
 *
 * Pins the exact method signature of `TypedHistoryEventStore` and the
 * exact variant set of `TypedHistoryEvent`. Drift here means the
 * closed-port contract was widened without a new ADR — that's the
 * load-bearing invariant of the slice-fence.
 *
 * 6 variants: ADR-0320 (5: context_update / skill_activation /
 * repo_rules_change / mode_change / reasoning_echo) + ADR-0324
 * (compaction_event).
 *
 * The test body runs at runtime as a sanity smoke (one assertion per
 * variant tag), but the real test is `tsc --noEmit`: every type
 * assertion below must remain `true` for the file to compile.
 */

import { describe, expect, test } from "bun:test"
import {
  createInMemoryTypedHistoryEventStore,
  type TypedHistoryEvent,
  type TypedHistoryEventKind,
  type TypedHistoryEventStore,
} from ".."

// --------------------------- type-level assertions ---------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

type AssertTrue<T extends true> = T

// 1) Variant set is exactly the 6 declared in ADR-0320 (5 original) +
//    ADR-0324 (compaction_event). Adding a 7th requires a new ADR; the
//    type guard fires at the compile step.
type _VariantSet = AssertTrue<
  Equals<
    TypedHistoryEventKind,
    | "context_update"
    | "skill_activation"
    | "repo_rules_change"
    | "mode_change"
    | "reasoning_echo"
    | "compaction_event"
  >
>

// 2) Port surface is exactly 4 methods with the documented signatures.
type _PortShape = AssertTrue<
  Equals<
    TypedHistoryEventStore,
    {
      append(event: TypedHistoryEvent): void
      snapshot(): readonly TypedHistoryEvent[]
      since(at: number): readonly TypedHistoryEvent[]
      clear(): void
    }
  >
>

// 3) Factory returns the port type (not a class — the impl class is
//    intentionally NOT part of the public surface).
type _FactoryReturn = AssertTrue<
  Equals<ReturnType<typeof createInMemoryTypedHistoryEventStore>, TypedHistoryEventStore>
>

// Discard markers so `noUnusedLocals` / biome don't flag them.
type _Markers = [_VariantSet, _PortShape, _FactoryReturn]
const _markers: _Markers | undefined = undefined
void _markers

// ----------------------------- runtime smoke --------------------------------

describe("ADR-0320 port-contract", () => {
  test("factory returns an object satisfying the 4-method port", () => {
    const store = createInMemoryTypedHistoryEventStore()
    expect(typeof store.append).toBe("function")
    expect(typeof store.snapshot).toBe("function")
    expect(typeof store.since).toBe("function")
    expect(typeof store.clear).toBe("function")
  })

  test("every variant tag is constructible via the union", () => {
    // Exhaustiveness check: if any variant is dropped from the union
    // this switch loses its `never` arm and the test fails to compile.
    const tags: TypedHistoryEventKind[] = [
      "context_update",
      "skill_activation",
      "repo_rules_change",
      "mode_change",
      "reasoning_echo",
      "compaction_event",
    ]
    for (const tag of tags) {
      const _exhaustive: TypedHistoryEventKind = tag
      switch (_exhaustive) {
        case "context_update":
        case "skill_activation":
        case "repo_rules_change":
        case "mode_change":
        case "reasoning_echo":
        case "compaction_event":
          break
        default: {
          const _never: never = _exhaustive
          throw new Error(`unreachable: ${String(_never)}`)
        }
      }
    }
    expect(tags.length).toBe(6)
  })
})
