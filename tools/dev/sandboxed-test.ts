/**
 * Run the test suite from a THROWAWAY working directory.
 *
 * WHY THIS EXISTS. A full `bun test tests/unit` intermittently leaves fixture
 * files at the REPO ROOT — `src/x.ts` ("no edit"), `rel.txt` ("based"),
 * `round.txt` ("jailed-ok"). Five methods failed to identify the writer (see
 * `docs/analysis/aug-24-repo-root-fixture-leak-investigation.md`): the fs seams
 * are invisible to a preload hook because the write goes through ESM named
 * imports, `Bun.plugin` refuses to override builtin modules, EISDIR decoys stay
 * untouched, stdout carries no per-file marker to correlate against, and the
 * leak is intermittent (3 of 6 observable runs) so bisection cannot converge.
 *
 * The damage, though, is out of all proportion to the cause, and it is
 * containable without knowing the culprit:
 *
 *   - `src/x.ts` is not valid TypeScript, so it reddens `typecheck:all`, `lint`
 *     AND the closed-universe `lint:debt` — in a file no commit contains.
 *   - `tests/unit/storage.test.ts` asserts a relative name does NOT resolve
 *     under `process.cwd()`. One leaking run reddens the NEXT run,
 *     deterministically. The suite poisons itself.
 *
 * A bare relative path resolves against the process's working directory. Move
 * that directory somewhere disposable and both problems end: a stray write
 * lands in the sandbox instead of the repo, and — because nothing else on the
 * machine knows the sandbox path — anything that appears there is attributable
 * to THIS run by construction. That is the property the worktree-pollution
 * guard cannot have (its own docs concede that on a shared checkout another
 * process's file gets attributed to the run).
 *
 * ## Why this needs its own runner
 *
 * `bunfig.toml`'s `[test] preload` is resolved relative to the CWD, so a suite
 * launched from elsewhere silently loses `tests/preload-clean-source-js.ts` and
 * `tests/setup.ts`. Passing them explicitly is the whole trick, and it has to
 * live somewhere that cannot drift from the bunfig list — hence
 * {@link PRELOADS} below, checked against bunfig at startup.
 *
 * ## What it reports
 *
 *   - Anything created in the SANDBOX: a finding, with size and a content
 *     preview. Attributable with no caveat. This is how the leak's source gets
 *     named the next time it fires.
 *   - Anything created in the REPO: a failure. The containment did not hold,
 *     which means a test used an absolute repo path rather than a relative one.
 *
 * ## Making the NEXT firing self-diagnosing
 *
 * Containment alone still leaves "somewhere in 2,937 files". `--batch N` runs
 * the same files as N sequential sandboxes and reports which BATCH produced a
 * stray. Same total work, no extra runtime — but a stray narrows from the whole
 * suite to one slice of it on a single run, and the slice is printed as a
 * ready-to-paste re-run command. That is the bisect step the intermittency
 * (3 firings in 6 runs) otherwise makes uneconomic: a clean candidate set is not
 * evidence of absence, so halving the set by hand costs a run per level per
 * repetition, while batching pays for the whole first level at once.
 *
 * Usage:
 *   bun run tools/dev/sandboxed-test.ts [test paths...]              # default: tests/unit
 *   bun run tools/dev/sandboxed-test.ts --batch 8 [test paths...]    # 8 sandboxes, localize a stray
 */

import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

const writeStdout = (message: string): void => {
  process.stdout.write(`${message}\n`)
}

const writeStderr = (message: string): void => {
  process.stderr.write(`${message}\n`)
}

/** The preloads `bunfig.toml` applies when the suite runs from the repo root.
 *  Duplicated here because a foreign CWD cannot resolve them; kept honest by
 *  {@link assertPreloadsMatchBunfig}. */
const PRELOADS = ["tests/preload-clean-source-js.ts", "tests/setup.ts"] as const

