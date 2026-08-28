/**
 * In-memory sticky-model store (ADR-0212).
 *
 * Default-impl that satisfies {@link StickyModelStore} without any IO.
 * Used by tests, by ephemeral session flows, and as the default when
 * `~/.quanta/sticky-model.json` cannot be written (CI / read-only fs).
 *
 * Pure: no IO, no clock, no global mutable state. The instance carries its
 * OWN backing Map so a stale closure or shared module instance cannot
 * leak between sessions in test harnesses (each test constructs its own
 * store).
 */

import {
  readStickyModelFrom,
  type StickyModelKey,
  type StickyModelLoadResult,
  type StickyModelSetResult,
  type StickyModelStore,
  stickyModelKeyOf,
} from "./port"

/** Construct an in-memory {@link StickyModelStore}. `seed` is an optional
 *  initial snapshot — useful for tests that want a pre-populated store
 *  without invoking `set()` per entry. The seed is copied (not aliased) so
 *  caller mutation cannot poison the store. */
export const inMemoryStickyModelStore = (
  seed?: Readonly<Record<string, string>>,
): StickyModelStore => {
  const data = new Map<string, string>()
  if (seed !== undefined) {
    for (const [k, v] of Object.entries(seed)) {
      if (typeof v === "string" && v.length > 0) data.set(k, v)
    }
  }
  return {
    async get(input: StickyModelKey): Promise<string | undefined> {
      return readStickyModelFrom((k) => data.get(k), input)
    },
    async set(input: StickyModelKey & { modelId: string }): Promise<StickyModelSetResult> {
      data.set(stickyModelKeyOf(input), input.modelId)
      return { ok: true }
    },
    async unset(input: StickyModelKey): Promise<StickyModelSetResult> {
      // `Map.delete` on an absent key is already the no-op the port promises, so
      // there is no "was it there?" branch to get wrong — the post-state is what
      // the caller asked for either way.
      data.delete(stickyModelKeyOf(input))
      return { ok: true }
    },
    peek(input: StickyModelKey): string | undefined {
      return readStickyModelFrom((k) => data.get(k), input)
    },
    async load(): Promise<StickyModelLoadResult> {
      const snapshot: Record<string, string> = {}
      for (const [k, v] of data.entries()) snapshot[k] = v
      return { ok: true, snapshot: Object.freeze(snapshot) }
    },
  }
}
