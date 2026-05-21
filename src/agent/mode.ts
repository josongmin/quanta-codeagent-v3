import type { ToolAction } from "@/permission"
import { QuantaError } from "@/shared"
import type { AgentMode } from "./prompt"

/**
 * Mode policy (Codex `mode-and-plan-process-audit.md` absorption — Phase 3).
 *
 * Mode is more than a prompt nudge: it controls tool admissibility at the
 * dispatch seam. `plan`, `review`, and `audit` are all READ-ONLY task postures
 * (Codex's checkpoint-and-choose / findings-first / contract-vs-truth shapes
 * all forbid mutating side effects mid-loop). `default` is the legacy
 * assume-and-execute posture: mutating tools allowed.
 *
 * This file generalizes the prior `plan.ts` boolean gate into a typed enum
 * gate. `plan.ts` is kept as a thin deprecated alias so existing callers
 * compile unchanged; dispatch and new callers should route through this
 * module.
 */

/** Modes that PERMIT mutating tools. Phrased as a positive (mutating-allowed)
 *  set rather than the inverse (read-only) so the default for any UNKNOWN
 *  mode value at runtime is to BLOCK mutating tools — fail-closed. A future
 *  read-only mode addition (e.g. "debug") gets the safe posture automatically
 *  even if someone forgets to update this gate; an inverse `READ_ONLY_MODES`
 *  list would silently grant write access to the new mode. */
const MUTATING_MODES = new Set<AgentMode>(["default"])

/** Resolve the effective mode from the new `mode` field and the legacy
 *  `planMode` boolean. `mode` wins when present so callers can migrate
 *  incrementally without breakage; absent ⇒ `planMode:true` maps to `"plan"`;
 *  both absent ⇒ `"default"`. Mirrors the same precedence used by
 *  `buildTurnContext` so prompt + dispatch never disagree on the active mode. */
export const resolveAgentMode = (
  mode: AgentMode | undefined,
  planMode: boolean | undefined,
): AgentMode => {
  if (mode !== undefined) return mode
  if (planMode === true) return "plan"
  return "default"
}

/** True iff `mode` forbids mutating tools and `action` is mutating. Read-only
 *  actions pass through every mode unchanged. Fail-closed: a mode that is NOT
 *  in {@link MUTATING_MODES} (including any unknown runtime value) blocks
 *  mutating tools — a new mode forgotten by a future PR ships safe by default. */
export const isMutatingToolBlockedInMode = (mode: AgentMode, action: ToolAction): boolean => {
  if (action.isReadOnly) return false
  return !MUTATING_MODES.has(mode)
}

/** Human-readable rationale for the deny message returned when a mutating
 *  tool is blocked. Used by dispatch so the LLM gets a specific reason ("in
 *  review mode") instead of a generic refusal. */
export const modeBlockReason = (mode: AgentMode, toolName: string): string =>
  `blocked in ${mode} mode: ${toolName}`

/* ───────────────────────── ADR-0036 (Plan vs Default collaboration mode) ──
 *
 * Plan vs Default collaboration mode (Codex `codex-collaboration-mode-pattern`
 * absorption). This narrower 2-mode collaboration enum is layered ON TOP of
 * the existing 4-mode `AgentMode` (default/plan/review/audit) without changing
 * any of the legacy exports. It exists to make ONE specific guarantee explicit:
 *
 *   In `plan` collaboration mode, mutating tools are blocked at the dispatch
 *   seam BEFORE any tool implementation runs. The block is driven by an
 *   explicit per-tool table — unknown tools throw rather than silently fall
 *   into the "non-mutating" bucket, so a future tool addition cannot bypass
 *   the gate by being forgotten.
 *
 * Sticky transition: collaboration mode flips ONLY on a developer-channel
 * message that carries an explicit `mode=plan` / `mode=default` directive.
 * No silent "the LLM thinks it should be plan now" drift; no fallback path.
 *
 * Wiring into `loop.ts` is intentionally out of scope for this cluster
 * (see ADR-0036 §한계). The exports here are standalone-callable so the
 * follow-up that adds the seam can do so as a pure import-and-call patch.
 */