/**
 * Refuse to run if this list has drifted from `bunfig.toml`.
 *
 * A silently missing preload is the worst possible failure here: the suite
 * still runs, most tests still pass, and whatever the preload was guarding
 * (stale `.test.js` artifacts, global test setup) is simply absent. So the
 * duplication is checked rather than trusted.
 */
export const assertPreloadsMatchBunfig = (bunfigText: string): void => {
  const line = /preload\s*=\s*\[([^\]]*)\]/.exec(bunfigText)
  if (line === null) {
    throw new Error(
      "sandboxed-test: bunfig.toml has no `[test] preload` — the duplication above is stale",
    )
  }
  const declared = [...(line[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) =>
    (m[1] ?? "").replace(/^\.\//, ""),
  )
  const missing = declared.filter((p) => !PRELOADS.includes(p as (typeof PRELOADS)[number]))
  const extra = PRELOADS.filter((p) => !declared.includes(p))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      "sandboxed-test: PRELOADS has drifted from bunfig.toml.\n" +
        `  in bunfig but not here: ${missing.join(", ") || "(none)"}\n` +
        `  here but not in bunfig: ${extra.join(", ") || "(none)"}\n` +
        "A preload that silently fails to load leaves the suite running WITHOUT its global setup.",
    )
  }
}

/** Untracked paths git reports, as a set — the repo-side containment check. */
export const parseUntracked = (nulSeparated: string): ReadonlySet<string> => {
  const out = new Set<string>()
  for (const entry of nulSeparated.split("\0")) {
    if (entry.length < 4) continue
    if (entry.startsWith("?? ")) out.add(entry.slice(3))
  }
  return out
}

/** Every file under `dir`, relative to it. Sandbox side: no git involved. */
export const walkRelative = (dir: string, base = dir): readonly string[] => {
  const out: string[] = []
  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSyncTyped(dir)
  } catch {
    return out
  }
  for (const ent of entries) {
    const abs = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkRelative(abs, base))
    else out.push(relative(base, abs))
  }
  return out.sort()
}

const readdirSyncTyped = (dir: string): import("node:fs").Dirent[] => {
  const { readdirSync } = require("node:fs") as typeof import("node:fs")
  return readdirSync(dir, { withFileTypes: true })
}

/** A short, safe preview so a reader can tell a fixture from real work. */
const describePath = (root: string, rel: string): string => {
  const abs = join(root, rel)
  let size: number
  try {
    const st = statSync(abs)
    if (st.isDirectory()) return `${rel}  (directory)`
    size = st.size
  } catch {
    return `${rel}  (vanished before it could be read)`
  }
  let preview = "<unreadable>"
  try {
    const fd = openSync(abs, "r")
    try {
      const buf = Buffer.alloc(Math.min(size, 512))
      const read = readSync(fd, buf, 0, buf.length, 0)
      preview = buf.subarray(0, read).toString("utf8").slice(0, 80).replace(/\s+/g, " ").trim()
    } finally {
      closeSync(fd)
    }
  } catch {
    preview = "<unreadable>"
  }
  return `${rel}  (${size} bytes)  ${preview === "" ? "<empty>" : `"${preview}"`}`
}

/**
 * Other `bun test` processes running against this checkout right now.
 *
 * The sandbox makes anything in the SANDBOX attributable with no caveat, but the
 * repo-side check has no such property: a second run with a normal cwd writes
 * into the same repo root, and this run would blame itself. That is not
 * hypothetical — the first full sandboxed run reported two paths as a
 * containment breach while a concurrent `bun test tests/unit src` was live, and
 * the file timestamps landed inside its window.
 *
 * Process sampling is best-effort by design: it can miss (a run that starts and ends
 * between the two samples) and can over-report (an unrelated `bun test` in a
 * different checkout). It exists to stop the report ASSERTING a mechanism it
 * cannot know, not to be authoritative.
 */
