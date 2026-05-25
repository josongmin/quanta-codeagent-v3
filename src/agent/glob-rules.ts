import { lstat, readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  createDefaultVendorDetector,
  type DetectedRule,
  VENDOR_PRIORITY,
  type VendorDetectorPort,
  type VendorId,
} from "@/rules"
import { matchesAnyGlob, parseFrontmatter } from "../skill"

/**
 * File-scoped rule auto-injection (Cursor `.cursor/rules/*.mdc` parity — the
 * glob-matched + always-applied rule types).
 *
 * Cursor advertises four rule kinds: always-applied, glob-matched,
 * agent-requestable (lazy body), and manual (@-mention). This module implements
 * the two that AUTO-INJECT into the prompt without the model asking:
 *
 *   - `alwaysApply: true`  → body rides every turn (repo authority, file-agnostic)
 *   - `globs: [...]`       → body rides ONLY on turns whose `changedPaths`
 *                            include a file matching one of the globs.
 *
 * (agent-requestable / manual are out of scope here: the former is the existing
 * `Skill` progressive-disclosure path; the latter is a user-mention surface.)
 *
 * Distinct from `repo-rules.ts`: that loader ingests ONE top-level operational
 * contract (AGENTS.md/CLAUDE.md) whole, every turn. THIS loader ingests MANY
 * small file-scoped rules and selects per turn by the files in play — so a
 * "React component conventions" rule only burns prompt budget on turns that
 * actually touch `*.tsx`.
 *
 * Opt-in: the loop only consults `config.globRules` when a caller wires it
 * (typically via `loadGlobRules(cwd)` at session start + a per-turn
 * `changedPaths`). Absent ⇒ no block, byte-identical (RFC §1.2 default-OFF).
 */

/** Directories scanned for rule files, in priority order. `.cursor/rules` is
 *  the Cursor convention; `.quanta/rules` is the native path. Both are scanned;
 *  a rule's source basename is cited in the rendered block so the model can
 *  attribute authority. */
export const GLOB_RULE_DIRS = [".cursor/rules", ".quanta/rules"] as const

/** Rule file extensions recognised (`.mdc` is Cursor's; `.md` is native). */
const RULE_EXTENSIONS = [".mdc", ".md"] as const

/** Per-rule body cap. A runaway rule file is truncated with a marker rather
 *  than rejected — usability over a hard fail, but it cannot blow the budget. */
export const MAX_RULE_BYTES = 16 * 1024

/** Cap on the TOTAL bytes the rendered glob-rules block contributes to the
 *  per-turn prompt. Without this, a malicious repo with N×`alwaysApply: true`
 *  rule files would inject N × MAX_RULE_BYTES every turn, blowing the prompt
 *  budget (and the provider's token limit). Matches the 64 KiB cap repo-rules
 *  uses for its single-file body — same scale, same per-turn budget posture.
 *  When the cap is hit, later rules are dropped with an explicit marker so
 *  the model (and auditor) can see the truncation. */
export const MAX_RENDER_BYTES = 64 * 1024

/** Cap on the NUMBER of rule files loaded from disk. The render-bytes cap above
 *  bounds total output size, but `selectGlobRules` still does N rules × K paths
 *  matchesAnyGlob calls every turn. The audit measured a 10000-rule directory
 *  causing ~56s `selectGlobRules` per turn when globs no-match-exhaust — the
 *  render cap is useless if the loop freezes before reaching the renderer. 256
 *  covers any realistic repo (a real `.cursor/rules` directory ships at most a
 *  few dozen files); above that, additional files are silently dropped so a
 *  hostile repo (or a misconfigured one) can't pin CPU per turn. */
export const MAX_RULE_FILES = 256

