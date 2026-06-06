/**
 * V4A patch tracing adapter barrel.
 *
 * Produces a `PatchTracePort` (the closed-port tracing seam defined in
 * `@/patch`) bound to the canonical span sink. The `@/patch` slice is a pure
 * leaf and MUST NOT import `@/observability` at runtime; this adapter is the
 * ONE place the `quanta.patch.*` OTel vocabulary is wired, injected at the
 * composition root (the `apply_patch` tool). Surfaces opt in by importing this
 * sub-barrel explicitly — the parent `@/observability` barrel intentionally
 * does NOT pull it in (same Default-OFF posture as `@/observability/coverage`
 * and `@/observability/tracing`).
 */

export { otelPatchTracePort } from "./otel-patch-trace"
