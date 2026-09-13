/**
 * §20.4 / ticket-12 — subagent FS owned/forbidden ENFORCEMENT.
 *
 * RCA: `ownedSurfaces`/`forbiddenSurfaces` were injected into the child seed as
 * ADVISORY prompt text only — an LLM that ignores them writes anywhere. This is
 * the hard fence: a path-matcher consulted at the tool-dispatch FS-write seam so
 * a write outside the owned set (or inside the forbidden set) is DENIED.
 *
 * Semantics = SUBTREE containment (FS-natural; glob-free): an owned/forbidden
 * entry is a file (exact) OR a directory (owns its whole subtree). Matching runs
 * on SYMLINK-RESOLVED, `..`-normalized CANONICAL absolute paths (reusing the
 * jail's create-then-escape-proof `canonicalizePath`) so neither `..` nor a
 * symlink can smuggle a write out of the owned region. `forbidden` always wins
 * over `owned`. Default-OFF: `enforced !== true` ⇒ everything allowed (the
 * advisory legacy, byte-identical).
 *
 * The pure core operates on CANONICAL paths + pre-extracted write-effects so it
 * is fully hellgate-testable; the fs-canonicalization (`canonicalizePath`) and
 * the write-target extraction (`extractWriteEffects`, incl. bash `sed -i`/
 * redirect) are reused proven modules — the gate just composes them.
 *
 * SCOPE OF SOUNDNESS (honest, NOT overclaimed): the fence is SOUND for writers
 * whose target it can statically SEE — leaf (`path`/`file`), patch, and field
 * writers (`..`/symlink smuggling is closed by the canonicalizer). It is
 * BEST-EFFORT for the `shell` class: `extractShellWritePaths` matches only
 * LITERAL redirect/tee/sed/cp/dd/open targets; `$VAR`/computed/base64/quoted-
 * heredoc shell targets are an accepted false-negative (inherited from
 * circumvention.ts §5) and CAN escape the owned set via `bash`. Writers whose
 * target is not statically knowable at all (arbitrary code, server-derived
 * paths, whole-tree restores) are FAIL-CLOSED instead (see
 * {@link isUnfenceableWriteTool}); `node_repl` is fail-closed precisely because
 * shell-style best-effort parsing cannot bound arbitrary Node `fs` writes.
 */

import isPathInside from "is-path-inside"
import { parsePatch } from "@/patch"
import { canonicalizeEffectPath } from "@/permission"
import { canonicalizePath } from "@/storage"

export interface OwnershipPolicy {
  /** Owned files/dirs — CANONICAL absolute paths. Empty/absent ⇒ no whitelist
   *  (only `forbidden` restricts). */
  readonly owned?: readonly string[]
  /** Forbidden files/dirs — CANONICAL absolute paths. Always wins over owned. */
  readonly forbidden?: readonly string[]
  /** Hard gate. `false`/absent ⇒ advisory-only legacy (byte-identical). */
  readonly enforced?: boolean
}

/** True iff `target` is `dir` itself or inside its subtree (both canonical). */
const insideOrEqual = (target: string, dir: string): boolean =>
  target === dir || isPathInside(target, dir)

/** Verdict for ONE canonical target path against the policy. Pure. */
export const isPathAllowed = (
  targetCanonical: string,
  policy: OwnershipPolicy | undefined,
): { allowed: true } | { allowed: false; reason: "forbidden" | "not_owned" } => {
  if (policy?.enforced !== true) return { allowed: true }
  if (policy.forbidden?.some((d) => insideOrEqual(targetCanonical, d))) {
    return { allowed: false, reason: "forbidden" }
  }
  if (
    policy.owned !== undefined &&
    policy.owned.length > 0 &&
    !policy.owned.some((d) => insideOrEqual(targetCanonical, d))
  ) {
    return { allowed: false, reason: "not_owned" }
  }
  return { allowed: true }
}

/** Consult the policy over a tool call's extracted write-effects (canonical
 *  paths from `extractWriteEffects`). Denies on the FIRST violating path. A
 *  read-only call (no effects) is always allowed. Pure. */
