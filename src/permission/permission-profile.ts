/**
 * ADR-0135 — Permission profile + file_system_sandbox_policy 2-layer + 4-pillar
 * + 4-tier Scope.
 *
 * This is the canonical type catalogue for the layered permission model. Pure
 * types and small helpers only — NO IO, NO state. The runtime store (in
 * `permission-store.ts`) and the access checker (in `access-check.ts`) consume
 * these shapes.
 *
 * Two layers (AND-conditioned, see {@link canAccess} in `access-check.ts`):
 *   1. {@link PermissionProfile.fileSystem} — "user-granted access"
 *   2. {@link FileSystemSandboxPolicy}     — "OS-level sandbox exposure"
 *
 * Four pillars under {@link PermissionProfile}:
 *   - approval (HITL 4-tier, wraps ADR-0047)
 *   - network  (deny-all / allow-list / allow-all)
 *   - sandbox  (osSandbox enum from [[codex-seatbelt-sandbox-profile]])
 *   - control  (managed-by + audit_required)
 *
 * Four tiers of {@link PermissionScope} (precedence: managed > project > user > open).
 *
 * Slice rules: leaf-friendly — depends ONLY on `@/shared` (no runtime IO,
 * no `@/storage`). The store layers persistence on top.
 */

/** Eight named OS-aware path roots. Special paths avoid hard-coding host
 *  conventions in the profile JSON. The resolver in `special-path-resolver.ts`
 *  expands these to absolute paths at access-check time. */
export type SpecialPathKind =
  | "root"
  | "project"
  | "tmpdir"
  | "git"
  | "agents"
  | "quanta"
  | "slash_tmp"
  | "tmp"

/** All `SpecialPathKind` values as a runtime tuple — used for exhaustive
 *  enumeration in tests and helper code without re-declaring the union. */
export const SPECIAL_PATH_KINDS = [
  "root",
  "project",
  "tmpdir",
  "git",
  "agents",
  "quanta",
  "slash_tmp",
  "tmp",
] as const satisfies ReadonlyArray<SpecialPathKind>

/** Discriminated union — either a named special path (resolver-expanded) or
 *  a literal absolute path string. The discriminant `type` keeps the JSON
 *  shape self-describing (no out-of-band tag inference). */
export type FileSystemPath =
  | { readonly type: "special"; readonly kind: SpecialPathKind }
  | { readonly type: "path"; readonly value: string }

/** Access mode on a {@link FileSystemPath}. A `write` entry implies `read`
 *  by convention (write requires read in POSIX), but the access checker
 *  enforces the literal mode requested — callers are responsible for asking
 *  for the mode they need. */
export type FileSystemAccess = "read" | "write"

/** One row of a {@link PermissionProfile.fileSystem.entries} table. The
 *  policy is allow-list — only paths with a matching entry (and matching
 *  access mode) are allowed; everything else denies. */
export interface FileSystemEntry {
  readonly path: FileSystemPath
  readonly access: FileSystemAccess
}

/** Top-level mode on the file-system table:
 *  - `restricted` — strict allow-list; an entry is required.
 *  - `managed`    — org-policy enforced; user cannot override.
 *
 *  Both modes share the same `entries` semantics (allow-list); the difference
 *  is who can mutate the table (operator vs. admin — control pillar enforces). */
export type FileSystemPolicyType = "restricted" | "managed"

/** ADR-0047 HITL 4-tier wrapped as an approval policy. `promptUser=false`
 *  silently fails on missing approval (used by background subagents that
 *  must never hang on a prompt). */
export type ApprovalMode = "auto" | "once" | "session" | "always"

export interface ApprovalPolicy {
  readonly mode: ApprovalMode
  readonly promptUser: boolean
}

/** Network egress policy. `allowHosts` is honored only when `mode=allow-list`.
 *  `perRequestApproval=true` requires user confirmation on every outbound
 *  call even within the allow-list (CI-bot / sensitive context). */
export type NetworkMode = "deny-all" | "allow-list" | "allow-all"

export interface NetworkPolicy {
  readonly mode: NetworkMode
  readonly allowHosts?: ReadonlyArray<string>
  readonly perRequestApproval?: boolean
}

/** OS sandbox profile reference — [[codex-seatbelt-sandbox-profile]]. `none`
 *  is explicit (no sandbox); the access checker still applies. */
export type OsSandboxKind = "seatbelt" | "landlock" | "windows-sandbox" | "none"

export interface SandboxPolicy {
  readonly osSandbox: OsSandboxKind
  readonly readOnly: boolean
  readonly workspaceWrite: boolean
  readonly networkIsolated: boolean
}