export const parseConcurrentBunTests = (psText: string): readonly string[] =>
  psText
    .split("\n")
    .map((l) => l.trim())
    .filter((line) => {
      const match = /^\d+\s+(.+)$/.exec(line)
      if (match === null) return false
      const command = match[1] ?? ""
      // Match the executable command, not a shell/rg argument that merely
      // contains the words "bun test". Both `bun test` and `/path/to/bun test`
      // are admitted.
      return /(?:^|\/)bun\s+test(?:\s|$)/.test(command) && !command.includes("sandboxed-test")
    })

const concurrentBunTests = (): readonly string[] => {
  // macOS `pgrep -af` can print only PIDs despite `-a`; `ps` is the portable
  // source of the full command line on both macOS and Linux.
  const proc = Bun.spawnSync(["ps", "-axo", "pid=,command="], {
    stdout: "pipe",
    stderr: "ignore",
  })
  if (proc.exitCode !== 0) return ["process sampling unavailable"]
  return parseConcurrentBunTests(proc.stdout.toString())
}

const repoUntracked = (): ReadonlySet<string> => {
  const proc = Bun.spawnSync(["git", "status", "--porcelain=v1", "-uall", "-z"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    // Fail CLOSED: without a baseline "nothing leaked" and "we never looked"
    // are indistinguishable, and the second must not read as a pass.
    throw new Error(`sandboxed-test: \`git status\` failed (exit ${proc.exitCode})`)
  }
  return parseUntracked(proc.stdout.toString())
}

/** Bun test flags that take NO separate value, so forwarding them cannot swallow
 *  a path. Anything else must arrive as `--flag=value`; see {@link parseArgs}. */
const VALUELESS_BUN_FLAGS: ReadonlySet<string> = new Set([
  "--bail",
  "--coverage",
  "--only",
  "--todo",
  "--silent",
  "--watch",
  "--update-snapshots",
  "-u",
  "--rerun-each",
])

/**
 * Split argv into the batch count and the requested paths.
 *
 * Exported because the flag/positional split had a real bug that no run would
 * surface: `--batch`'s VALUE sits at `batchIdx + 1`, and with the flag ABSENT
 * `batchIdx` is `-1`, so `batchIdx + 1` is `0` — dropping the FIRST path
 * argument. `sandboxed-test.ts tests/unit/retrieval` therefore fell back to the
 * `tests/unit` default and ran the whole suite while reporting as though it had
 * run the slice asked for. A wrong-but-plausible scope is exactly the failure
 * this tool exists to prevent elsewhere, so the parsing is pinned.
 */
export const parseArgs = (
  argv: readonly string[],
): {
  readonly batchCount: number
  readonly targets: readonly string[]
  readonly bunFlags: readonly string[]
} => {
  const batchIdx = argv.indexOf("--batch")
  const batchCount = batchIdx === -1 ? 1 : Number(argv[batchIdx + 1] ?? "1")
  if (batchIdx !== -1 && (!Number.isInteger(batchCount) || batchCount < 1)) {
    throw new Error("sandboxed-test: --batch needs a positive integer")
  }
  const valueIdx = batchIdx === -1 ? -1 : batchIdx + 1
  const rest = argv.filter((a, i) => a !== "--batch" && i !== valueIdx)

  // Anything else beginning with `-` is BUN's, not ours, and is forwarded
  // verbatim. Treating it as a path is not cosmetic: the scripts that invoke
  // `bun test` directly (`test:fast`, `test:shard`, `test:sandbox`, `test:cov`,
  // `test:contract`, `verify:smoke`) pass `--parallel=1`, and this suite behaves
  // materially differently in parallel — a parallel sweep of
  // `tests/unit src` produced ~74 failures that ALL passed in isolation, pure
  // shared-`mock.module`/env/cwd artifacts. A runner that dropped the flag would
  // turn the serial suite parallel while reporting normally.
  //
  // But a flag whose VALUE is a separate argument (`-t <pattern>`) cannot be
  // forwarded by shape alone: the value looks exactly like a path, and reading
  // it as one would run a different set — the precise failure this tool exists
  // to prevent. Rather than model bun's whole flag arity (which would drift on
  // every bun release), only the SELF-CONTAINED `--flag=value` form is accepted
  // and everything else is refused with the fix in the message.
  const flags = rest.filter((a) => a.startsWith("-"))
  const ambiguous = flags.filter((f) => !f.includes("=") && !VALUELESS_BUN_FLAGS.has(f))
  if (ambiguous.length > 0) {
    throw new Error(
      `sandboxed-test: cannot tell whether these consume the next argument: ${ambiguous.join(", ")}\n` +
        "Pass them in the self-contained form instead (`-t=pat`, `--timeout=5000`). A flag that " +
        "takes a SEPARATE value is indistinguishable from a path here, and guessing would run a " +
        "different set of tests than you asked for.",
    )
  }
  return {
    batchCount,
    targets: rest.filter((a) => !a.startsWith("-")),
    bunFlags: flags,
  }
}

/** Split `xs` into `n` contiguous batches, dropping empties. */
export const batches = <T>(xs: readonly T[], n: number): readonly (readonly T[])[] => {
  if (n <= 1 || xs.length === 0) return [xs]
  const size = Math.ceil(xs.length / n)
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

/** Every `*.test.ts` under the given roots — the unit of batching. */
export const expandTestFiles = (roots: readonly string[]): readonly string[] => {
  const { readdirSync } = require("node:fs") as typeof import("node:fs")
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      // Skip dot-directories and node_modules to MIRROR bun's own discovery.
      // Without this the expansion finds files bun will never match, hands them
      // over as filters, and bun answers a non-matching filter by running a much
      // larger set — the exact silent-broadening the caller's guard exists to
      // refuse. Matching bun here closes the hole instead of documenting it.
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) walk(abs)
      else if (abs.endsWith(".test.ts")) out.push(abs)
    }
  }
  for (const r of roots) {
    if (statSync(r).isDirectory()) walk(r)
    else if (r.endsWith(".test.ts")) out.push(r)
  }
  return out.sort()
}

