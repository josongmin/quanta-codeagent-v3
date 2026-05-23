/**
 * `run-mode` slice — discriminated-union typing of the 12 semantic levers
 * a run mode binds (RFC may-22-unified-agent-runtime §4 + Phase 0 plan).
 *
 * The four modes — `interactive` / `headless` / `batch` / `ci-bot` — bind a
 * lever vector that the loop and assemble layer narrow on. There are NO
 * numerical literals in this file; all quantitative knobs live in the
 * `BudgetDials` shape (see `../budget/types.ts`) which is the SEPARATE
 * orthogonal axis.
 *
 * Each lever is a `{ kind }` discriminated union so the matrix in
 * `./presets.ts` is exhaustively typed and matrix violations are caught at
 * compile time (e.g. `mode === "batch"` cannot pair with
 * `permission.kind === "reviewer-backed"`).
 */
/** All 12 lever field names — used by tests to enumerate the matrix. */
export const LEVER_FIELDS = [
    "permission",
    "termination",
    "sandbox",
    "output",
    "externalDeps",
    "toolSurface",
    "promptPack",
    "memory",
    "observation",
    "network",
    "gitWrite",
    "secrets",
];
/** Enumerate every mode — single source of truth for matrix tests. */
export const ALL_AGENT_MODES = [
    "interactive",
    "headless",
    "batch",
    "ci-bot",
    "ide",
    "daemon",
];
