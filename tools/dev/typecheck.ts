import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const tscBin = join(repoRoot, "node_modules/.bin/tsc")
const buildInfoDir = join(repoRoot, ".cache", "typescript")

type TypecheckTarget = "src" | "tests" | "all"

const target = (process.argv[2] as TypecheckTarget | undefined) ?? "src"

const targetConfig: Record<
  TypecheckTarget,
  {
    config: string
    buildInfo: string
    stamp: string
    label: string
    scanRoots: readonly string[]
  }
> = {
  src: {
    config: "tsconfig.typecheck.src.json",
    buildInfo: ".cache/typescript/typecheck-src.tsbuildinfo",
    stamp: ".cache/typescript/typecheck-src.stamp.json",
    label: "src+tools",
    scanRoots: ["src", "tools"],
  },
  tests: {
    config: "tsconfig.typecheck.tests.json",
    buildInfo: ".cache/typescript/typecheck-tests.tsbuildinfo",
    stamp: ".cache/typescript/typecheck-tests.stamp.json",
    label: "tests",
    scanRoots: ["tests", "src", "tools"],
  },
  all: {
    config: "tsconfig.json",
    buildInfo: ".cache/typescript/typecheck-all.tsbuildinfo",
    stamp: ".cache/typescript/typecheck-all.stamp.json",
    label: "full-tree",
    scanRoots: ["src", "tests", "tools"],
  },
}

const trackedConfigFiles = (target: TypecheckTarget, configPath: string): readonly string[] => {
  const base = [
    "package.json",
    "bun.lock",
    "tsconfig.base.json",
    "tools/dev/typecheck.ts",
    "node_modules/typescript/package.json",
  ]
  if (target === "all") return [...base, "tsconfig.json"]
  return [...base, configPath]
}

const trackedExtension = (file: string): boolean =>
  [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".json"].some((suffix) => file.endsWith(suffix))