/** Admin / team override prevention. When `managedBy="admin"` the profile is
 *  locked — caller-side write APIs reject mutations. `auditRequired=true`
 *  forces every access decision through the recorder (which the gate already
 *  emits — this just promotes opt-in to mandatory). */
export type ControlManagedBy = "user" | "team" | "admin"

export interface ControlPolicy {
  readonly managedBy?: ControlManagedBy
  readonly auditRequired: boolean
}

/** Layer 1: user-granted permission profile. Carries the 4 pillars + the
 *  file-system allow-list. */
export interface PermissionProfile {
  readonly fileSystem: {
    readonly type: FileSystemPolicyType
    readonly entries: ReadonlyArray<FileSystemEntry>
  }
  readonly approval: ApprovalPolicy
  readonly network: NetworkPolicy
  readonly sandbox: SandboxPolicy
  readonly control: ControlPolicy
}

/** Layer 2: OS-level sandbox exposure. Same shape as
 *  {@link PermissionProfile.fileSystem} but a separate instance — the AND
 *  condition between layers is what makes this two-layer model strictly
 *  stronger than single-layer. */
export interface FileSystemSandboxPolicy {
  readonly type: FileSystemPolicyType
  readonly entries: ReadonlyArray<FileSystemEntry>
}

/** 4-tier scope ordering. `managed` overrides everything (org-policy);
 *  `project` overrides `user`; `open` is the public/anyone tier. Precedence
 *  is encoded by {@link PERMISSION_SCOPE_PRECEDENCE_DESC} so callers
 *  resolving conflicts iterate from strongest to weakest. */
export type PermissionScope = "user" | "project" | "managed" | "open"

/** All scopes ordered strongest → weakest. Use `.indexOf(x) - .indexOf(y)`
 *  for a numeric precedence delta. */
export const PERMISSION_SCOPE_PRECEDENCE_DESC = [
  "managed",
  "project",
  "user",
  "open",
] as const satisfies ReadonlyArray<PermissionScope>

/** Type guard — narrows `string` to {@link PermissionScope}. Used at the JSON
 *  parse boundary (envelope decode / profile load). */
export const isPermissionScope = (s: string): s is PermissionScope =>
  s === "user" || s === "project" || s === "managed" || s === "open"

/** Type guard for {@link SpecialPathKind}. */
export const isSpecialPathKind = (s: string): s is SpecialPathKind =>
  s === "root" ||
  s === "project" ||
  s === "tmpdir" ||
  s === "git" ||
  s === "agents" ||
  s === "quanta" ||
  s === "slash_tmp" ||
  s === "tmp"

/** Return strongest of two scopes (lower index in
 *  {@link PERMISSION_SCOPE_PRECEDENCE_DESC} wins). Useful when stacking
 *  multiple scope sources. */
export const strongerScope = (a: PermissionScope, b: PermissionScope): PermissionScope => {
  const ai = PERMISSION_SCOPE_PRECEDENCE_DESC.indexOf(a)
  const bi = PERMISSION_SCOPE_PRECEDENCE_DESC.indexOf(b)
  return ai <= bi ? a : b
}

/** Canonical default profile. Locked-down by design:
 *  - file-system: restricted + empty entries (deny everything explicit)
 *  - approval:    once + prompt user
 *  - network:     deny-all
 *  - sandbox:     no OS sandbox, read-only, workspace-write off, network
 *                 isolated (the strictest sensible default)
 *  - control:     user-managed, audit NOT required
 *
 *  Callers (composition root) override piecewise. The default is what an
 *  unconfigured envelope decode produces for backward compat (see
 *  `envelope.ts`). */
export const DEFAULT_PERMISSION_PROFILE: PermissionProfile = Object.freeze({
  fileSystem: Object.freeze({
    type: "restricted" as const,
    entries: Object.freeze([] as ReadonlyArray<FileSystemEntry>),
  }),
  approval: Object.freeze({ mode: "once" as const, promptUser: true }),
  network: Object.freeze({ mode: "deny-all" as const }),
  sandbox: Object.freeze({
    osSandbox: "none" as const,
    readOnly: true,
    workspaceWrite: false,
    networkIsolated: true,
  }),
  control: Object.freeze({ auditRequired: false }),
}) as PermissionProfile

/** Canonical default for the second layer — also locked-down. Restricted +
 *  empty entries means access is denied unless explicitly granted by both
 *  layers. */
export const DEFAULT_FILE_SYSTEM_SANDBOX_POLICY: FileSystemSandboxPolicy = Object.freeze({
  type: "restricted" as const,
  entries: Object.freeze([] as ReadonlyArray<FileSystemEntry>),
}) as FileSystemSandboxPolicy
