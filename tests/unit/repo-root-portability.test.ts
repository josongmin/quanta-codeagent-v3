/**
 * PORTABILITY REGRESSION for `tests/_helpers/repo-root.ts` (TVH-01).
 *
 * THE DEFECT THIS PINS. Three subprocess suites spawned a repository entrypoint
 * built from the literal `"/Users/songmin/quanta-codeagent-v3"`. On any other
 * checkout — a hosted Linux runner, a second clone, a `git worktree` under
 * `.claude/worktrees/`, the `.pristine-audit` extraction — that path does not
 * exist, and `Bun.spawn(["bun", <missing path>, …])` produces a NON-ZERO exit
 * with a message on stderr. Several cases in those very suites assert a
 * non-zero exit with a message on stderr as their PASS. So the hard-coded path
 * does not fail loudly off this machine; it can pass for the wrong reason.
 *
 * WHAT IS ASSERTED, and why each claim is not the cheap version of itself:
 *
 *   1. CWD-INDEPENDENT — proven by running the helper in a CHILD process whose
 *      cwd is `/` and a temp dir, not by `process.chdir()` in-process. `chdir`
 *      is process-global and a Bun test worker runs files concurrently; a test
 *      that moves the shared cwd is a defect, not a proof.
 *
 *   2. MIRRORED CHECKOUT — a fixture repository at a DIFFERENT absolute prefix,
 *      built from a written `package.json` marker plus a SYMLINK to the real
 *      entrypoint. Nothing is copied wholesale (`cp -r` of this repo is 42 MB
 *      of tests alone). The helper file itself is copied — one file — because
 *      Bun resolves a symlinked module to its real path, which would put
 *      `import.meta.dir` back in the original checkout and quietly test
 *      nothing.
 *
 *   3. THE ARGV, not a root string. A root that resolves correctly while the
 *      argv is assembled wrong is still a broken spawn, so the assertion is on
 *      the full `["bun", <entry>, …args]` array the suites hand to `Bun.spawn`,
 *      and on its root-relative SHAPE being byte-identical between the two
 *      checkouts.
 *
 *   4. NEAREST MARKER WINS — a marker repository nested inside another resolves
 *      to the INNER one. This is the `.pristine-audit` case (a `git archive`
 *      extraction inside the working checkout, with no `.git` of its own) and
 *      is the reason the marker is the root `package.json` name rather than
 *      `.git`.
 *
 *   5. FAILS LOUD — outside any checkout the helper throws; a missing entry
 *      throws. Returning a plausible-but-wrong path is the failure mode under
 *      repair, so "returns something" is never an acceptable outcome.
 *
 *   6. WIRING — the three suites actually consume the helper and carry no
 *      absolute checkout literal. Without this, every claim above could hold
 *      for a helper nobody calls.
 */

import { describe, expect, test } from "bun:test"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import {
  bunEntryArgv,
  bunEntryArgvFrom,
  REPO_PACKAGE_NAME,
  REPO_ROOT,
  repoFile,
  repoFileFrom,
  repoRootFrom,
} from "../_helpers/repo-root"

const HELPER_SOURCE = join(REPO_ROOT, "tests/_helpers/repo-root.ts")
const CLI_ENTRY = "src/apps/cli/index.ts"
/** Child `bun run` of a one-file probe: loaded cold, so allow for a contended box. */
const CHILD_TIMEOUT_MS = 30_000

/** The suites whose hard-coded checkout path this helper exists to remove. */
const CONSUMERS = [
  "tests/unit/eval-grounding-cli.test.ts",
  "tests/integration/session-cli-subprocess.test.ts",
  "tests/integration/cli-live-debug-mode-hellgate.test.ts",
] as const

interface ProbeResult {
  readonly root: string
  readonly argv: readonly string[]
  readonly cwd: string
}

/**
 * Run the helper inside `helperDir`'s checkout from `cwd`, and report what it
 * resolved. The probe imports the helper by ABSOLUTE path, so the only thing
 * steering the answer is the helper's own location — which is the property
 * under test.
 */
