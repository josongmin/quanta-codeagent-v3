/**
 * VectorStore types — ADR-0261.
 *
 * Closed shapes only. `StoreError` is a 5-arm closed union; consumers must
 * handle every arm (use `assertNever` in default branch).
 *
 * Metadata is restricted to `string | number | boolean` so:
 *   1. SQLite serialisation is total (no JSON-of-JSON edge cases),
 *   2. Filter equality is reference-free,
 *   3. REST adapters can send metadata as plain JSON without losing types.
 */

export interface StoredDoc {
  readonly id: string
  readonly vector: readonly number[]
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

export interface StoredHit {
  readonly id: string
  readonly score: number
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

export interface StoreCapabilities {
  readonly distMetric: "cosine"
  readonly maxDim: number
  readonly persistent: boolean
}

export interface Filter {
  readonly equals?: Readonly<Record<string, string | number | boolean>>
}

export type StoreError =
  | { readonly kind: "dim-mismatch"; readonly expected: number; readonly got: number }
  | { readonly kind: "not-found"; readonly id: string }
  | { readonly kind: "http-error"; readonly status: number; readonly body: string }
  | { readonly kind: "network"; readonly detail: string }
  | { readonly kind: "invalid-response"; readonly detail: string }

export const STORE_ERROR_KINDS = [
  "dim-mismatch",
  "not-found",
  "http-error",
  "network",
  "invalid-response",
] as const satisfies ReadonlyArray<StoreError["kind"]>
