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

/** Closed run-mode union (4 surfaces). */
export type AgentMode = "interactive" | "headless" | "batch" | "ci-bot"

// ─────────────────────────────────────────────────────────────────────────
// Lever 1 — permission: who decides borderline actions
// ─────────────────────────────────────────────────────────────────────────
export type PermissionLever =
  | { kind: "reviewer-backed" } // interactive — HITL port
  | { kind: "auto"; policy: "acceptEdits" | "denyAll" | "askAll" }

// ─────────────────────────────────────────────────────────────────────────
// Lever 2 — termination: what signals "done"
// ─────────────────────────────────────────────────────────────────────────
export type TerminationLever =
  | { kind: "user-stop" }
  | { kind: "single-turn" }
  | { kind: "verdict" }
  | { kind: "diff-ready" }

// ─────────────────────────────────────────────────────────────────────────
// Lever 3 — sandbox: where mutations land
// ─────────────────────────────────────────────────────────────────────────
export type SandboxLever =
  | { kind: "user-cwd" }
  | { kind: "per-instance" }
  | { kind: "branch-only" }

// ─────────────────────────────────────────────────────────────────────────
// Lever 4 — output: shape of the run product
// ─────────────────────────────────────────────────────────────────────────
export type OutputLever =
  | { kind: "stdout-chat" }
  | { kind: "structured" }
  | { kind: "github-check" }

// ─────────────────────────────────────────────────────────────────────────
// Lever 5 — externalDeps: how far into the host the run reaches
// ─────────────────────────────────────────────────────────────────────────
export type ExternalDepsLever =
  | { kind: "host" } // user hooks + MCP from disk
  | { kind: "hermetic" }
  | { kind: "hermetic-with-overrides" }

// ─────────────────────────────────────────────────────────────────────────
// Lever 6 — toolSurface: which tool families ship
// ─────────────────────────────────────────────────────────────────────────
export type ToolSurfaceLever =
  | { kind: "full" }
  | { kind: "headless-safe" }
  | { kind: "bench" }
  | { kind: "ci-restricted" }

// ─────────────────────────────────────────────────────────────────────────
// Lever 7 — promptPack: which rule bundle the system prompt uses
// ─────────────────────────────────────────────────────────────────────────
export type PromptPackLever =
  | { kind: "assistant" }
  | { kind: "task-runner" }
  | { kind: "benchmark" }
  | { kind: "pr-agent" }

// ─────────────────────────────────────────────────────────────────────────
// Lever 8 — memory: long-term store policy
// ─────────────────────────────────────────────────────────────────────────
export type MemoryLever =
  | { kind: "persistent" } // host store, recall + consolidate
  | { kind: "ephemeral" } // in-memory only, dropped at run end
  | { kind: "disabled" }

// ─────────────────────────────────────────────────────────────────────────
// Lever 9 — observation: trajectory recording level
// ─────────────────────────────────────────────────────────────────────────
export type ObservationLever =
  | { kind: "stream-only" }
  | { kind: "full-trajectory" }
  | { kind: "structured-report" }

// ─────────────────────────────────────────────────────────────────────────
// Lever 10 — network: outbound access
// ─────────────────────────────────────────────────────────────────────────
export type NetworkLever =
  | { kind: "open" }
  | { kind: "allowlist" }
  | { kind: "denied" }

// ─────────────────────────────────────────────────────────────────────────
// Lever 11 — gitWrite: who/what is allowed to mutate the working repo
// ─────────────────────────────────────────────────────────────────────────
export type GitWriteLever =
  | { kind: "free" } // any branch, any push
  | { kind: "branch-only" } // never main/master
  | { kind: "snapshot-only" } // bench: per-instance snapshots only
  | { kind: "denied" }

// ─────────────────────────────────────────────────────────────────────────
// Lever 12 — secrets: how the host's secrets are exposed
// ─────────────────────────────────────────────────────────────────────────
export type SecretsLever =
  | { kind: "host-env" }
  | { kind: "scoped" } // explicit allowlist of env keys
  | { kind: "none" }

/**
 * The 12-lever vector. Each cell is a discriminated union so a matrix
 * violation (e.g. `mode === "batch"` + `permission.kind === "reviewer-backed"`)
 * is a compile-time error after `narrowMode<"batch">(...)`.
 */
export interface ModePolicy {
  mode: AgentMode
  permission: PermissionLever
  termination: TerminationLever
  sandbox: SandboxLever
  output: OutputLever
  externalDeps: ExternalDepsLever
  toolSurface: ToolSurfaceLever
  promptPack: PromptPackLever
  memory: MemoryLever
  observation: ObservationLever
  network: NetworkLever
  gitWrite: GitWriteLever
  secrets: SecretsLever
}

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
] as const

/** Static checked length so any future addition forces a matrix update. */
export type LeverField = (typeof LEVER_FIELDS)[number]

// ─────────────────────────────────────────────────────────────────────────
// Drift guard (audit R3 fix): LEVER_FIELDS is a hand-maintained array, but it
// MUST stay in lock-step with ModePolicy's lever keys. These two type-level
// assertions fail to compile if the lists drift — e.g. adding a 13th lever to
// ModePolicy without appending it to LEVER_FIELDS (or vice versa) is a build
// error, not a silently-green test.
// ─────────────────────────────────────────────────────────────────────────
type ModePolicyLeverKey = Exclude<keyof ModePolicy, "mode">
type Assert<T extends true> = T
type _LeverFieldsCoverPolicy = Assert<
  ModePolicyLeverKey extends LeverField ? true : false
>
type _PolicyCoversLeverFields = Assert<
  LeverField extends ModePolicyLeverKey ? true : false
>
// Reference the aliases so `noUnusedLocals`-style lint keeps them live.
export type _LeverDriftGuard = _LeverFieldsCoverPolicy | _PolicyCoversLeverFields

/** Enumerate every mode — single source of truth for matrix tests. */
export const ALL_AGENT_MODES = ["interactive", "headless", "batch", "ci-bot"] as const satisfies readonly AgentMode[]