/** A discovered file-scoped rule. */
export interface GlobRule {
  /** Absolute path the rule was loaded from. */
  sourcePath: string
  /** Frontmatter `description`, if declared (advisory; rendered as a hint). */
  description?: string
  /** Frontmatter `globs` — files this rule scopes to. Empty when the rule is
   *  `alwaysApply` (or declared neither, in which case it never auto-injects). */
  globs: string[]
  /** Frontmatter `alwaysApply: true` ⇒ injected every turn regardless of globs. */
  alwaysApply: boolean
  /** Markdown body after the frontmatter (the actual instruction). */
  body: string
}

/** Normalize a frontmatter `globs` value (string | string[] | absent) to a
 *  trimmed, non-empty string[]. A bare string is comma-split (Cursor's `.mdc`
 *  writes `globs: *.ts,*.tsx`); an array is taken as-is. */
const normalizeGlobs = (raw: string | string[] | undefined): string[] => {
  if (raw === undefined) return []
  const parts = Array.isArray(raw) ? raw : raw.split(",")
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

/** Parse one rule file into a {@link GlobRule}, or `undefined` when it is a
 *  symlink, not a regular file, unreadable, has an empty body, or declares
 *  neither `globs` nor `alwaysApply` (a rule that can never inject is dropped
 *  so it doesn't masquerade as active). */
const tryLoadRule = async (path: string): Promise<GlobRule | undefined> => {
  try {
    // SECURITY: reject symlinks for the same reason repo-rules.ts does — a
    // symlinked rule file could point at a secret (`~/.ssh/id_rsa`) and its
    // contents would ride into the prompt as authority. `lstat` does not follow.
    const st = await lstat(path)
    if (st.isSymbolicLink() || !st.isFile()) return undefined
    const raw = await readFile(path, "utf8")
    const { data, body } = parseFrontmatter(raw)
    const trimmed = body.trim()
    if (trimmed.length === 0) return undefined
    const globs = normalizeGlobs(data.globs as string | string[] | undefined)
    // `parseFrontmatter` yields string scalars, so a YAML `true` arrives as the
    // string "true" (case-insensitive tolerance for hand-written rule files).
    const alwaysApply =
      typeof data.alwaysApply === "string" && data.alwaysApply.toLowerCase() === "true"
    // A rule with neither globs nor alwaysApply can never auto-inject — drop it.
    if (globs.length === 0 && !alwaysApply) return undefined
    const cappedBody =
      trimmed.length > MAX_RULE_BYTES
        ? `${trimmed.slice(0, MAX_RULE_BYTES)}\n\n[truncated: ${trimmed.length} bytes total]`
        : trimmed
    // YAML fold-scalar guard: the dependency-free parser does not implement
    // `>` / `|` folding — a YAML-shaped multiline description like
    //   description: >
    //     line one
    //     line two
    // arrives with `description === ">"` (just the indicator) and the
    // continuation lines silently dropped. Treat a bare fold-indicator as
    // absent rather than rendering the literal `>` as authority surface.
    const rawDesc = typeof data.description === "string" ? data.description.trim() : ""
    const description =
      rawDesc.length > 0 && rawDesc !== ">" && rawDesc !== "|" ? rawDesc : undefined
    return {
      sourcePath: path,
      ...(description !== undefined ? { description } : {}),
      globs,
      alwaysApply,
      body: cappedBody,
    }
  } catch {
    // ENOENT / EACCES / parse failure ⇒ skip this file (best-effort loader).
    return undefined
  }
}

/** Load every file-scoped rule under `cwd`'s rule directories. Returns `[]`
 *  when no rule directory exists or none parse — the byte-identical no-op.
 *  Files are loaded in a deterministic order (dir priority, then sorted name)
 *  so the rendered block is stable across runs. Stops after {@link
 *  MAX_RULE_FILES} successfully-loaded rules — the per-turn `selectGlobRules`
 *  cost is O(N rules × K paths) and an unbounded N is the DoS-via-rule-count
 *  vector the audit measured (10k rules ⇒ ~56s/turn). Read ONCE per session
 *  by convention (the loop snapshots the result; selection is per-turn). */
export const loadGlobRules = async (cwd: string): Promise<GlobRule[]> => {
  const rules: GlobRule[] = []
  for (const dir of GLOB_RULE_DIRS) {
    if (rules.length >= MAX_RULE_FILES) break
    const abs = join(cwd, dir)
    let names: string[]
    try {
      names = await readdir(abs)
    } catch {
      continue // directory absent ⇒ skip
    }
    for (const name of [...names].sort()) {
      if (rules.length >= MAX_RULE_FILES) break
      if (!RULE_EXTENSIONS.some((ext) => name.endsWith(ext))) continue
      const rule = await tryLoadRule(join(abs, name))
      if (rule) rules.push(rule)
    }
  }
  return rules
}

/**
 * Select the rules that apply THIS turn: every `alwaysApply` rule (regardless
 * of `changedPaths`), plus every glob rule with a glob matching any changed
 * path. Pure — the loop computes `changedPaths` and calls this each turn.
 * `changedPaths` paths are matched with the same gitignore-ish semantics the
 * skill `paths:` filter uses (basename-anywhere when the glob has no `/`).
 */
export const selectGlobRules = (rules: GlobRule[], changedPaths: string[]): GlobRule[] =>
  rules.filter(
    (r) =>
      r.alwaysApply || changedPaths.some((p) => r.globs.length > 0 && matchesAnyGlob(p, r.globs)),
  )

/** Render selected rules as the per-turn `<system-reminder>` section. Returns
 *  `undefined` when the selection is empty (nothing to inject). Each rule cites
 *  its source basename + scope so the model treats it as file-scoped repo
 *  authority.
 *
 *  Budget: rules are emitted in order until cumulative bytes would exceed
 *  {@link MAX_RENDER_BYTES}; remaining rules are dropped with an explicit
 *  truncation marker so the model (and an auditor) can see what was cut. This
 *  is the DoS guard against a repo planting many `alwaysApply: true` files. */
export const renderGlobRulesBlock = (rules: GlobRule[]): string | undefined => {
  if (rules.length === 0) return undefined
  const sections: string[] = []
  let used = 0
  let droppedAt = -1
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] as GlobRule
    const scope = r.alwaysApply ? "always" : `globs: ${r.globs.join(", ")}`
    const name = basename(r.sourcePath)
    const desc = r.description !== undefined ? ` — ${r.description}` : ""
    const section = `### ${name} (${scope})${desc}\n${r.body}`
    // +2 accounts for the `\n\n` joiner between sections (over-counts on the
    // last section but that just makes the cap slightly stricter — safe).
    if (used + section.length + 2 > MAX_RENDER_BYTES) {
      droppedAt = i
      break
    }
    sections.push(section)
    used += section.length + 2
  }
  const truncation =
    droppedAt >= 0
      ? `\n\n[truncated: ${rules.length - droppedAt} more rule(s) dropped; cumulative body exceeded ${MAX_RENDER_BYTES} bytes]`
      : ""
  return `## File-scoped rules\nThese rules apply to files in scope this turn; treat them as repo authority.\n\n${sections.join("\n\n")}${truncation}`
}