export const consultOwnershipPolicy = (
  effects: readonly { readonly path: string }[],
  policy: OwnershipPolicy | undefined,
): { allowed: true } | { allowed: false; reason: "forbidden" | "not_owned"; path: string } => {
  if (policy?.enforced !== true) return { allowed: true }
  for (const e of effects) {
    const v = isPathAllowed(e.path, policy)
    if (!v.allowed) return { allowed: false, reason: v.reason, path: e.path }
  }
  return { allowed: true }
}

/** Gate-facing check over RAW extracted write-effects: re-canonicalizes each
 *  effect path with the SAME symlink-resolving `canonicalizePath` the policy was
 *  built with, THEN consults the policy. This is SECURITY-load-bearing — the
 *  circumvention extractor's `canonicalizeEffectPath` is LEXICAL-ONLY (resolves
 *  `..`/`.` but NOT symlinks), so comparing its output against a symlink-resolved
 *  policy boundary would be unsound (a `src/link → /secret` symlink would slip
 *  through). Re-canonicalizing both sides symlink-resolved closes that vector. */
export const checkWriteEffects = (
  effects: readonly { readonly path: string }[],
  policy: OwnershipPolicy | undefined,
  cwd?: string,
): { allowed: true } | { allowed: false; reason: "forbidden" | "not_owned"; path: string } => {
  if (policy?.enforced !== true) return { allowed: true }
  // `cwd` base is defence-in-depth: today every extractor emits ABSOLUTE paths
  // (so the base is inert), but threading the real `config.cwd` means a future
  // relative effect anchors to the tool cwd, never `process.cwd()`.
  return consultOwnershipPolicy(
    effects.map((e) => ({ path: canonicalizePath(e.path, cwd) })),
    policy,
  )
}

/** The default write tools whose FS targets live INSIDE `input.patch` (a V4A
 *  patch string) rather than a top-level `path`/`file` field — so the
 *  circumvention leaf's `extractWriteEffects` cannot see them and the ownership
 *  fence would silently pass them (a FALSE FENCE). Closed, named set. */
const PATCH_WRITE_TOOLS: ReadonlySet<string> = new Set(["apply_patch", "apply_patch_structured"])

/**
 * Write-effects for the patch-carrying tools. SECURITY-load-bearing: without
 * this, a fenced subagent (`QUANTA_FS_OWNERSHIP_ENFORCE=1`) escapes its owned
 * subtree via `apply_patch` — the primary edit tool — because the extractor
 * only duck-reads top-level `path`/`file`, and a patch's targets are inside
 * `input.patch`. Parses the CLOSED V4A op set (add/delete/update, each with a
 * literal `path`, update carrying an optional literal `moveTo`) and emits one
 * canonical effect per touched path. Heuristic-free: closed tool set + closed op
 * union + literal schema fields (no regex/guessing). PURE, NO-THROW: an
 * unparseable patch yields `[]` (it won't apply anyway; the apply-time FsJail
 * re-validates). The emitted paths are canonicalized the SAME lexical way as
 * `extractWriteEffects`, so `checkWriteEffects` re-canonicalizes them
 * symlink-resolved identically.
 */
export const patchWriteEffects = (
  toolName: string,
  input: unknown,
  cwd: string,
): readonly { readonly path: string }[] => {
  if (!PATCH_WRITE_TOOLS.has(toolName)) return []
  if (input === null || typeof input !== "object" || !("patch" in input)) return []
  const patch = (input as { patch: unknown }).patch
  if (typeof patch !== "string" || patch.length === 0) return []
  try {
    const effects: { path: string }[] = []
    for (const op of parsePatch(patch).ops) {
      effects.push({ path: canonicalizeEffectPath(op.path, cwd) })
      if (op.kind === "update" && op.moveTo !== undefined && op.moveTo.length > 0) {
        effects.push({ path: canonicalizeEffectPath(op.moveTo, cwd) })
      }
    }
    return effects
  } catch {
    return []
  }
}