const probe = async (helperPath: string, cwd: string): Promise<ProbeResult> => {
  const scriptDir = mkdtempSync(join(tmpdir(), "repo-root-probe-"))
  const script = join(scriptDir, "probe.ts")
  writeFileSync(
    script,
    [
      `import { REPO_ROOT, bunEntryArgv } from ${JSON.stringify(helperPath)}`,
      `const out = { root: REPO_ROOT, argv: bunEntryArgv(${JSON.stringify(CLI_ENTRY)}, ["--help"]), cwd: process.cwd() }`,
      `process.stdout.write(JSON.stringify(out))`,
    ].join("\n"),
  )
  try {
    const child = Bun.spawn({
      cmd: ["bun", "run", script],
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit, `probe child failed (cwd=${cwd})\nstdout: ${out}\nstderr: ${err}`).toBe(0)
    return JSON.parse(out) as ProbeResult
  } finally {
    rmSync(scriptDir, { recursive: true, force: true })
  }
}

/** Replace a checkout prefix with a placeholder, so two checkouts' argvs are
 *  comparable as SHAPES rather than as strings. */
const rootRelative = (root: string, argv: readonly string[]): readonly string[] =>
  argv.map((a) => (a.startsWith(root) ? `<ROOT>${a.slice(root.length)}` : a))

/**
 * A minimal foreign checkout: the marker manifest, plus a symlink to the real
 * entrypoint, plus a COPY of the helper (see the header for why a symlink
 * cannot be used for the helper itself). Nothing else — this is deliberately
 * not a copy of the repository.
 */
const makeMirror = (): {
  readonly root: string
  readonly helper: string
  readonly dispose: () => void
} => {
  // realpath: macOS exposes /tmp as a symlink to /private/tmp, and Bun reports
  // a module's `import.meta.dir` canonicalized. Comparing the child's answer to
  // an uncanonicalized fixture path would fail on the symlink, not on the claim.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "repo-root-mirror-")))
  const root = join(base, "mirrored-checkout")
  mkdirSync(join(root, "src/apps/cli"), { recursive: true })
  mkdirSync(join(root, "tests/_helpers"), { recursive: true })
  mkdirSync(join(root, "tests/integration"), { recursive: true })
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: REPO_PACKAGE_NAME }, null, 2)}\n`,
  )
  symlinkSync(repoFile(CLI_ENTRY), join(root, CLI_ENTRY))
  cpSync(HELPER_SOURCE, join(root, "tests/_helpers/repo-root.ts"))
  return {
    root,
    helper: join(root, "tests/_helpers/repo-root.ts"),
    dispose: () => rmSync(base, { recursive: true, force: true }),
  }
}

describe("repo-root helper — portability", () => {
  test("1. the resolved root is THIS checkout, and it is not a hard-coded prefix", () => {
    // The helper found a real marker manifest, and it is the one this test was
    // loaded from — `import.meta.dir` of this file sits under it.
    expect(existsSync(join(REPO_ROOT, "package.json"))).toBe(true)
    expect(
      (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { name?: string }).name,
    ).toBe(REPO_PACKAGE_NAME)
    expect(import.meta.dir.startsWith(REPO_ROOT)).toBe(true)
  })

  test(
    "2. entry resolution is identical from an arbitrary cwd (child processes, no global chdir)",
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), "repo-root-cwd-"))
      try {
        const fromRootDir = await probe(HELPER_SOURCE, "/")
        const fromTmp = await probe(HELPER_SOURCE, scratch)
        // Control: the two children really did run in different directories,
        // so "identical" below is not identical-because-nothing-varied.
        expect(fromRootDir.cwd).not.toBe(fromTmp.cwd)
        // The claim: same root, and the same ARGV — not merely the same string
        // for the root.
        expect(fromRootDir.root).toBe(REPO_ROOT)
        expect(fromTmp.root).toBe(REPO_ROOT)
        const expected = [...bunEntryArgv(CLI_ENTRY, ["--help"])]
        expect(fromRootDir.argv).toEqual(expected)
        expect(fromTmp.argv).toEqual(expected)
        expect(expected[1]).toBe(join(REPO_ROOT, CLI_ENTRY))
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    },
    CHILD_TIMEOUT_MS,
  )

  test(
    "3. a mirrored checkout at a DIFFERENT absolute prefix resolves the same argv shape",
    async () => {
      const mirror = makeMirror()
      try {
        // Different prefix, genuinely — otherwise the comparison is vacuous.
        expect(mirror.root.startsWith(REPO_ROOT)).toBe(false)
        const scratch = mkdtempSync(join(tmpdir(), "repo-root-mirror-cwd-"))
        try {
          const fromMirror = await probe(mirror.helper, scratch)
          expect(fromMirror.root).toBe(mirror.root)
          // The resolved ARGV points INTO the mirror, not into this checkout.
          expect(fromMirror.argv).toEqual(["bun", join(mirror.root, CLI_ENTRY), "--help"])
          expect(fromMirror.argv.some((a) => a.startsWith(REPO_ROOT))).toBe(false)
          // …and its root-relative SHAPE is byte-identical to this checkout's.
          expect(rootRelative(mirror.root, fromMirror.argv)).toEqual(
            rootRelative(REPO_ROOT, [...bunEntryArgv(CLI_ENTRY, ["--help"])]),
          )
        } finally {
          rmSync(scratch, { recursive: true, force: true })
        }
        // The same claim in-process, through the explicit-root seam.
        expect(repoRootFrom(join(mirror.root, "tests/integration"))).toBe(mirror.root)
        expect(bunEntryArgvFrom(mirror.root, CLI_ENTRY, ["--help"])).toEqual([
          "bun",
          join(mirror.root, CLI_ENTRY),
          "--help",
        ])
      } finally {
        mirror.dispose()
      }
    },
    CHILD_TIMEOUT_MS,
  )

  test("4. the NEAREST marker wins — a nested checkout does not resolve to the outer one", () => {
    // The `.pristine-audit` shape: a marker-bearing tree extracted INSIDE
    // another marker-bearing tree, with no `.git` of its own.
    const base = realpathSync(mkdtempSync(join(tmpdir(), "repo-root-nested-")))
    try {
      const outer = join(base, "outer")
      const inner = join(outer, ".pristine-audit")
      mkdirSync(join(inner, "src/apps/cli"), { recursive: true })
      mkdirSync(join(outer, "src/apps/cli"), { recursive: true })
      const manifest = `${JSON.stringify({ name: REPO_PACKAGE_NAME }, null, 2)}\n`
      writeFileSync(join(outer, "package.json"), manifest)
      writeFileSync(join(inner, "package.json"), manifest)
      symlinkSync(repoFile(CLI_ENTRY), join(inner, CLI_ENTRY))
      symlinkSync(repoFile(CLI_ENTRY), join(outer, CLI_ENTRY))
      expect(existsSync(join(inner, "package.json"))).toBe(true)
      expect(repoRootFrom(join(inner, "src/apps/cli"))).toBe(inner)
      expect(repoRootFrom(join(outer, "src/apps/cli"))).toBe(outer)
      expect(bunEntryArgvFrom(inner, CLI_ENTRY)).toEqual(["bun", join(inner, CLI_ENTRY)])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("5. outside a checkout it THROWS; a missing entry THROWS (never a plausible guess)", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "repo-root-none-")))
    try {
      expect(() => repoRootFrom(outside)).toThrow(/no package.json with name/)
      // A manifest with the WRONG name is not this repository.
      writeFileSync(join(outside, "package.json"), '{"name":"someone-else"}')
      expect(() => repoRootFrom(outside)).toThrow(/no package.json with name/)
      expect(() => repoFile("src/apps/cli/definitely-not-here.ts")).toThrow(/does not exist/)
      expect(() => repoFileFrom(REPO_ROOT, "src/apps/cli/definitely-not-here.ts")).toThrow(
        /does not exist/,
      )
      // A moved entrypoint must fail as a moved entrypoint, BEFORE any spawn.
      expect(() => bunEntryArgv("src/apps/cli/definitely-not-here.ts")).toThrow(/does not exist/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("6. WIRING — the three subprocess suites consume the helper and carry no checkout literal", () => {
    // Without this, every claim above could be true of a helper nobody calls.
    // The literal is assembled so this guard's own source cannot satisfy the
    // search it performs.
    const absolutePrefix = `/${["Users", "songmin", "quanta-codeagent-v3"].join("/")}`
    for (const rel of CONSUMERS) {
      const src = readFileSync(repoFile(rel), "utf8")
      expect(src, `${rel} must import the shared repo-root helper`).toContain("_helpers/repo-root")
      expect(src.includes(absolutePrefix), `${rel} still carries an absolute checkout path`).toBe(
        false,
      )
    }
  })
})

/**
 * A killed worker must not be able to dirty the tracked tree.
 *
 * MEASURED: a prepush campaign bailed on a failing chunk, cancelled its peers,
 * and one of them died inside a compiled-probe test whose `finally` therefore
 * never ran. It left `__compiled-parser-probe-38563.ts` in the REPO ROOT, where
 * the next run's typecheck, lint and lint:debt all read it. The campaign's own
 * end-snapshot caught it as `endDirty=true` and invalidated an otherwise
 * complete run — the guard worked, and the cause was still there.
 *
 * `finally` is not the fix. A SIGKILL has no `finally`. The fix is to write
 * where a leak cannot matter: inside the repo, because bun resolves `@/…` and
 * `node_modules` by walking up from the entry, but under `.cache/`, which is
 * gitignored. Resolution is identical — measured, the compiled probe still
 * reports `{ready: true, verdict: "hard-deny"}` from there.
 */
describe("no test writes a scratch entry to the repo root", () => {
  const ROOT_SCRATCH =
    /join\(\s*REPO_ROOT\s*,\s*`[^`/]*\$\{[^}]*\}[^`/]*\.(?:ts|js|mjs|cjs|json|txt)`/

  const walkableDir = (name: string): boolean => name !== "node_modules" && !name.startsWith(".")

  /**
   * `import.meta.path` is skipped: this file must contain the forbidden shape
   * VERBATIM to prove the detector fires on it, so it is the one file the
   * detector cannot read. Named, not pattern-excluded — a second exemption
   * would have to be written here on purpose.
   */
  const leaksToRoot = (full: string): boolean =>
    full !== import.meta.path && ROOT_SCRATCH.test(readFileSync(full, "utf8"))

  const rootWritersUnder = (dir: string): readonly string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return walkableDir(entry.name) ? rootWritersUnder(full) : []
      if (!entry.name.endsWith(".test.ts")) return []
      return leaksToRoot(full) ? [relative(REPO_ROOT, full)] : []
    })

  test("every compiled-probe entry lives under an ignored directory", () => {
    const offenders = rootWritersUnder(join(REPO_ROOT, "tests"))
    expect(
      offenders,
      "a pid-named scratch file at the repo root survives a SIGKILL and breaks the NEXT " +
        `run's typecheck/lint. Write it under .cache/ instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([])
  })

  test("the detector fires on the exact shape that leaked", () => {
    // ANTI-VACUITY: the arm above passes for a detector that matches nothing.
    const LEAKED = ["join(REPO_ROOT, `__compiled-parser-probe-", "{process.pid}.ts`)"].join("$")
    expect(ROOT_SCRATCH.test(LEAKED)).toBe(true)
    // ...and not on the fixed form it was moved to, nor on ordinary reads.
    const FIXED = [
      'join(REPO_ROOT, ".cache", "compiled-probe", `entry-',
      "{process.pid}.ts`)",
    ].join("$")
    expect(ROOT_SCRATCH.test(FIXED)).toBe(false)
    expect(ROOT_SCRATCH.test('join(REPO_ROOT, "package.json")')).toBe(false)
  })
})
