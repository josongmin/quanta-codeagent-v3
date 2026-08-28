/**
 * COMPILED-BINARY ASSET RATCHET — closed-universe gate on the one defect class
 * that every unit test in this repo is structurally blind to.
 *
 * WHY THIS EXISTS. The shipping CLI is a single-file binary
 * (`bun build --compile --minify src/apps/cli/index.ts --outfile dist/agent`).
 * There is no `node_modules` beside it. Any code that resolves a runtime path
 * from its OWN install location — `createRequire`, `require.resolve`,
 * `import.meta.url`/`dir`, `__dirname` — resolves something real from source and
 * something absent (or nothing) when compiled.
 *
 * Two slices already shipped broken this way:
 *
 *   - `src/permission/shell/parser.ts`, the shell security authority. In
 *     `dist/agent` it failed with `ENOENT '/$bunfs/root/web-tree-sitter.wasm'`,
 *     answered `unknown` for EVERY command, and the SHIPPING binary silently ran
 *     on the regex-only gate that lane was built to replace.
 *   - `src/retrieval/code-parser/tree-sitter.ts`, same root cause: a parse that
 *     returns `{ok:true}` from source returned `{ok:false, reason:"parse-error"}`
 *     in a compiled binary run outside the repo.
 *
 * Every one of ~37,000 unit tests passed throughout, because they run FROM
 * SOURCE. No amount of ordinary testing can see this; only compiling and running
 * the artifact can.
 *
 * THE CWD TRAP. `createRequire` inside a compiled binary FALLS BACK to the cwd's
 * `node_modules`. A probe launched from inside this repo therefore PASSES even
 * when the binary is broken. Every compiled probe below runs from a cwd OUTSIDE
 * the repo for exactly that reason — the earlier fix was validated that way and
 * this test refuses to be validated any other way.
 *
 * SHAPE (house style, mirroring `tools/dev/lint-debt-ceiling.ts`): CLOSED
 * UNIVERSE. `tools/dev/compiled-binary-assets.json` pins every known site with a
 * status and a justification. A site that fires but is ABSENT from the file is
 * treated as ceiling 0 and FAILS. Counts are per-file/per-pattern and only ever
 * go DOWN — growth is a REGRESSION, never a ceiling bump. That is the whole
 * point: the next slice that resolves an asset from `node_modules` cannot land
 * silently the way these two did.
 *
 * NON-VACUOUS. A scanner alone would only prove that a regex still matches. So:
 *   - every `not-shipped` claim is checked against the REAL module graph of the
 *     shipped entry, not asserted in a comment;
 *   - every `embedded` claim is checked by compiling a real binary and running
 *     it from outside the repo;
 *   - the set of `embedded` entries must EXACTLY equal the set the compiled
 *     proof covers, so a new `embedded` entry cannot get a free pass;
 *   - the status union is exhaustively classified via `Record<Status, …>` plus a
 *     runtime drift guard, because `satisfies` alone cannot catch a value that
 *     only ever appears in JSON.
 */

import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "")

/** How many bundled system skills exist on disk. Compared against what the
 *  COMPILED binary discovers, so the proof tracks the tree instead of a literal
 *  that would quietly go stale the next time a skill is added. */
