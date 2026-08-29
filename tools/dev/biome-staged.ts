/**
 * The staged paths that this repo ACTUALLY lints, NUL-separated on stdout.
 *
 * WHY THIS EXISTS. `.githooks/pre-commit` invoked `biome check` directly on the
 * staged paths. That is a SECOND AUTHORITY on which files are linted, and it
 * immediately disagreed with the first: `tools/dev/unit-speed-budget.ts` is not
 * in `collectBiomeTargets`, so `bun run lint` never judges its `console.*`
 * calls — while raw biome reports 8 of them as ERRORS and the hook refused the
 * commit. A hook that blocks work the project's own lint gate would pass is the
 * shape that teaches `--no-verify`, which is worse than no hook.
 *
 * `tools/dev/run-biome.ts` carries the same scar in its comment ("MUST stay
 * `bun run lint` … invoking biome directly here let CI and local drift apart").
 * So the hook now asks the SSOT — `collectBiomeTargets` — which of the staged
 * paths are in scope, and checks exactly those.
 *
 * Reads the staged list on stdin (NUL-separated, as `git diff --cached -z`
 * writes it) and prints the intersection the same way. Empty output means
 * nothing staged is lintable, which is a normal, silent no-op.
 */

import { collectBiomeTargets } from "./biome-targets"

/**
 * The tree to resolve scope against is the one git is committing — `process.cwd()`,
 * because git runs hooks from the repository root. Anchoring on this file's own
 * location instead would be wrong the moment the helper is copied (a test
 * sandbox, a worktree) and would silently scope every staged path to the
 * ORIGINAL repo — returning nothing, so the hook would pass over everything.
 */
const repoRoot = process.cwd()
const inScope = new Set(collectBiomeTargets(repoRoot))

const stdin = await Bun.stdin.text()
const staged = stdin.split("\0").filter((p) => p !== "")
const keep = staged.filter((p) => inScope.has(p))
if (keep.length > 0) process.stdout.write(`${keep.join("\0")}\0`)
