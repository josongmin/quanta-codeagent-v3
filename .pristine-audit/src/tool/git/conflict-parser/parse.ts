/**
 * SSOT forwarder (T13, audit L9 H13).
 *
 * The git-conflict parsing algorithm has exactly ONE owner:
 * `@/git/conflict-parser`. This tool-layer module previously carried a second,
 * independently-maintained copy that had already drifted from the library one.
 * It now re-exports the canonical implementation so the two can never diverge
 * again. The slice ratchet (`tests/unit/git/conflict-parser-ssot-ratchet.test.ts`)
 * fences re-introduction of a second `parseConflicts` algorithm here.
 */
export { parseConflicts } from "@/git/conflict-parser"