const systemSkillDirCount = (): number =>
  readdirSync(join(REPO_ROOT, "src/skill/system-skills"), { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  ).length
const SRC_ROOT = join(REPO_ROOT, "src")
const ALLOWLIST_PATH = join(REPO_ROOT, "tools/dev/compiled-binary-assets.json")

// ---------------------------------------------------------------------------
// The scanned universe
// ---------------------------------------------------------------------------

/**
 * SELF-ROOTING patterns: the only ways a module can learn its own on-disk
 * location or resolve a sibling package. This is the complete mechanism list —
 * there is no fourth way to do it — which is what makes the universe closed.
 *
 * A bare `node_modules` string literal is deliberately NOT a pattern. All 76 of
 * its occurrences in `src/**` are skip-lists, ignore regexes, or shell commands
 * aimed at a TARGET repo (`join(opts.repoRoot, "node_modules")` — a caller's
 * path, not ours). Listing them would bury the ten real sites in noise. A
 * `node_modules` path that IS rooted at our own install is still caught, because
 * the root it is joined to can only have come from one of the anchors below.
 */
const PATTERNS = {
  createRequire: /\bcreateRequire\b/,
  "require.resolve": /\brequire\s*\.\s*resolve\s*\(/,
  "import.meta": /\bimport\s*\.\s*meta\s*\.\s*(?:url|dir|path|resolve)\b/,
  __dirname: /\b__dirname\b/,
  __filename: /\b__filename\b/,
  // A non-code import specifier: `.wasm`/`.node` bytes pulled from a package.
  // With `with { type: "file" }` bun embeds them; without it they are a live
  // instance of this defect. Either way the site must be classified.
  "asset-import": /\bfrom\s+["'][^"']+\.(?:wasm|node)["']/,
} as const

type PatternName = keyof typeof PATTERNS

/** Tests never reach the compiled binary — they are not in any bundle. */
const isTestFile = (path: string): boolean =>
  /\.test\.ts$|\.spec\.ts$|(?:^|\/)__tests__\//.test(path)

const CODE_EXT = /\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (CODE_EXT.test(p)) out.push(p)
  }
  return out
}

/**
 * Blank out whole-line comments so a doc block that MENTIONS `createRequire`
 * (both fixed files narrate the defect at length) is not counted as a call.
 *
 * Deliberately conservative: only lines whose trimmed form OPENS a comment are
 * dropped. A trailing `// …` on a code line is left in, so it can only ADD a
 * site that must be classified — the fail-closed direction. Under-stripping
 * costs a JSON entry; over-stripping would hide a real site.
 */
const stripWholeLineComments = (source: string): string[] => {
  let inBlock = false
  return source.split("\n").map((raw) => {
    const t = raw.trim()
    if (inBlock) {
      if (t.includes("*/")) inBlock = false
      return ""
    }
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlock = true
      return ""
    }
    if (t.startsWith("//") || t.startsWith("*")) return ""
    return raw
  })
}

interface Hit {
  readonly file: string
  readonly line: number
  readonly pattern: PatternName
  readonly text: string
}

const scanSrc = (): { readonly hits: readonly Hit[]; readonly filesScanned: number } => {
  const files = walk(SRC_ROOT).filter((f) => !isTestFile(f))
  const hits: Hit[] = []
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs)
    stripWholeLineComments(readFileSync(abs, "utf8")).forEach((line, i) => {
      for (const [name, re] of Object.entries(PATTERNS) as [PatternName, RegExp][]) {
        if (re.test(line)) hits.push({ file: rel, line: i + 1, pattern: name, text: line.trim() })
      }
    })
  }
  return { hits, filesScanned: files.length }
}

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

const STATUSES = ["embedded", "dev-only", "not-shipped", "not-self-rooted"] as const
type Status = (typeof STATUSES)[number]

/** Exhaustive classification of every status — a closed `Record<Union, …>`, so
 *  adding a status without deciding what it OBLIGES is a type error, and the
 *  runtime guard below catches a status that only ever appears in the JSON. */
const OBLIGATION: Record<
  Status,
  { readonly needsCompiledProof: boolean; readonly mustBeReachable: boolean | null }
> = {
  embedded: { needsCompiledProof: true, mustBeReachable: true },
  "dev-only": { needsCompiledProof: false, mustBeReachable: true },
  "not-shipped": { needsCompiledProof: false, mustBeReachable: false },
  "not-self-rooted": { needsCompiledProof: false, mustBeReachable: null },
}

interface SiteEntry {
  readonly file: string
  readonly status: Status
  readonly justification: string
  readonly override: string | null
  readonly compiledBehavior?: string
  readonly patterns: Readonly<Record<string, number>>
}

interface Allowlist {
  readonly note: string
  readonly shippedEntry: string
  readonly sites: readonly SiteEntry[]
}

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as Allowlist

/** An entry key may carry a `#discriminator` so ONE file can hold two honestly
 *  different statuses (`tree-sitter.ts` is both `embedded` and `dev-only`). */