// ─── ADR-0233 (Wire 2) — vendor-detector composition ────────────────────
//
// `loadGlobRulesWithVendors(cwd, opts)` is the OPT-IN superset of
// `loadGlobRules(cwd)`: it pulls the legacy single-source result AND
// composes it with `DetectedRule[]` from the ADR-0205 multi-source vendor
// detector. Default-OFF: when `opts.vendorDetectorEnabled !== true` (or
// `opts` is absent) the function returns IDENTICALLY the legacy
// `loadGlobRules(cwd)` output — byte-identical for every existing caller.
//
// Why a composer, not an "auto-include in loadGlobRules": legacy callers
// (CLI rule-indicator, every wired host) treat `loadGlobRules` as the
// stable surface. A silent widening would regress repos that intentionally
// keep `.cursor/rules/*` ignored. The composer is a NEW surface; opt-in
// is the only way the detector ever runs.
//
// Conversion: `DetectedRule.trigger` already carries `alwaysApply +
// globs`, the exact shape `GlobRule` needs. We don't try to round-trip
// vendor-specific metadata into the GlobRule body — the body is what the
// model reads; metadata is detector-side diagnostics only.

/** Map from {@link VendorId} → numeric priority (lower wins on path
 *  collision). Built from the canonical {@link VENDOR_PRIORITY} table
 *  ONCE; an `opts.priority` override produces a per-call reorder. */
