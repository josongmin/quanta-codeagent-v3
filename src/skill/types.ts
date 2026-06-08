/**
 * Skill slice public types (T1.C). Faithful-minimal port of Claude Code v2's
 * skill system (see docs/analysis/skill-system.md). This slice is
 * self-contained: it MUST NOT import @/agent. It may import @/tool / @/shared.
 *
 * ADR-0134 — 7-scope tiering (builtIn / system / admin / team / repo / user /
 * personal). `Skill.scope` is the canonical tag; precedence is fixed by
 * {@link SKILL_SCOPES_PRECEDENCE_DESC}. `Skill.installState` mirrors Codex's
 * required/recommended/optional triad — admin scope is force-pinned to
 * "required" at parse time (see {@link skill-frontmatter.ts}).
 */

import type { ThinClientRoute } from "@/shared"

/** Effort override a skill may declare. Mirrors CC's low|medium|high|max|<int>. */
export type SkillEffort = "low" | "medium" | "high" | "max" | number

/**
 * Skill scope (ADR-0134). Closed union: callers MUST NOT pass any string at
 * the type level. Runtime guard {@link isSkillScope} is provided for boundary
 * validation (frontmatter, CLI argv).
 */
export type SkillScope = "builtIn" | "system" | "admin" | "team" | "repo" | "user" | "personal"

/** All scope literals — single source of truth for Zod / CLI / docs. */
export const SKILL_SCOPES: readonly SkillScope[] = [
  "builtIn",
  "system",
  "admin",
  "team",
  "repo",
  "user",
  "personal",
] as const

/**
 * Lookup precedence (ADR-0134 §1 — highest wins on name collision). Order is
 * fixed by convention (admin > repo > team > user > personal > system >
 * builtIn) — see ADR §1 "Precedence rationale". A registry uses this list to
 * resolve `lookup(name)`.
 */
export const SKILL_SCOPES_PRECEDENCE_DESC: readonly SkillScope[] = [
  "admin",
  "repo",
  "team",
  "user",
  "personal",
  "system",
  "builtIn",
] as const

/** Runtime type guard for {@link SkillScope}. */
export const isSkillScope = (v: unknown): v is SkillScope =>
  typeof v === "string" && (SKILL_SCOPES as readonly string[]).includes(v)

/**
 * Install state (ADR-0134 §2). `required` = host MUST surface (admin scope
 * always lands here), `recommended` = strong default, `optional` = pure
 * opt-in. Field is optional on {@link Skill} — absent ⇒ host treats as
 * "optional" by convention.
 */
export type SkillInstallState = "required" | "recommended" | "optional"

/** All install-state literals — single source of truth for Zod / CLI. */
export const SKILL_INSTALL_STATES: readonly SkillInstallState[] = [
  "required",
  "recommended",
  "optional",
] as const

/** Runtime type guard for {@link SkillInstallState}. */
export const isSkillInstallState = (v: unknown): v is SkillInstallState =>
  typeof v === "string" && (SKILL_INSTALL_STATES as readonly string[]).includes(v)

/**
 * A discovered skill. `body` is the markdown instructions injected into the
 * model context when the skill is invoked. The scoping fields (`tools`,
 * `model`, `effort`) are ADVISORY author-declared metadata only: this slice
 * neither enforces them nor wires any permission/model seam. A host that wants
 * enforcement must read them (see `skillToolAllowlist`) and apply them itself.
 *
 * ADR-0134 fields:
 *  - {@link scope}: required tag (set by discovery — explicit frontmatter or
 *    path-inferred fallback).
 *  - {@link installState}: optional install posture (admin scope ⇒ "required").
 *  - {@link adminInstalledBy}: org identifier when scope === "admin".
 */
