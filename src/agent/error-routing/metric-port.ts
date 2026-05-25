/**
 * ADR-0222 — narrow metric port for error-routing.
 *
 * Two-method port scoped to the two call sites the slice has:
 *   - `recordClassified(kind)` — fired once per `ErrorClassifier.classify()`.
 *   - `recordAction(action)` — fired once per `RetryRouter.decide()`.
 *
 * Plane-clean: imports ONLY local sibling types (`./types`). The slice
 * itself never imports `@/observability`; the observability adapter
 * (`@/observability/metrics/wire-new-slices`) returns an object that
 * satisfies this interface. The coupling is interface-only.
 */

import type { RetryAction, TypedErrorKind } from "./types"

export interface ErrorRoutingMetric {
  /** Record that the classifier produced `kind`. No-throw. */
  recordClassified(kind: TypedErrorKind): void
  /** Record that the router decided `action`. No-throw. */
  recordAction(action: RetryAction): void
}
