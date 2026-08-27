import { existsSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const SOURCE_ROOTS = ["src", "tests"] as const
const JS_LIKE_RE = /\.(?:[cm]?js|jsx)$/i

/**
 * Every extension the SHIPPED biome binary will lint in this repo.
 *
 * This list is not a guess and not "the ones we happen to have". It was probed
 * against `node_modules/.bin/biome check <file>` — the binary reports `Checked 1
 * file` for a type it handles and `Checked 0 files` for one it does not — and it
 * is held to that by `tests/unit/lint-debt-ratchet-reach.test.ts`, which hands
 * biome every file this enumerator REJECTS and requires biome to reject it too.
 *
 * WHY IT IS SPELLED OUT RATHER THAN INFERRED. `bun run lint` and `bun run
 * lint:debt` do not point biome at a directory; they hand it this explicit list.
 * An extension missing here is not linted and not counted, and neither surface
 * says so — it reports a clean number over a smaller universe. That happened:
 * `.html` was absent, so `src/apps/bench/trace-viewer.html` carried two lint
 * ERRORS and the joint-highest cognitive-complexity score in `src/` while
 * `lint` was green and the debt ceiling read `prod=36/36`.
 *
 * Extensions biome does NOT handle (`.md`, `.yaml`, `.toml`, `.scss`, …) are
 * deliberately absent: listing them would hand biome paths it silently skips,
 * which buys nothing and hides the distinction this list exists to make.
 */
const BIOME_EXTENSIONS = [
  // JavaScript / TypeScript family
  "js",
  "cjs",
  "mjs",
  "jsx",
  "ts",
  "cts",
  "mts",
  "tsx",
  // data
  "json",
  "jsonc",
  // biome also parses these, and lints the scripts embedded in them
  "css",
  "graphql",
  "gql",
  "html",
  "vue",
  "svelte",
  "astro",
  "grit",
] as const

const BIOME_EXT_RE = new RegExp(`\\.(?:${BIOME_EXTENSIONS.join("|")})$`, "i")

const normalizeRel = (rel: string): string => rel.replaceAll("\\", "/")

const stripKnownExtension = (rel: string): string => rel.replace(BIOME_EXT_RE, "")

const hasTypeScriptTwin = (absPath: string): boolean => {
  const stem = absPath.replace(/\.(?:[cm]?js|jsx)$/i, "")
  return (
    existsSync(`${stem}.ts`) ||
    existsSync(`${stem}.tsx`) ||
    existsSync(`${stem}.mts`) ||
    existsSync(`${stem}.cts`)
  )
}

export const isMirrorJsArtifact = (repoRoot: string, relPath: string): boolean => {
  const rel = normalizeRel(relPath)
  if (!JS_LIKE_RE.test(rel)) return false
  if (!rel.startsWith("src/") && !rel.startsWith("tests/")) return false
  return hasTypeScriptTwin(join(resolve(repoRoot), rel))
}

export const shouldIncludeBiomeTarget = (repoRoot: string, relPath: string): boolean => {
  const rel = normalizeRel(relPath)
  if (!BIOME_EXT_RE.test(rel)) return false
  if (rel.endsWith(".d.ts")) return false
  if (rel.startsWith("tests/smoke/fixtures/")) return false
  const leaf = rel.split("/").at(-1) ?? rel
  if (leaf.includes(".from-worktree")) return false
  if (leaf.includes(".my-backup")) return false
  if (isMirrorJsArtifact(repoRoot, rel)) return false
  return true
}

const walk = (repoRoot: string, relDir: string, out: string[]): void => {
  const absDir = join(repoRoot, relDir)
  let entries: string[]
  try {
    entries = readdirSync(absDir)
  } catch {
    return
  }
  for (const name of entries) {
    const abs = join(absDir, name)
    let entryStat: ReturnType<typeof statSync>
    try {
      entryStat = statSync(abs)
    } catch {
      continue
    }
    const rel = normalizeRel(relative(repoRoot, abs))
    if (entryStat.isDirectory()) {
      // Dot-directories are never shipped code, and at least one
      // (`tools/dev/.scratch`) holds a gitignored COPY of the whole repo —
      // 7,550 of the 7,802 files under `tools/` live there. Enumerating them
      // would count scratch duplicates as lint targets, so the debt ceilings
      // would depend on what an earlier session happened to leave on disk
      // rather than on what is committed. `tools/dev/verify-scope.ts` skips
      // them for the same reason.
      if (name.startsWith(".")) continue
      walk(repoRoot, rel, out)
      continue
    }
    if (entryStat.isFile() && shouldIncludeBiomeTarget(repoRoot, rel)) out.push(rel)
  }
}

export const collectBiomeTargets = (
  repoRoot: string,
  roots: ReadonlyArray<string> = SOURCE_ROOTS,
): string[] => {
  const absRepoRoot = resolve(repoRoot)
  const out: string[] = []
  for (const root of roots) {
    walk(absRepoRoot, root, out)
  }
  out.sort((a, b) => {
    const aStem = stripKnownExtension(a)
    const bStem = stripKnownExtension(b)
    return aStem === bStem ? a.localeCompare(b) : aStem.localeCompare(bStem)
  })
  return out
}
