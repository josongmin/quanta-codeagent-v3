/**
 * `@/agent/untrusted` — re-export shim.
 *
 * The untrusted-content boundary escaper is a zero-dependency pure string
 * primitive shared across slices: the prompt assembler (`@/agent`) AND the
 * browser tool's page-text guard (`@/tool/browser/result-map`) both need it.
 * To keep `@/tool` from importing `@/agent` (slice-boundary fence), the
 * implementation now lives in the base utility slice `@/shared/untrusted`.
 *
 * This module re-exports it so the historical `@/agent/untrusted` import path
 * (prompt.ts, ide-context.ts, the agent barrel, tests) stays byte-identical.
 */

export { embedUntrusted, escapeBoundary } from "@/shared/untrusted"
