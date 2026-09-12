/**
 * The build stamp's dirty bit, as two pure decisions.
 *
 * Extracted from `tools/bin/build-cli.ts` because that file BUILDS on import —
 * importing it from a test would spawn a compile — so nothing there was testable
 * and the ordering defect below shipped unnoticed.
 *
 * ## What went wrong
 *
 * `build-cli.ts` claimed the stamp was captured "BEFORE anything else can touch the
 * tree", and that capturing after `install-quanta-cli.sh`'s `package.json` bump
 * "would make every single build read `dirty`, which is worse than no stamp because
 * it is a stamp that always lies in the same direction". The script bumps
 * `package.json` and THEN builds, so that is precisely what happened: every
 * `bun run install:cli` binary was stamped `-dirty`.
 *
 * The bump cannot move after the build — the binary bundles `pkg.version` — so the
 * caller is the only party that knows the tree was clean a moment earlier. Hence
 * the preset.
 */

/**
 * Interpret an already-set `QUANTA_BUILD_DIRTY`.
 *
 * Only the two exact tokens the stamp itself uses are honoured. Anything else is
 * `undefined` (⇒ measure instead), NOT coerced: `QUANTA_BUILD_DIRTY=yes` pinning
 * the bit to clean would be a stamp that lies in one direction, which is the defect
 * this file documents. This is deliberately NARROWER than the canonical `gateOn`
 * vocabulary — the value is a bit written by a build tool, not an operator opt-in.
 */
export const parsePresetDirty = (raw: string | undefined): "0" | "1" | undefined =>
  raw === "0" || raw === "1" ? raw : undefined

/**
 * `1` when tracked files are modified relative to HEAD, else `0`.
 *
 * `porcelain` MUST come from `git status --porcelain --untracked-files=no`, and
 * `null` means THE PROBE FAILED — not that the tree is clean.
 *
 * That distinction is the whole point of the parameter type. The first version took
 * a plain `string`, and `build-cli.ts`'s `git()` helper collapses a non-zero exit to
 * `""`, so a failed `git status` was indistinguishable from a clean tree. Proven by
 * execution with a shim whose `status` fails (an `index.lock` collision — a hazard
 * this repo hits with concurrent sessions) against a genuinely modified tree: the
 * build stamped `dirty=0`, a confident CLEAN claim on a dirty tree. That is exactly
 * the one-directional lie `parsePresetDirty` refuses `yes` to prevent, reintroduced
 * one function away by the purity refactor.
 *
 * A failed probe answers `1`: "I could not confirm the tree is clean." The stamp
 * then claims less than it knows rather than more.
 *
 * With untracked files counted, a git worktree's `node_modules` SYMLINK reads as
 * drift — `.gitignore`'s `node_modules/` has a trailing slash and matches
 * directories only — so a clean tracked tree stamped `-dirty`.
 *
 * LIMIT, stated rather than papered over: a NEW untracked source file is not
 * detected. The bit answers "are tracked files modified relative to this commit",
 * which is the question the commit label asks.
 */
export const dirtyFromPorcelain = (porcelain: string | null): "0" | "1" => {
  if (porcelain === null) return "1"
  return porcelain.trim() === "" ? "0" : "1"
}

/** The composed decision: an honoured preset, else the measurement. */
export const resolveDirtyBit = (
  preset: string | undefined,
  porcelain: () => string | null,
): "0" | "1" => parsePresetDirty(preset) ?? dirtyFromPorcelain(porcelain())