const walkTrackedFiles = async (relativeDir: string): Promise<string[]> => {
  const start = join(repoRoot, relativeDir)
  const out: string[] = []

  const visit = async (absoluteDir: string, relativePath: string): Promise<void> => {
    const entries = await readdir(absoluteDir, { withFileTypes: true })
    for (const entry of entries) {
      const nextRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`
      if (entry.isDirectory()) {
        if (nextRelative === "tests/smoke/fixtures") continue
        if (nextRelative.startsWith("dist/")) continue
        if (nextRelative.startsWith("node_modules/")) continue
        await visit(join(absoluteDir, entry.name), nextRelative)
        continue
      }
      if (!entry.isFile()) continue
      if (!trackedExtension(entry.name)) continue
      out.push(nextRelative)
    }
  }

  await visit(start, relativeDir)
  return out
}

const safeStat = async (
  relativePath: string,
): Promise<{ path: string; size: number; mtimeMs: number } | null> => {
  try {
    const info = await stat(join(repoRoot, relativePath))
    if (!info.isFile()) return null
    return {
      path: relativePath,
      size: info.size,
      mtimeMs: Math.trunc(info.mtimeMs),
    }
  } catch {
    return null
  }
}

type FingerprintEntry = { path: string; hash: string }

// Hash the actual CONTENT of each tracked file, not a mtime+size proxy.
// Rationale (RCA jun-08): mtime+size is an unsound change-detector — a content
// change that preserves size while mtime is reset to an older value
// (git checkout / stash pop / rsync --times / mtime-preserving editors) yields
// an identical fingerprint, so the stamp falsely reports "unchanged" and tsc is
// skipped, masking newly-introduced type errors. Content hashing is exact:
// any byte change in a checked file invalidates the stamp. Reads are cheap
// relative to a full `tsc --noEmit` pass, so the cache's perf benefit (skip when
// the tree is truly byte-identical) is preserved.
export const hashTrackedFile = async (
  relativePath: string,
  baseDir: string = repoRoot,
): Promise<FingerprintEntry | null> => {
  const absolute = join(baseDir, relativePath)
  try {
    const info = await stat(absolute)
    if (!info.isFile()) return null
    const content = await readFile(absolute)
    const hash = createHash("sha1").update(content).digest("hex")
    return { path: relativePath, hash }
  } catch {
    return null
  }
}

export const fingerprintOf = (entries: readonly FingerprintEntry[]): string =>
  createHash("sha1").update(JSON.stringify(entries)).digest("hex")

export const typecheckSkipEligible = (input: {
  readonly skipAllowed: boolean
  readonly previousFingerprint: string | null
  readonly buildInfoExists: boolean
}): boolean => input.skipAllowed && input.previousFingerprint !== null && input.buildInfoExists

const buildFingerprint = async (target: TypecheckTarget, configPath: string): Promise<string> => {
  const selected = targetConfig[target]
  const trackedFiles = new Set<string>(trackedConfigFiles(target, configPath))
  for (const root of selected.scanRoots) {
    for (const file of await walkTrackedFiles(root)) trackedFiles.add(file)
  }
  const entries = (
    await Promise.all([...trackedFiles].sort().map((file) => hashTrackedFile(file)))
  ).filter((entry): entry is FingerprintEntry => entry !== null)
  return fingerprintOf(entries)
}

const loadPreviousFingerprint = async (stampPath: string): Promise<string | null> => {
  try {
    const raw = await readFile(join(repoRoot, stampPath), "utf8")
    const parsed = JSON.parse(raw) as { fingerprint?: unknown }
    return typeof parsed.fingerprint === "string" ? parsed.fingerprint : null
  } catch {
    return null
  }
}

const runTypecheck = async (): Promise<never> => {
  if (!(target in targetConfig)) {
    console.error(`unknown typecheck target: ${target}`)
    console.error("usage: bun run tools/dev/typecheck.ts [src|tests|all]")
    process.exit(2)
  }

  const selected = targetConfig[target]
  const start = performance.now()
  const skipAllowed = process.env.QUANTA_TYPECHECK_NO_SKIP !== "1"
  const debugEnabled = process.env.QUANTA_TYPECHECK_DEBUG === "1"
  const stampPath = join(repoRoot, selected.stamp)

  await mkdir(buildInfoDir, { recursive: true })

  console.log(
    `typecheck target=${target} scope=${selected.label} config=${selected.config} buildinfo=${selected.buildInfo}`,
  )

  // A full content fingerprint is useful only when it can produce an immediate
  // cache hit. A forced run, missing stamp, or missing buildinfo must invoke tsc
  // regardless, so do not make that path hash the tree before compilation.
  const [previousFingerprint, buildInfo] = skipAllowed
    ? await Promise.all([loadPreviousFingerprint(selected.stamp), safeStat(selected.buildInfo)])
    : ([null, null] as const)
  const skipEligible = typecheckSkipEligible({
    skipAllowed,
    previousFingerprint,
    buildInfoExists: buildInfo !== null,
  })
  let fingerprint: string | undefined

  if (skipEligible) fingerprint = await buildFingerprint(target, selected.config)

  if (debugEnabled) {
    console.log(
      `typecheck debug target=${target} skipEligible=${skipEligible} previousFingerprint=${previousFingerprint ?? "null"} currentFingerprint=${fingerprint ?? "not-computed"} buildInfoExists=${buildInfo !== null}`,
    )
  }

  if (skipEligible && previousFingerprint === fingerprint) {
    const durationMs = Math.round(performance.now() - start)
    console.log(`typecheck target=${target} unchanged; skipping (${durationMs}ms)`)
    process.exit(0)
  }

  const proc = Bun.spawn(
    [
      tscBin,
      "-p",
      selected.config,
      "--noEmit",
      "--incremental",
      "--pretty",
      "false",
      "--tsBuildInfoFile",
      selected.buildInfo,
    ],
    {
      cwd: repoRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    },
  )

  const exitCode = await proc.exited

  if (exitCode === 0) {
    // Stamp the tree only after a successful mandatory run. Besides avoiding
    // pre-run work, this makes the stamp describe the post-tsc source snapshot.
    fingerprint ??= await buildFingerprint(target, selected.config)
    await writeFile(
      stampPath,
      JSON.stringify(
        {
          target,
          fingerprint,
          debug: {
            target,
            computedAt: new Date().toISOString(),
          },
          config: selected.config,
          buildInfo: selected.buildInfo,
        },
        null,
        2,
      ),
    )
    const durationMs = Math.round(performance.now() - start)
    console.log(`typecheck target=${target} passed (${durationMs}ms)`)
  }

  process.exit(exitCode)
}

if (import.meta.main) {
  await runTypecheck()
}
