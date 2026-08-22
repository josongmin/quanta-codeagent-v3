/**
 * Declarative vendor table — the SSOT for which vendors we detect and where
 * their rule files live.
 *
 * The table is a pure data structure: no I/O, no side effects. Adding a new
 * vendor is a one-line entry here plus a parser entry in `normalizer.ts`.
 * Vendor priority for collision resolution is encoded by ARRAY ORDER (first
 * entry = highest priority). When the same on-disk path is claimed by two
 * vendors (e.g. a custom layout that puts `.cursor/rules/foo.md` in our
 * `.quanta/rules/` directory by symlink), `.quanta` wins by declarative
 * intent — the user's NATIVE config is authoritative over a foreign-vendor
 * fallback. This is intentional and surfaced in `normalizer.ts` collision
 * tests.
 *
 * `paths` entries are NOT shell globs — they are limited patterns the
 * detector expands directly:
 *
 *   - Plain file path:     `.clinerules`                  → exact file
 *   - Single-dir wildcard: `.cursor/rules/*.mdc`          → readdir + ext filter
 *   - Mode-dir wildcard:   `.roo/rules-*` / `*.md` pair   → walk one level
 *
 * We do not pull in fast-glob: the patterns we accept are bounded by the
 * vendors we list here, and a hand-rolled expander keeps the slice
 * dependency-free (matches the existing glob-rules.ts approach).
 *
 * If a new vendor needs a richer pattern, extend `pattern-kind.ts` (this
 * file's contract is closed; growth happens at the kind enum, not via a
 * generic expander, so the surface stays auditable).
 */

import type { RuleScope, VendorId } from "./port"

/** What flavor of on-disk layout the entry describes. Kept as a closed enum
 *  so the detector can switch-exhaustive without a default branch. */
export type PathKind =
  /** A single file at a known relative path. */
  | "file"
  /** A directory whose immediate children with one of `extensions` are rule
   *  files. */
  | "dir"
  /** A "mode-dir" layout: `<root>/<modePrefix>{mode}/<file>.<ext>`. Used by
   *  Roo's `.roo/rules-{mode}/*.md`. The first `*` in the directory name is
   *  treated as the mode tag. */
  | "mode-dir"

/** Which content format the file holds. `mdc` is a Markdown body with a
 *  fenced YAML frontmatter (Cursor); `md` is plain Markdown (Cline / Roo /
 *  Windsurf rule files); `yaml-or-plain` is Aider's polymorphic config (we
 *  try YAML first, fall back to plain). */
export type ParserKind = "mdc" | "md" | "yaml-or-plain"

/** A single layout-entry inside a vendor descriptor. One vendor may declare
 *  several entries (Aider has both `.aider.conf.yml` AND `CONVENTIONS.md`,
 *  Cline has both `.clinerules` flat file AND `.clinerules/*.md` dir). */
export interface PathEntry {
  readonly kind: PathKind
  /** Relative path from cwd. For `dir` and `mode-dir`, the directory itself.
   *  For `file`, the file path. */
  readonly path: string
  /** Accepted extensions (without the leading `.`). Empty for `file` entries
   *  (the extension is in `path`). */
  readonly extensions: readonly string[]
  readonly parser: ParserKind
}

/** A vendor descriptor — one entry in the table. */
export interface VendorDescriptor {
  readonly vendor: VendorId
  /** Free-form display name for diagnostics + the rendered prompt-block
   *  citation. */
  readonly displayName: string
  /** What scope rules from this vendor have. `repo+mode` means the entries
   *  carry a mode axis encoded in the directory name. */
  readonly scope: RuleScope
  readonly paths: readonly PathEntry[]
}

/**
 * THE table. Iteration order = priority order. Lower-index vendors win on
 * collision (same source path claimed by two vendors).
 *
 * Why this order?
 *   - `quanta` first: our NATIVE config beats any foreign vendor's claim.
 *   - `cursor`, `cline`, `roo`, `aider`, `windsurf` after: alphabetical
 *     within the foreign-vendor band. No vendor is privileged over another
 *     among the foreign band; collisions there are unusual (different paths)
 *     and the source-path tiebreak in `normalizer.ts` handles them.
 */
export const VENDOR_TABLE: readonly VendorDescriptor[] = Object.freeze([
  {
    vendor: "quanta",
    displayName: "quanta",
    scope: "repo",
    paths: [{ kind: "dir", path: ".quanta/rules", extensions: ["md", "mdc"], parser: "mdc" }],
  },
  {
    vendor: "cursor",
    displayName: "Cursor",
    scope: "repo",
    paths: [{ kind: "dir", path: ".cursor/rules", extensions: ["mdc"], parser: "mdc" }],
  },
  {
    vendor: "cline",
    displayName: "Cline",
    scope: "repo",
    paths: [
      // `.clinerules` can be EITHER a flat file OR a directory of `*.md` rules.
      // The detector stats both; only one will exist on a given repo.
      { kind: "file", path: ".clinerules", extensions: [], parser: "md" },
      { kind: "dir", path: ".clinerules", extensions: ["md"], parser: "md" },
    ],
  },
  {
    vendor: "roo",
    displayName: "Roo",
    scope: "repo+mode",
    paths: [
      // Roo's per-mode rules: `.roo/rules-{mode}/*.md`. We walk `.roo/`,
      // taking each `rules-*` subdirectory as a mode-scoped rule set.
      { kind: "mode-dir", path: ".roo/rules-", extensions: ["md"], parser: "md" },
    ],
  },
  {
    vendor: "aider",
    displayName: "Aider",
    scope: "repo",
    paths: [
      { kind: "file", path: ".aider.conf.yml", extensions: [], parser: "yaml-or-plain" },
      { kind: "file", path: "CONVENTIONS.md", extensions: [], parser: "md" },
    ],
  },
  {
    vendor: "windsurf",
    displayName: "Windsurf",
    scope: "repo",
    paths: [{ kind: "file", path: ".windsurfrules", extensions: [], parser: "md" }],
  },
] satisfies readonly VendorDescriptor[])

/** Map from `VendorId` → priority index. Lower number = higher precedence.
 *  Computed once from `VENDOR_TABLE` so the table is the SSOT. */
export const VENDOR_PRIORITY: Readonly<Record<VendorId, number>> = Object.freeze(
  VENDOR_TABLE.reduce<Record<VendorId, number>>(
    (acc, entry, idx) => {
      acc[entry.vendor] = idx
      return acc
    },
    {} as Record<VendorId, number>,
  ),
)