/** Non-shell, non-`path`/`file`, non-patch write tools whose sole FS write
 *  target is a LITERAL input field the circumvention leaf does not duck-read.
 *  `image_gen` writes its `outputPath` (a single destination string);
 *  `shadow_restore_partial` writes every entry of `paths[]` (repo-relative
 *  strings); `appshot_verify` scaffolds into its `out_dir` (a directory whose
 *  subtree containment the fence checks). Closed tool→field map — same
 *  heuristic-free posture as {@link patchWriteEffects}: named tools, literal
 *  schema fields, no guessing. Without this the ownership fence silently passes
 *  them (another false fence), since the leaf only reads `path`/`file`. */
type FieldWriteSpec = { readonly field: string; readonly shape: "string" | "string-array" }
const FIELD_WRITE_TOOLS: ReadonlyMap<string, FieldWriteSpec> = new Map([
  ["image_gen", { field: "outputPath", shape: "string" }],
  ["shadow_restore_partial", { field: "paths", shape: "string-array" }],
  ["appshot_verify", { field: "out_dir", shape: "string" }],
])

/** Write-effects for the field-carrying tools above. PURE, NO-THROW: a
 *  malformed/absent field yields `[]` (the tool's own jail re-validates at
 *  apply-time). Paths are canonicalized the SAME lexical way as
 *  `extractWriteEffects`, so `checkWriteEffects` re-canonicalizes them
 *  symlink-resolved identically. */
export const fieldWriteEffects = (
  toolName: string,
  input: unknown,
  cwd: string,
): readonly { readonly path: string }[] => {
  const spec = FIELD_WRITE_TOOLS.get(toolName)
  if (spec === undefined) return []
  if (input === null || typeof input !== "object" || !(spec.field in input)) return []
  const raw = (input as Record<string, unknown>)[spec.field]
  const effects: { path: string }[] = []
  if (spec.shape === "string") {
    if (typeof raw === "string" && raw.length > 0) {
      effects.push({ path: canonicalizeEffectPath(raw, cwd) })
    }
  } else if (Array.isArray(raw)) {
    for (const p of raw) {
      if (typeof p === "string" && p.length > 0) {
        effects.push({ path: canonicalizeEffectPath(p, cwd) })
      }
    }
  }
  return effects
}

/** Write-capable tools whose FS targets are NOT statically knowable at dispatch,
 *  so no extractor can fence them:
 *    · `lsp_rename_apply` — edited files are COMPUTED by the language server (a
 *      multi-file WorkspaceEdit); `input` carries only the anchor `path`.
 *    · `shadow_rewind` — restores the WHOLE workspace snapshot (no path in input).
 *    · `mcp_read_resource` — writes a blob to a path DERIVED from the (untrusted)
 *      MCP server response; `input` carries only the resource `uri`.
 *    · `node_repl` — evaluates ARBITRARY host Node with full `fs`/`require`
 *      access; the target is inside model-authored code, unparseable (strictly
 *      worse than `bash`, which at least exposes a shell string to the parser).
 *    · `skill_create` — writes `<name>/SKILL.md` under the host skills dir; the
 *      absolute target is host-derived (not a cwd-relative input path).
 *    · `mcp_connector_install` — writes `.mcp.json` at a host-derived config path.
 *  A security fence must not silently pass a write it cannot prove in-bounds, so
 *  under enforcement these are FAIL-CLOSED (denied) at the ownership seam rather
 *  than under-reported to a misleading anchor path. All are GATED (opt-in, never
 *  auto-seeded) ⇒ a DEFAULT fenced subagent's menu is unaffected. */
const UNFENCEABLE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "lsp_rename_apply",
  "shadow_rewind",
  "mcp_read_resource",
  "node_repl",
  "skill_create",
  "mcp_connector_install",
])

/** True iff the tool writes to a target the ownership fence cannot statically
 *  prove in-bounds ⇒ deny under `enforced === true`. See UNFENCEABLE_WRITE_TOOLS. */
