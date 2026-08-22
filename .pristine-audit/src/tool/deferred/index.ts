/**
 * ADR-0286 — barrel for the `@/tool/deferred` slice.
 *
 * The barrel re-exports the LEGACY surface under the historic names
 * (`DeferredResultRegistry`, `UnknownDeferredHandleError`) so every existing
 * importer — `@/tool/index.ts`, `tests/unit/tool-factory.test.ts`, any
 * downstream consumer — is byte-identical. The NEW production port + impl +
 * types are reachable via the explicit subpaths
 * `@/tool/deferred/{port,types,default-registry}` to avoid the name
 * collision (the port interface is also named `DeferredResultRegistry`).
 *
 * Why two siblings: the legacy class is "external poller" (a tool yields a
 * handle, an out-of-band poller resolves it); the new port is "registry-
 * managed work" (the registry runs the worker, owns the AbortController,
 * tracks 5 lifecycle states). The two contracts genuinely differ and
 * deleting the legacy seam would break a public export — they coexist by
 * design.
 */

export { DeferredResultRegistry, UnknownDeferredHandleError } from "./legacy"
