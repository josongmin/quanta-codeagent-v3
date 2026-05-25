/**
 * Error-routing ports (ADR-0217).
 *
 * Closed-port DI seam. Two ports, ONE method each:
 *   - `ErrorClassifier.classify(e: unknown): TypedError` — pure boundary
 *     translator from raw thrown value to 16-arm discriminant.
 *   - `RetryRouter.decide(e: TypedError): RetryAction` — pure routing
 *     table from kind (+ status for `httpStatusCode`) to 5-arm action.
 *
 * Two ports instead of one because the concerns drift:
 *   - classification is provider/SDK-shape dependent (and likely to
 *     evolve as new providers land);
 *   - routing is policy dependent (a surface may swallow `hitl` into a
 *     modal, or a CI surface may treat `hitl` as `abort`).
 * Keeping them separate makes both testable in isolation.
 *
 * Plane-clean: imports only `./types` (sibling). The default impls live
 * in `./default-classifier.ts` and `./default-router.ts`.
 */

import type { RetryAction, TypedError } from "./types"

export interface ErrorClassifier {
  /** Translate an arbitrary thrown value (Error, plain object, string,
   *  primitive, etc.) into a closed 16-arm discriminant. MUST be total:
   *  any input returns a `TypedError` (unknown inputs degrade to
   *  `internalServerError`). MUST be pure: no I/O, no logging, no
   *  global state. Locked by HELL-ER-23. */
  classify(e: unknown): TypedError
}

export interface RetryRouter {
  /** Map a typed error to the loop's next action. Pure switch over `kind`
   *  with the one branch on `httpStatusCode.status` (429 vs 5xx vs other).
   *  Locked by HELL-ER-17..21, 25. */
  decide(e: TypedError): RetryAction
}