export const isUnfenceableWriteTool = (toolName: string): boolean =>
  UNFENCEABLE_WRITE_TOOLS.has(toolName)

/**
 * SSOT — how every FS-write-capable tool is CLASSIFIED for the fence (fenced,
 * best-effort, fail-closed, or out-of-scope). This map is the structural
 * anti-drift device: the jul-19 apply_patch fix and the jul-26 field/fail-closed
 * fix were both INCOMPLETE (each closed the tools someone happened to remember),
 * because nothing tied the fence's closed tool-sets back to the registry's actual
 * write-capable universe. `ownership-fence-drift-hellgate.test.ts` cross-checks
 * this map against THREE universes — `MUTATING_TOOL_TABLE` (write_filesystem /
 * bash_mutating / git_mutating kinds), the gated tool-surface manifest
 * (risk:"mutating"), AND the LIVE base registry (every `buildDefaultTools()` tool
 * with `isReadOnly()===false`) — so a NEW write tool that isn't classified here
 * fails CI, whether it drifts in via the plan-mode table, the risk tag, or the
 * runtime read-only SSOT.
 *
 * Classes (how the fence handles the tool's write target):
 *   · `leaf`        — target is a top-level `path`/`file` string → `extractWriteEffects`.
 *   · `patch`       — target(s) inside `input.patch` (V4A) → `patchWriteEffects`.
 *   · `field`       — target is a named literal field → `fieldWriteEffects` (+ FIELD_WRITE_TOOLS).
 *   · `shell`       — target(s) inside a shell command → `extractWriteEffects` shell parse.
 *   · `fail-closed` — target not statically knowable → denied under enforcement (UNFENCEABLE_WRITE_TOOLS).
 *   · `non-fs`      — does NOT author arbitrary host-FS content outside `owned`
 *                     (git plumbing / container-scoped / network / in-session
 *                     store / recursively-re-dispatched), so it is OUT OF the
 *                     content-authoring threat model this fence enforces.
 *
 * Honest residual limits (NOT overclaimed):
 *   1. The `shell` class (`bash`/`pty_write`) is BEST-EFFORT, not sound — only
 *      LITERAL shell write targets are extracted; `$VAR`/computed/heredoc targets
 *      escape the owned set (accepted false-negative, see the module header +
 *      circumvention.ts §5). `bash` is a BASE default-ON tool, so this is
 *      reachable in a DEFAULT fenced subagent — the fence is sound for structured
 *      writers, best-effort for shell.
 *   2. A GATED write tool absent from ALL THREE universes (e.g. a future LSP
 *      mutator not in the mutating table, not risk:"mutating", and not a base tool)
 *      would escape the drift guard's universe check — but it is still caught by
 *      the map's own internal-consistency assertions the moment it is added to any
 *      runtime set. (BASE write tools are now fully covered by Universe 3, which
 *      checks the live `isReadOnly()` SSOT directly.) The three-universe net covers
 *      every tool that exists today.
 * These are documented boundaries, not a completeness claim.
 */