const buildPriorityOf = (
  override: ReadonlyArray<VendorId> | undefined,
): Readonly<Record<VendorId, number>> => {
  if (override === undefined) return VENDOR_PRIORITY
  // `override` defines explicit precedence for the listed vendors; any
  // VendorId absent from the override falls back to its canonical
  // priority but offset PAST the override's length so a partial list
  // ("priority: ['cursor']") still puts cursor first and leaves the
  // canonical relative order of the rest intact.
  const next: Record<VendorId, number> = { ...VENDOR_PRIORITY }
  const seen = new Set<VendorId>()
  for (let i = 0; i < override.length; i += 1) {
    const v = override[i] as VendorId
    if (seen.has(v)) continue
    seen.add(v)
    next[v] = i
  }
  // Bump unmentioned vendors past the override head so the partial
  // override's intent is preserved (the override is "these win first").
  const offset = override.length
  for (const v of Object.keys(VENDOR_PRIORITY) as VendorId[]) {
    if (!seen.has(v)) {
      next[v] = VENDOR_PRIORITY[v] + offset
    }
  }
  return Object.freeze(next)
}

/** Convert one `DetectedRule` → `GlobRule` (the shape glob-rules.ts
 *  consumes downstream). Body is taken as-is (the normalizer already
 *  capped it at the detector's `maxBodyBytes`); description is dropped
 *  if empty (matches `tryLoadRule` posture). Returns `undefined` for
 *  rules that can never auto-inject (mirrors {@link tryLoadRule}). */
const detectedToGlobRule = (d: DetectedRule): GlobRule | undefined => {
  const alwaysApply = d.trigger.alwaysApply === true
  const globs = [...d.trigger.globs]
  if (!alwaysApply && globs.length === 0) return undefined
  const body = d.body.trim()
  if (body.length === 0) return undefined
  const description = d.description.trim().length > 0 ? d.description.trim() : undefined
  return {
    sourcePath: d.sourcePath,
    ...(description !== undefined ? { description } : {}),
    globs,
    alwaysApply,
    body,
  }
}

/** Compose `legacyRules` (from `loadGlobRules`) with `detected` (from
 *  `VendorDetectorPort.detectAll`). Deduplication is by absolute
 *  `sourcePath`; on collision the vendor with the LOWER priority index
 *  wins (per the resolved {@link buildPriorityOf} table).
 *
 *  Legacy rules carry no vendor tag — we treat them as `"quanta"` for
 *  priority purposes (the legacy loader walks `.quanta/rules` first, so
 *  attributing legacy rules to quanta keeps the existing precedence
 *  semantics: a user's native quanta config STILL beats a foreign-vendor
 *  rule at the same path).
 *
 *  The function is EXPORTED (separate from `loadGlobRulesWithVendors`)
 *  so a host that already has both lists can compose without re-running
 *  I/O — the cli rule-indicator does exactly this. */