export interface Skill {
  /** Stable id — directory name (or file basename for `<dir>/*.md`). */
  name: string
  /** Frontmatter `description` (falls back to first body line if absent). */
  description: string
  /** Markdown body after the frontmatter block. */
  body: string
  /** Frontmatter `tools:` allowlist, if declared. */
  tools?: string[]
  /** Frontmatter `model:` override, if declared (e.g. "inherit" or a model id). */
  model?: string
  /** Frontmatter `effort:` override, if declared. */
  effort?: SkillEffort
  /** Frontmatter `paths:` globs for conditional activation, if declared. */
  paths?: string[]
  /** Absolute path the skill was loaded from (SKILL.md or *.md). */
  sourcePath: string
  /**
   * ADR-0134 scope tag. Optional at the TYPE level for backward compat with
   * pre-0134 test fixtures and host-constructed literals, but discovery
   * (`discoverSkills` / `discoverSystemSkills`) ALWAYS populates it.
   * Use {@link skillScope} for a guaranteed-non-null view.
   */
  readonly scope?: SkillScope
  /** ADR-0134 install state — absent means host treats as "optional". */
  readonly installState?: SkillInstallState
  /** ADR-0134 admin install attribution — only set when scope === "admin". */
  readonly adminInstalledBy?: string | null
  /**
   * ADR-0457 — frontmatter `argument-hint` (kebab key), the codex usage hint
   * shown after the skill name in a listing (e.g. `rr [scope]`). Optional /
   * additive: a skill without it renders exactly as before.
   */
  readonly argumentHint?: string
  /**
   * ADR-0457 — frontmatter `metadata.short-description`, a guaranteed-short
   * UI blurb codex authors declare under the nested `metadata:` block. When
   * present, a listing prefers it over the (potentially long) `description`.
   */
  readonly shortDescription?: string
  /**
   * ADR-0457 — bundled-resource inventory (codex skill ECOSYSTEM). Populated by
   * discovery for directory-form skills that ship `agents/` / `scripts/` /
   * `references/` / `assets/` subdirs. Absent when none exist.
   */
  readonly resources?: SkillResources
  /**
   * ADR-0476 — the skill's raw frontmatter `dependencies` block (the
   * `{ tools: unknown[] }` shape `liftRawDependenciesBlock` returns), captured
   * at discovery from the full SKILL.md content. Absent when the skill declares
   * no `dependencies:` block. The skill→MCP reconcile (`parseSkillMcpDeps`)
   * consumes this raw block; the gate (`QUANTA_SKILL_MCP_DEPS`) governs whether
   * it is acted on. Additive: a skill without a deps block is byte-identical.
   */
  readonly rawDependencies?: unknown
  /**
   * ADR-0493 — frontmatter `thin-client-dispatch` route tag. Tells a thin host
   * (web/ide) HOW to run this skill: "local" | "post-text" | "control-request".
   * Absent / invalid ⇒ "local". Consumed by `resolveThinClientRoute`
   * (`@/agent/thin-client-dispatch`) under the `QUANTA_THIN_CLIENT_DISPATCH`
   * gate; additive and byte-identical when absent.
   */
  readonly thinClientDispatch?: ThinClientRoute
  /**
   * §2.3 — codex `agents/openai.yaml` `policy.allow_implicit_invocation`. When
   * FALSE, the skill is NOT injected into the model context by default (the
   * implicit-suggestion inventory), but can STILL be invoked explicitly via the
   * Skill tool / `$skill`. Defaults to true (codex semantics) — ABSENT here
   * means "implicit allowed". Populated by discovery for directory-form skills
   * whose `agents/openai.yaml` declares a `policy:` block; consumed by
   * {@link implicitlyInvocableSkills} (`@/skill/activation`) under the
   * `QUANTA_SKILL_IMPLICIT_POLICY` gate. Additive + byte-identical when absent.
   */
  readonly allowImplicitInvocation?: boolean
}

/**
 * Effective scope of a skill. Returns the tagged value if present, else
 * "builtIn" as the conservative default (pre-0134 in-code constructed Skill
 * objects fall here). Hosts that need a strict tag should populate
 * {@link Skill.scope} at construction.
 */
export const skillScope = (s: Pick<Skill, "scope">): SkillScope => s.scope ?? "builtIn"

/**
 * ADR-0457 — parsed `agents/openai.yaml` `interface:` block (codex skill
 * ECOSYSTEM parity). Every field is optional: the file is product/harness
 * metadata, not agent-facing, and a malformed file is skipped entirely (never
 * crashes discovery). Field names mirror codex's snake_case verbatim in the
 * on-disk shape but are surfaced here in camelCase per quanta convention.
 */
export interface SkillAgentInterface {
  /** Human-facing title shown in a GUI skill list / chip. */
  readonly displayName?: string
  /** Short (25–64 char) UI blurb for quick scanning. */
  readonly shortDescription?: string
  /** Example starting prompt; mentions the skill as `$skill-name`. */
  readonly defaultPrompt?: string
  /** Path (relative to skill dir) to a small icon asset. */
  readonly iconSmall?: string
  /** Path (relative to skill dir) to a larger logo asset. */
  readonly iconLarge?: string
  /** Hex color used for UI accents. */
  readonly brandColor?: string
}

/**
 * ADR-0457 — bundled-resource inventory for a directory-form skill. Only
 * PRESENCE + file-name lists are recorded; `references/` / `assets/` /
 * `scripts/` contents are NOT loaded into context (on-demand only — token
 * discipline; the skill body reads them via the normal read tool when needed).
 * `agentsYaml` is the parsed `interface:` block of `agents/openai.yaml`, if the
 * file exists and parsed cleanly (malformed ⇒ omitted, discovery never crashes).
 */
export interface SkillResources {
  /** Parsed `agents/openai.yaml` `interface:` block, if present + well-formed. */
  readonly agentsYaml?: SkillAgentInterface
  /** File names directly inside `scripts/` (executable automation). */
  readonly scripts?: readonly string[]
  /** File names directly inside `references/` (on-demand docs). */
  readonly references?: readonly string[]
  /** File names directly inside `assets/` (output / icon files). */
  readonly assets?: readonly string[]
}

/** Parsed frontmatter + body, before being shaped into a {@link Skill}. */
export interface ParsedFrontmatter {
  data: Record<string, string | string[]>
  body: string
}