export type OwnershipWriteClass = "leaf" | "patch" | "field" | "shell" | "fail-closed" | "non-fs"
export const OWNERSHIP_WRITE_CLASSIFICATION: Readonly<Record<string, OwnershipWriteClass>> =
  Object.freeze({
    // leaf — top-level path/file
    write: "leaf",
    edit: "leaf",
    scripted_replace: "leaf",
    notebook_edit: "leaf",
    xlsx_write: "leaf",
    docx_write: "leaf",
    pptx_write: "leaf",
    file_history_rewind: "leaf",
    lsp_format: "leaf", // v1 no-op; top-level `path` over-covered (harmless)
    // patch — inside input.patch
    apply_patch: "patch",
    apply_patch_structured: "patch",
    // field — named literal field
    image_gen: "field",
    shadow_restore_partial: "field",
    appshot_verify: "field",
    // shell — inside a shell command string. BEST-EFFORT: only literal write
    // targets are extracted; `$VAR`/computed/heredoc escape (accepted FN).
    bash: "shell",
    pty_write: "shell",
    // sep-13 — the six-tool router's `exec_command` runs a model-supplied shell line and
    // exposes it through `extractShellCommand`; `write_stdin` feeds a PTY it started, the
    // same posture as `pty_write`. Classified when every catalogued tool gained a
    // plan-mode row and these became `bash_mutating` there.
    exec_command: "shell",
    write_stdin: "shell",
    // fail-closed — target not statically knowable
    lsp_rename_apply: "fail-closed",
    shadow_rewind: "fail-closed",
    mcp_read_resource: "fail-closed",
    node_repl: "fail-closed",
    skill_create: "fail-closed",
    mcp_connector_install: "fail-closed",
    // non-fs — not arbitrary host-FS content authoring (out of fence scope)
    code_cell: "non-fs", // QuickJS sandbox; in-cell tools re-enter dispatch (re-fenced)
    bash_kill: "non-fs", // signals a process
    subagent_fork: "non-fs", // spawns a child loop (independently fenced)
    branch_search: "non-fs", // git branch search, no arbitrary content write
    pty_attach: "non-fs",
    pty_resize: "non-fs",
    pty_kill: "non-fs",
    // git plumbing — manipulates git state / restores TRACKED content; does NOT
    // author arbitrary model-chosen bytes at a model-chosen path (git layer's
    // concern, out of this fence's content-authoring threat model).
    git_commit: "non-fs",
    git_branch_switch: "non-fs",
    git_stage: "non-fs",
    git_push: "non-fs",
    git_compose_commit: "non-fs",
    git_compose_pr: "non-fs",
    git_status: "non-fs",
    git_diff: "non-fs",
    git_log: "non-fs",
    git_blame: "non-fs",
    git_blame_heatmap: "non-fs",
    git_churn: "non-fs",
    git_moved_code: "non-fs",
    git_conflict_inspect: "non-fs",
    git_review_diff: "non-fs",
    git_upstream_check: "non-fs",
    enter_worktree: "non-fs",
    exit_worktree: "non-fs",
    worktree_status: "non-fs",
    shadow_snapshots: "non-fs", // list/register git-ref snapshots
    shadow_verify: "non-fs", // runs a verify command, no arbitrary content write
    gh_pr_comment: "non-fs", // GitHub network
    gh_pr_create: "non-fs",
    gh_pr_auto_merge: "non-fs",
    gh_pr_edit_labels: "non-fs",
    gh_pr_resolve_thread: "non-fs",
    gh_pr_open: "non-fs", // GitHub network, same posture as gh_pr_create
    // sep-13 — container-scoped: both act inside the container transport, the rationale
    // this class already names.
    container_exec: "non-fs",
    container_write_file: "non-fs",
    // Browser-scoped raw CDP. HONEST RESIDUAL, not a completeness claim: CDP can reach
    // host-side effects (a download directory, for one), which this content-authoring
    // fence does not model. Classifying it `fail-closed` would change enforcement for
    // fenced subagents, and that is a decision, not a catalogue edit.
    browser_cdp: "non-fs",
    // gated risk:"mutating" tools that mutate ONLY a non-FS surface
    automation_update: "non-fs", // scheduler engine
    collect_evidence: "non-fs", // exec, no FS content write
    run_tests: "non-fs", // exec
    debug_inspect: "non-fs", // exec
    permission_propose_pattern: "non-fs", // session pattern store
    team_create: "non-fs", // in-session team registry
    team_delete: "non-fs",
    mcp_connector_list: "non-fs", // read/list connectors
    session_config: "non-fs", // session effort store, no FS
    // BASE `test_runner` self-reports isReadOnly()===false and exposes
    // extractShellCommand (its `command`/derived `path` run through the shell), so
    // any redirect write is caught by the shell extractor — classified `shell`.
    // (Distinct from the gated `run_tests`. The mode.ts MUTATING_TOOL_TABLE listed
    // test_runner as read-only `null` — called "a known benign discrepancy" here — until
    // sep-13, when an audit showed that `null` let it write in collaboration-mode plan;
    // it is `bash_mutating` now and the discrepancy is gone.)
    test_runner: "shell",
  })

