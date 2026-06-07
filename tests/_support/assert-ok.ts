import { expect } from "bun:test"

/**
 * Assert a discriminated-union `Result` is the OK variant, and narrow it.
 *
 * Replaces the silent `if (!r.ok) return` guard inside test bodies: that
 * pattern made a test pass GREEN when the operation under test FAILED (the
 * assertions below the guard never ran). `assertOk(r)` instead fails loudly on
 * `ok: false` and narrows `r` so the OK fields are accessible afterwards.
 *
 * Use ONLY where `ok` is guaranteed by the fixture (e.g. an in-memory mock that
 * always succeeds). For genuinely environment-dependent operations (a real git
 * binary, a real browser) use `test.skipIf(<probe>)` so the runner emits a real
 * `skipped` count instead.
 */
export function assertOk<T extends { readonly ok: boolean }>(
  r: T,
  msg?: string,
): asserts r is Extract<T, { ok: true }> {
  if (!r.ok) {
    const err = (r as { readonly error?: unknown }).error
    const detail = err !== undefined ? ` (error: ${String(err)})` : ""
    throw new Error(`${msg ?? "assertOk"}: expected ok result, got ok=false${detail}`)
  }
  // Register an explicit assertion so the test is never "no-assertion" green.
  expect(r.ok).toBe(true)
}