if (import.meta.main) {
  assertPreloadsMatchBunfig(readFileSync(join(repoRoot, "bunfig.toml"), "utf8"))

  const { batchCount, targets, bunFlags } = parseArgs(process.argv.slice(2))
  const testPaths = (targets.length > 0 ? targets : ["tests/unit"]).map((p) =>
    p.startsWith("/") ? p : join(repoRoot, p),
  )
  for (const p of testPaths) {
    if (!existsSync(p)) throw new Error(`sandboxed-test: no such test path: ${p}`)
  }

  // Expand to real files ALWAYS, not only for --batch. `bun test <arg>` treats an
  // argument as a FILTER unless it resolves to something bun discovered, and a
  // filter that matches nothing does NOT fail — bun runs a much larger set
  // instead. A "clean sandbox" verdict over a set nobody asked for is the worst
  // outcome this tool can produce, so the expansion is checked, not trusted.
  // (Observed: `sandboxed-test.ts tools/dev` ran for ten minutes over the whole
  // suite and would have reported it clean.)
  //
  // The expansion mirrors bun's discovery (see `expandTestFiles`), so a path
  // that only holds tests under a dot-directory expands to nothing and is
  // refused here rather than silently becoming a whole-suite run.
  const files = expandTestFiles(testPaths)
  if (files.length === 0) {
    throw new Error(
      `sandboxed-test: the requested paths contain no *.test.ts:\n  ${testPaths.join("\n  ")}\n` +
        "Refusing rather than handing bun a filter that matches nothing — it would " +
        "silently run a DIFFERENT, much larger set and this tool would report it clean.",
    )
  }
  const groups = batchCount === 1 ? [files] : batches(files, batchCount)
  const preloadArgs = PRELOADS.flatMap((p) => ["--preload", join(repoRoot, p)])
  const before = repoUntracked()
  const othersAtStart = concurrentBunTests()

  let worstExit = 0
  const guilty: Array<{
    readonly batch: number
    readonly strays: readonly string[]
    readonly files: readonly string[]
  }> = []

  for (const [i, group] of groups.entries()) {
    const sandbox = mkdtempSync(join(tmpdir(), "quanta-test-cwd-"))
    if (groups.length > 1)
      writeStdout(`\n── sandbox batch ${i + 1}/${groups.length} (${group.length} file(s)) ──`)
    const run = Bun.spawnSync(["bun", "test", ...preloadArgs, ...bunFlags, ...group], {
      cwd: sandbox,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    })
    if ((run.exitCode ?? 1) !== 0) worstExit = run.exitCode ?? 1
    const strays = walkRelative(sandbox)
    if (strays.length > 0) {
      writeStderr(
        `\nSANDBOX ARTIFACTS (batch ${i + 1}/${groups.length}) — the run wrote ${strays.length} path(s) into its working directory:\n` +
          strays.map((p) => `  ${describePath(sandbox, p)}`).join("\n"),
      )
      guilty.push({ batch: i + 1, strays, files: group })
    }
    rmSync(sandbox, { recursive: true, force: true })
  }

  const after = repoUntracked()
  const others = [...new Set([...othersAtStart, ...concurrentBunTests()])]
  const leakedIntoRepo = [...after].filter((p) => !before.has(p)).sort()

  if (guilty.length > 0) {
    writeStderr(
      "\nThese are attributable to THIS run with no caveat: nothing else on the machine\n" +
        "knows those directories. Each is a test writing to a bare relative path — which,\n" +
        "run the normal way, lands in the REPO ROOT instead. Fix the test to write under a\n" +
        "temp directory it removes, or to pass an explicit base directory to the write API.",
    )
    if (groups.length > 1) {
      for (const g of guilty) {
        const narrower = Math.max(2, Math.floor(g.files.length / 8))
        writeStderr(
          `\nTo narrow batch ${g.batch} further, re-run just its files with more batches:\n` +
            `  bun run tools/dev/sandboxed-test.ts --batch ${narrower} \\\n` +
            g.files
              .slice(0, 6)
              .map((f) => `    ${relative(repoRoot, f)} \\`)
              .join("\n") +
            (g.files.length > 6
              ? `\n    … and ${g.files.length - 6} more (full list above this line in the batch header)`
              : ""),
        )
      }
    } else {
      writeStderr("\nRe-run with `--batch 8` to localize which slice of the suite produced it.")
    }
  }
  if (leakedIntoRepo.length > 0) {
    writeStderr(
      `\nPATHS REACHED THE REPO — ${leakedIntoRepo.length}, despite the sandbox:\n` +
        leakedIntoRepo.map((p) => `  ${describePath(repoRoot, p)}`).join("\n") +
        (others.length > 0
          ? "\n\nATTRIBUTION IS AMBIGUOUS: other `bun test` process(es) were running\n" +
            "against this checkout during this run —\n" +
            `${others.map((o) => `  ${o}`).join("\n")}\n` +
            "A run with a normal cwd writes into this same repo root, so these paths\n" +
            "may be theirs. Re-run when the checkout is quiet before concluding\n" +
            "anything about the mechanism."
          : "\n\nNo other `bun test` was detected against this checkout, so this run is the\n" +
            "likely writer. A sandboxed cwd only redirects RELATIVE paths, which points at\n" +
            "an absolute repo path at the source — but process sampling can miss a short-lived run,\n" +
            "so confirm on a second quiet run before acting on that reading."),
    )
  }
  if (guilty.length === 0 && leakedIntoRepo.length === 0) {
    writeStdout(
      `sandboxed-test: clean — ${groups.length} sandbox(es) empty, ${before.size} untracked repo path(s) before and after.`,
    )
  }

  process.exit(leakedIntoRepo.length > 0 ? 1 : worstExit)
}