/** Plan vs Default collaboration mode (ADR-0036). Distinct from {@link
 *  AgentMode} on purpose — `AgentMode` is the 4-mode posture enum tied to the
 *  prompt (default/plan/review/audit). `CollaborationMode` is the 2-mode
 *  permission-shape enum tied to the dispatch seam. They overlap on the words
 *  "default" and "plan" but are NOT the same field. */
export type CollaborationMode = "default" | "plan"

/** Kinds of mutating tools recognized at the dispatch seam (ADR-0036).
 *
 *   - `write_filesystem`: creates or overwrites files in the working tree
 *     (`write`, `edit`, `scripted_replace`).
 *   - `bash_mutating`: shell commands routed through `bash`. Any `bash` call
 *     is treated as mutating in plan mode — the dispatch seam cannot inspect
 *     the command text deeply enough to be sure read-only `ls`/`cat` is not
 *     hiding a mutating side effect (process spawn, env write, network).
 *   - `git_mutating`: mutating git tools. Shipped: `git_commit` (regular +
 *     wip-checkpoint modes) and `git_branch_switch` (ADR-0053, Claude
 *     Desktop 1.7196.3 `commitWipForBranchSwitch` absorption). Read-only
 *     git tools are `git_status`/`git_log`/`git_diff`/`git_blame`.
 *   - `network_write`: outbound network writes (none ship today — MCP/HTTP
 *     write surfaces). Reserved for the same reason as `git_mutating`.
 *   - `working_state_write`: mutates the durable working-state surface (e.g.
 *     `update_working_state`). Permitted in default mode; blocked in plan
 *     mode because plan mode's contract is to PROPOSE state changes, not
 *     commit them mid-turn.
 */
export type MutatingToolKind =
  | "write_filesystem"
  | "bash_mutating"
  | "git_mutating"
  | "network_write"
  | "working_state_write"

/** Explicit per-tool classification table (ADR-0036). EVERY tool name known
 *  to the v3 registry MUST appear here — `mode-mutating-table.test.ts`
 *  cross-checks this against `defaultTools` so adding a tool without updating
 *  the table fails CI. `null` = read-only; otherwise the {@link
 *  MutatingToolKind} that classifies the mutating effect.
 *
 *  The table is intentionally inverse of the registry's `isReadOnly()` so
 *  that adding a mutating tool without classifying its kind here is a
 *  COMPILE-OR-TEST failure, not a silent dispatch-seam bypass. */
const MUTATING_TOOL_TABLE: Readonly<Record<string, MutatingToolKind | null>> = Object.freeze({
  // Read-only built-ins
  read: null,
  grep: null,
  glob: null,
  localize: null,
  diagnostics: null,
  test_runner: null,
  lsp_definition: null,
  lsp_references: null,
  lsp_hover: null,
  lsp_type_definition: null,
  lsp_implementation: null,
  lsp_document_symbol: null,
  lsp_workspace_symbol: null,
  lsp_rename_preview: null,
  git_status: null,
  git_log: null,
  git_diff: null,
  git_blame: null,
  // Mutating built-ins
  write: "write_filesystem",
  edit: "write_filesystem",
  scripted_replace: "write_filesystem",
  bash: "bash_mutating",
  update_working_state: "working_state_write",
  // Mutating git built-ins (ADR-0053, Claude Desktop 1.7196.3
  // `commitWipForBranchSwitch` absorption). git_commit creates a commit;
  // git_branch_switch may write a wip checkpoint + change HEAD. Both block
  // in plan mode — plan mode PROPOSES; it does not commit.
  git_commit: "git_mutating",
  git_branch_switch: "git_mutating",
})

/** Thrown by {@link isMutatingTool} / {@link assertNotMutatingInPlanMode}
 *  when a tool name is not in the explicit table. Surfaces the missing tool
 *  name so the failing test points directly at the omission. */
export class UnknownToolError extends QuantaError {
  readonly toolName: string
  constructor(toolName: string) {
    super(
      "unknown_tool",
      `Tool "${toolName}" is not classified in the plan-mode mutating table. ` +
        `Every registered tool must have an explicit entry in MUTATING_TOOL_TABLE ` +
        `(src/agent/mode.ts) so plan-mode cannot silently allow new mutating tools.`,
    )
    this.toolName = toolName
  }
}

/** Thrown by {@link assertNotMutatingInPlanMode} / dispatch-seam guard when
 *  a mutating tool is called in `plan` collaboration mode. Surfaces both the
 *  tool name and the mutating-kind so the LLM-facing deny message can be
 *  specific. */