const entryFile = (entry: SiteEntry): string => entry.file.split("#")[0] ?? entry.file

/** Pinned counts SUMMED per file, since several entries may share a file. */
const pinnedByFile = (): Map<string, Map<string, number>> => {
  const out = new Map<string, Map<string, number>>()
  for (const entry of allowlist.sites) {
    const f = entryFile(entry)
    const m = out.get(f) ?? new Map<string, number>()
    for (const [pat, n] of Object.entries(entry.patterns)) m.set(pat, (m.get(pat) ?? 0) + n)
    out.set(f, m)
  }
  return out
}

// ---------------------------------------------------------------------------

/**
 * Read ONLY the `sources` array out of a bun sourcemap.
 *
 * NOT `JSON.parse` of the whole file, for a measured reason: bun copies each
 * source's text into `sourcesContent` WITHOUT re-escaping it, so a source file
 * whose own comment contains a literal backslash-x (this repo has one — a
 * sticky-model boot-vetting docstring quoting an ANSI-injection payload
 * `\x07`) lands in the map as the JSON escape `\x`, which is not a legal
 * escape. `JSON.parse` then throws "Invalid escape character x" and the ratchet
 * dies on a defect in a COMMENT, nowhere near what it guards.
 *
 * `sources` is a flat array of paths, so a bracket scan that respects string
 * literals reads it exactly, skips the ~45MB of `sourcesContent` entirely, and
 * cannot be broken by anything a source file happens to contain.
 */