export const composeGlobRulesWithDetected = (
  legacyRules: ReadonlyArray<GlobRule>,
  detected: ReadonlyArray<DetectedRule>,
  opts?: {
    /** Subset filter; ABSENT ⇒ all 6 vendors. Unknown ids are ignored. */
    readonly vendors?: ReadonlyArray<VendorId>
    /** Per-call priority override; ABSENT ⇒ canonical order. */
    readonly priority?: ReadonlyArray<VendorId>
  },
): GlobRule[] => {
  const priorityOf = buildPriorityOf(opts?.priority)
  const allowed: ReadonlySet<VendorId> | undefined =
    opts?.vendors !== undefined ? new Set<VendorId>(opts.vendors) : undefined
  // Keyed by absolute sourcePath. Each entry carries the chosen vendor's
  // priority + the resulting GlobRule.
  const byPath = new Map<string, { priority: number; rule: GlobRule }>()
  // Legacy rules first — they are quanta-equivalent for precedence.
  const legacyPriority = priorityOf.quanta
  for (const r of legacyRules) {
    byPath.set(r.sourcePath, { priority: legacyPriority, rule: r })
  }
  // Detector rules second; collision-resolve by priority. We honour
  // `MAX_RULE_FILES` here too — composition cannot blow the per-turn
  // selector's O(N) cost.
  for (const d of detected) {
    if (byPath.size >= MAX_RULE_FILES) break
    if (allowed !== undefined && !allowed.has(d.vendor)) continue
    const g = detectedToGlobRule(d)
    if (g === undefined) continue
    const pri = priorityOf[d.vendor]
    const existing = byPath.get(g.sourcePath)
    if (existing === undefined) {
      byPath.set(g.sourcePath, { priority: pri, rule: g })
      continue
    }
    // Lower index wins; if equal, KEEP the first writer (legacy already
    // sat there, so legacy wins on ties — matches the "user's native
    // config is authoritative" posture from the vendor table doc).
    if (pri < existing.priority) {
      byPath.set(g.sourcePath, { priority: pri, rule: g })
    }
  }
  // Stable sort: priority asc, then sourcePath asc.
  const out = Array.from(byPath.values())
  out.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    if (a.rule.sourcePath < b.rule.sourcePath) return -1
    if (a.rule.sourcePath > b.rule.sourcePath) return 1
    return 0
  })
  return out.map((x) => x.rule)
}

/** Options for {@link loadGlobRulesWithVendors}. Mirrors the
 *  {@link RulesConfigBlock} surface from `@/agent/types`. */
export interface LoadGlobRulesWithVendorsOpts {
  readonly vendorDetectorEnabled?: boolean
  readonly detector?: VendorDetectorPort
  readonly vendors?: ReadonlyArray<VendorId>
  readonly priority?: ReadonlyArray<VendorId>
}

/** OPT-IN composer for ADR-0205 multi-vendor rule detection. Returns
 *  the byte-identical `loadGlobRules(cwd)` output when
 *  `opts?.vendorDetectorEnabled !== true` (or when the optional detector
 *  throws — the no-throw contract is enforced here). When enabled and
 *  the detector returns rules, the legacy + detected sets are deduped
 *  by sourcePath using {@link composeGlobRulesWithDetected}. */
export const loadGlobRulesWithVendors = async (
  cwd: string,
  opts?: LoadGlobRulesWithVendorsOpts,
): Promise<GlobRule[]> => {
  const legacy = await loadGlobRules(cwd)
  // Default-OFF: composer is silent unless explicitly enabled.
  if (opts === undefined || opts.vendorDetectorEnabled !== true) {
    return legacy
  }
  const detector = opts.detector ?? createDefaultVendorDetector()
  // No-throw: a buggy detector cannot derail session start. We catch
  // EVERY failure and fall back to the legacy output (the user-facing
  // surface is "auto-detect best-effort"; rule-load failures show up
  // via the detector's `DetectorError` list, not via session crash).
  let detected: ReadonlyArray<DetectedRule>
  try {
    const result = await detector.detectAll({ cwd })
    detected = result.rules
  } catch {
    return legacy
  }
  return composeGlobRulesWithDetected(legacy, detected, {
    ...(opts.vendors !== undefined ? { vendors: opts.vendors } : {}),
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
  })
}