export class PlanModeMutatingBlockedError extends QuantaError {
  readonly toolName: string
  readonly mutatingKind: MutatingToolKind
  constructor(toolName: string, mutatingKind: MutatingToolKind) {
    super(
      "plan_mode_mutating_blocked",
      `Tool "${toolName}" (${mutatingKind}) is blocked in plan collaboration mode. ` +
        `Switch to default mode via a developer message (\`mode=default\`) to mutate.`,
    )
    this.toolName = toolName
    this.mutatingKind = mutatingKind
  }
}

/** Thrown by {@link applyDeveloperModeTransition} when a developer message
 *  carries a `mode=…` directive that is neither `plan` nor `default`. */
export class InvalidModeTransitionError extends QuantaError {
  readonly attempted: string
  constructor(attempted: string) {
    super(
      "invalid_mode_transition",
      `Invalid collaboration mode transition: "${attempted}". ` +
        `Only mode=plan and mode=default are allowed via developer message.`,
    )
    this.attempted = attempted
  }
}

/** Look up a tool's mutating classification. Returns `true` iff the tool is
 *  classified as mutating (any {@link MutatingToolKind}); `false` for
 *  explicitly read-only tools. Throws {@link UnknownToolError} for any tool
 *  name not in the table — no silent fallback. */
export const isMutatingTool = (toolName: string): boolean => {
  if (!(toolName in MUTATING_TOOL_TABLE)) throw new UnknownToolError(toolName)
  return MUTATING_TOOL_TABLE[toolName] !== null
}

/** Returns the mutating kind for a tool, or `null` if the tool is read-only.
 *  Throws {@link UnknownToolError} for an unrecognized name. Exposed so the
 *  dispatch-seam guard can put the kind into its rejection payload. */
export const mutatingToolKind = (toolName: string): MutatingToolKind | null => {
  if (!(toolName in MUTATING_TOOL_TABLE)) throw new UnknownToolError(toolName)
  const kind = MUTATING_TOOL_TABLE[toolName]
  return kind ?? null
}

/** Read-only snapshot of the mutating-tool table — exposed for the
 *  cross-check test in `tests/unit/mode-mutating-table.test.ts`. */
export const planModeMutatingTable = (): Readonly<Record<string, MutatingToolKind | null>> =>
  MUTATING_TOOL_TABLE

/** Assert that calling `toolName` is permitted under the given collaboration
 *  `mode`. No-op in `default` mode; in `plan` mode, throws
 *  {@link PlanModeMutatingBlockedError} for any mutating tool. Throws
 *  {@link UnknownToolError} for an unrecognized tool name. */
export const assertNotMutatingInPlanMode = (mode: CollaborationMode, toolName: string): void => {
  if (mode === "default") return
  const kind = mutatingToolKind(toolName)
  if (kind === null) return
  throw new PlanModeMutatingBlockedError(toolName, kind)
}

/** Strict regex for the `mode=…` directive that a developer message must
 *  carry to cause a collaboration-mode transition. Anchored — anything other
 *  than the bare directive (with optional surrounding whitespace) is treated
 *  as "no directive present". */
const MODE_DIRECTIVE_RE = /^\s*mode\s*=\s*([a-z_]+)\s*$/

/** Apply a developer-channel message to the current collaboration mode.
 *
 *  - Returns the unchanged `currentMode` if `devMessage` does NOT contain a
 *    `mode=…` directive (developer messages without a directive are routed
 *    elsewhere — this function's contract is "transition or stay").
 *  - Returns the requested mode if the directive parses as `mode=plan` or
 *    `mode=default`. Identical-mode transition is a no-op (returns
 *    `currentMode`, no error — sticky-set semantics).
 *  - Throws {@link InvalidModeTransitionError} for any other `mode=…` value.
 *    No silent fallback. */
export const applyDeveloperModeTransition = (
  currentMode: CollaborationMode,
  devMessage: string,
): CollaborationMode => {
  const match = MODE_DIRECTIVE_RE.exec(devMessage)
  if (match === null) return currentMode
  const attempted = match[1]
  if (attempted === "plan" || attempted === "default") return attempted
  throw new InvalidModeTransitionError(attempted ?? devMessage.trim())
}