/** The runtime fence sets, exposed for the drift-guard test to assert they agree
 *  with {@link OWNERSHIP_WRITE_CLASSIFICATION} (single source of truth). */
export const ownershipWriteSets = (): {
  readonly field: readonly string[]
  readonly failClosed: readonly string[]
  readonly patch: readonly string[]
} => ({
  field: [...FIELD_WRITE_TOOLS.keys()],
  failClosed: [...UNFENCEABLE_WRITE_TOOLS],
  patch: [...PATCH_WRITE_TOOLS],
})

/**
 * SECURITY — compose a spawned child subagent's ownership policy with its
 * PARENT's so the child can only ever NARROW the boundary, never widen it.
 *
 * RCA (jul-27 audit HIGH): the fence did not compose across the subagent spawn
 * boundary. `buildChildBase` built the child policy purely from the model-typed
 * `owned_surfaces`/`forbidden_surfaces`, never reading `parent.ownershipPolicy`.
 * So a fenced parent (owned=["src"]) whose menu includes the default-ON `agent`/
 * `subagent_fork` tool could spawn a child with NO owned_surfaces ⇒ child policy
 * `undefined` ⇒ completely UNFENCED (writes anywhere), or a WIDER owned set, or
 * with the parent's `forbidden` dropped — a full escape of the parent's fence.
 *
 * Rule (child ≤ parent, always):
 *   · If the parent is NOT enforced ⇒ the child is fenced only by its own request
 *     (nothing to inherit; byte-identical legacy).
 *   · forbidden = parent.forbidden ∪ child.forbidden (the child may ADD
 *     restrictions, never drop the parent's).
 *   · owned: the child's requested entries are kept only if INSIDE the parent's
 *     owned set (⊆). A child that requests none — or only entries outside the
 *     parent's fence — INHERITS the parent's owned set (never falls to unfenced,
 *     never widens). A partial-overlap request narrows to the parent (fail-safe).
 *   · enforced stays true whenever the parent enforced (a child cannot un-fence
 *     itself by flipping its own runtime flag).
 * All inputs are already CANONICAL absolute paths, so containment composes across
 * differing child cwds.
 */
export const narrowChildOwnership = (
  parent: OwnershipPolicy | undefined,
  child: OwnershipPolicy | undefined,
): OwnershipPolicy | undefined => {
  if (parent?.enforced !== true) return child
  const parentOwned = parent.owned ?? []
  const requested = child?.owned ?? []
  const kept = requested.filter(
    (c) => parentOwned.length === 0 || parentOwned.some((p) => insideOrEqual(c, p)),
  )
  const owned = kept.length > 0 ? kept : parentOwned
  const forbidden = [...(parent.forbidden ?? []), ...(child?.forbidden ?? [])]
  return {
    ...(owned.length > 0 ? { owned } : {}),
    ...(forbidden.length > 0 ? { forbidden } : {}),
    enforced: true,
  }
}

/** Build a policy from the raw subagent surfaces (relative or absolute strings),
 *  canonicalizing each against `cwd`. Returns `undefined` when neither side has
 *  any entry (⇒ the dispatch gate is never armed). */
export const buildOwnershipPolicy = (args: {
  readonly owned?: readonly string[]
  readonly forbidden?: readonly string[]
  readonly cwd: string
  readonly enforced: boolean
}): OwnershipPolicy | undefined => {
  const owned = (args.owned ?? []).filter((s) => s.trim().length > 0)
  const forbidden = (args.forbidden ?? []).filter((s) => s.trim().length > 0)
  if (owned.length === 0 && forbidden.length === 0) return undefined
  return {
    ...(owned.length > 0 ? { owned: owned.map((p) => canonicalizePath(p, args.cwd)) } : {}),
    ...(forbidden.length > 0
      ? { forbidden: forbidden.map((p) => canonicalizePath(p, args.cwd)) }
      : {}),
    enforced: args.enforced,
  }
}
