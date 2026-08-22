/**
 * ADR-0323 (extension) — resume-boundary `tool_use`↔`tool_result` reconciliation.
 *
 * B4 follow-up (jun-04): the PURE implementation was relocated to the leaf
 * `@/shared/reconcile-tool-pairing` so the WRITE-path (`@/session/store.ts`'s
 * `rewindToMessage` / `forkSession`) can share one implementation with the
 * READ-path here WITHOUT forging a forbidden `@/session → @/memory` slice edge
 * (biome `noRestrictedImports` blocks `@/session → @/memory`; both slices may
 * reach `@/shared`). This module is now a thin re-export so the existing
 * `@/memory/history-sanitization` public surface — consumed by
 * `@/runner/orchestrate/resume-fsm.ts` and the history-pairing hellgate — is
 * unchanged byte-for-byte.
 *
 * The full design rationale (the two repairs, invariants, slice-fence) now
 * lives next to the implementation in `@/shared/reconcile-tool-pairing.ts`.
 */

export { RECONCILE_PLACEHOLDER_TEXT, reconcileToolPairing } from "@/shared"