const readMapSources = (mapPath: string): readonly string[] => {
  const raw = readFileSync(mapPath, "utf8")
  const key = '"sources"'
  const at = raw.indexOf(key)
  if (at === -1) throw new Error(`sourcemap has no "sources" key: ${mapPath}`)
  const open = raw.indexOf("[", at)
  if (open === -1) throw new Error(`sourcemap "sources" is not an array: ${mapPath}`)
  let inString = false
  let escaped = false
  for (let i = open + 1; i < raw.length; i += 1) {
    const c = raw[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === "\\") {
      escaped = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (!inString && c === "]") {
      return JSON.parse(raw.slice(open, i + 1)) as readonly string[]
    }
  }
  throw new Error(`sourcemap "sources" array is unterminated: ${mapPath}`)
}

describe("compiled-binary asset ratchet", () => {
  test("the scan is not vacuous", () => {
    const { hits, filesScanned } = scanSrc()
    // A refactor that moved src/, a broken walk, or a regex that stopped
    // compiling would otherwise show up as a serene green "0 unlisted sites".
    expect(filesScanned).toBeGreaterThan(1000)
    expect(hits.length).toBeGreaterThan(0)
    expect(allowlist.sites.length).toBeGreaterThan(0)
  })

  test("every allowlist status is a known one (runtime drift guard)", () => {
    // `satisfies` cannot see a value that only exists in JSON, and an unknown
    // status would otherwise fall through every check below unexamined.
    const unknown = allowlist.sites
      .filter((s) => !STATUSES.includes(s.status))
      .map((s) => `${s.file} → "${s.status}"`)
    expect(unknown).toEqual([])
    expect(Object.keys(OBLIGATION).sort()).toEqual([...STATUSES].sort())
    for (const s of allowlist.sites) {
      expect(s.justification.length).toBeGreaterThan(40)
      // `dev-only` is a claim about compiled behaviour; it must record the
      // MEASUREMENT, not an assumption.
      if (s.status === "dev-only") expect(typeof s.compiledBehavior).toBe("string")
    }
  })

  test("no UNLISTED site — a new one is ceiling 0 and fails", () => {
    const { hits } = scanSrc()
    const pinned = pinnedByFile()
    const unlisted = hits
      .filter((h) => !pinned.has(h.file))
      .map((h) => `  ${h.file}:${h.line} [${h.pattern}]  ${h.text.slice(0, 100)}`)

    if (unlisted.length > 0) {
      throw new Error(
        "UNLISTED compiled-binary asset site(s). This code resolves a runtime path from its own\n" +
          "install location, which does NOT exist inside `bun build --compile`. Every unit test\n" +
          "will still pass, because they run from source — that is exactly how the shell security\n" +
          "authority shipped dead.\n\n" +
          `${unlisted.join("\n")}\n\n` +
          'Either embed the asset (`import x from "pkg/y.wasm" with { type: "file" }` + pass the\n' +
          "path through to the loader), or add the site to tools/dev/compiled-binary-assets.json\n" +
          "with an honest status and justification. Do NOT raise a ceiling to get green.",
      )
    }
    expect(unlisted).toEqual([])
  })

  test("per-file/per-pattern counts match the allowlist EXACTLY", () => {
    // STRICTER than lint-debt's one-directional ceiling, and deliberately so.
    // That file pins ~1200 diagnostics where an exact match would churn on every
    // commit; this universe is TEN sites, so an exact match costs nothing and
    // buys two things a ceiling cannot: a listed file cannot quietly grow a
    // SECOND, differently-broken mechanism under an existing count, and a site
    // that disappears forces a deliberate JSON update instead of leaving a
    // stale pin that silently re-absorbs the next regression.
    //
    // Growth is still the failure this exists to catch. Do NOT edit the counts
    // to get green — fix the site, or classify it honestly.
    const tally = (m: Map<string, Map<string, number>>): string[] =>
      [...m].flatMap(([f, pats]) => [...pats].map(([p, n]) => `${f} [${p}] ${n}`)).sort()

    const actual = new Map<string, Map<string, number>>()
    for (const h of scanSrc().hits) {
      const m = actual.get(h.file) ?? new Map<string, number>()
      m.set(h.pattern, (m.get(h.pattern) ?? 0) + 1)
      actual.set(h.file, m)
    }
    expect(tally(actual)).toEqual(tally(pinnedByFile()))
  })

  test("no STALE entry — every listed file still exists and still fires", () => {
    const { hits } = scanSrc()
    const firing = new Set(hits.map((h) => h.file))
    const stale = allowlist.sites
      .map(entryFile)
      .filter((f) => !existsSync(join(REPO_ROOT, f)) || !firing.has(f))
      .map((f) => `  ${f}`)
    expect(stale).toEqual([])
  })

  test(
    "`not-shipped` is VERIFIED against the real module graph of the shipped entry",
    () => {
      // The honest way to say "this file never reaches the binary" is to build
      // the graph and look, not to reason about it from a directory name.
      const out = mkdtempSync(join(tmpdir(), "compiled-asset-graph-"))
      try {
        const build = Bun.spawnSync({
          cmd: [
            "bun",
            "build",
            "--target=bun",
            join(REPO_ROOT, allowlist.shippedEntry),
            "--outdir",
            out,
            "--sourcemap=external",
          ],
          cwd: REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(build.exitCode).toBe(0)

        const mapPath = join(out, "index.js.map")
        const map = { sources: readMapSources(mapPath) }
        // Sources are relative to the OUTDIR. macOS hands back `/var/…` for a
        // tmpdir whose real path is `/private/var/…`, and bun may base the walk
        // on either — so resolve against both and union. The size guard below
        // is what catches this going wrong rather than a silently empty set.
        const bases = [out, realpathSync(out)]
        const reachable = new Set(
          map.sources.flatMap((s) => bases.map((b) => relative(REPO_ROOT, resolve(b, s)))),
        )
        // Guard the guard: an empty/renamed sources array would make every
        // `not-shipped` claim trivially true.
        expect(reachable.size).toBeGreaterThan(1000)
        expect(reachable.has(allowlist.shippedEntry)).toBe(true)

        const wrong: string[] = []
        for (const entry of allowlist.sites) {
          const must = OBLIGATION[entry.status].mustBeReachable
          if (must === null) continue
          const is = reachable.has(entryFile(entry))
          if (is !== must) {
            wrong.push(
              `  ${entry.file} is "${entry.status}" (expects reachable=${must}) but the shipped ` +
                `graph says reachable=${is}`,
            )
          }
        }
        if (wrong.length > 0) {
          throw new Error(
            `Status/reachability drift against ${allowlist.shippedEntry}. A file that became ` +
              `reachable is now subject to the compiled-binary defect class and must be ` +
              `reclassified:\n${wrong.join("\n")}`,
          )
        }
        expect(wrong).toEqual([])
      } finally {
        rmSync(out, { recursive: true, force: true })
      }
    },
    { timeout: 180_000 },
  )

  test(
    "every `embedded` site actually works in a COMPILED binary run OUTSIDE the repo",
    () => {
      // Files this probe genuinely exercises. Asserted against the allowlist
      // below, so a future `embedded` entry with no proof turns this red rather
      // than inheriting someone else's green.
      const PROVEN = [
        "src/permission/shell/parser.ts",
        "src/retrieval/code-parser/tree-sitter.ts",
        "src/skill/system-skills/index.ts",
      ].sort()
      const claimed = allowlist.sites
        .filter((s) => OBLIGATION[s.status].needsCompiledProof)
        .map(entryFile)
        .sort()
      expect(claimed).toEqual(PROVEN)

      // The entry must live INSIDE the repo: bun resolves bare specifiers
      // (`@/…`, `web-tree-sitter`) against the nearest `node_modules`, so a
      // scratch-dir entry cannot be compiled at all.
      const entry = join(REPO_ROOT, `__compiled-asset-ratchet-probe-${process.pid}.ts`)
      const out = mkdtempSync(join(tmpdir(), "compiled-asset-probe-"))
      const bin = join(out, "probe")
      const grammarDir = join(REPO_ROOT, "node_modules/@vscode/tree-sitter-wasm/wasm")
      try {
        writeFileSync(
          entry,
          [
            `import { assessShellCommand, initShellEffectParser, shellEffectParserReady } from "@/permission/shell"`,
            `import { createTreeSitterParser } from "@/retrieval/code-parser"`,
            `import { discoverSystemSkills } from "@/skill/system-skills"`,
            `await initShellEffectParser()`,
            `const parsed = await createTreeSitterParser().parse("x.ts", "export const a = 1\\n")`,
            `console.log(JSON.stringify({`,
            `  shellReady: shellEffectParserReady(),`,
            `  shellVerdict: assessShellCommand("cd / && rm -rf *").kind,`,
            `  retrievalOk: parsed.ok,`,
            `  skillCount: (await discoverSystemSkills()).length,`,
            `}))`,
          ].join("\n"),
          "utf8",
        )

        const build = Bun.spawnSync({
          cmd: ["bun", "build", "--compile", entry, "--outfile", bin],
          cwd: REPO_ROOT,
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(build.exitCode).toBe(0)

        const run = Bun.spawnSync({
          cmd: [bin],
          // OUTSIDE the repo, and this is load-bearing: `createRequire` in a
          // compiled binary falls back to the CWD's `node_modules`, so a probe
          // launched from the repo passes even when the binary is broken.
          cwd: out,
          env: { ...process.env, QUANTA_TREE_SITTER_DIR: grammarDir },
        })
        const stdout = new TextDecoder().decode(run.stdout).trim()
        const stderr = new TextDecoder().decode(run.stderr).trim()
        const last = stdout.split("\n").at(-1) ?? "{}"
        let parsed: unknown
        try {
          parsed = JSON.parse(last)
        } catch {
          throw new Error(
            `compiled probe produced no JSON (exit ${run.exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          )
        }
        expect(parsed).toEqual({
          // `shellReady:false` is the exact shape of the original defect: the
          // grammar failed to arm and the authority answered `unknown` for
          // every command.
          shellReady: true,
          shellVerdict: "hard-deny",
          // Proves `Parser.init()` no longer aborts, which is what makes the
          // pre-existing QUANTA_TREE_SITTER_DIR override usable at all here.
          retrievalOk: true,
          // The shipped CLI carried ZERO bundled skills before the SKILL.md
          // files were embedded; the count is compared to the tree, not to a
          // literal, so adding a skill cannot make this assertion stale.
          skillCount: systemSkillDirCount(),
        })
      } finally {
        rmSync(entry, { force: true })
        rmSync(out, { recursive: true, force: true })
      }
    },
    { timeout: 180_000 },
  )
})
