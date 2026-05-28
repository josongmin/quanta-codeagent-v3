import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"

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

const safeStat = async (relativePath: string): Promise<{ path: string; size: number; mtimeMs: number } | null> => {
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

const buildFingerprint = async (target: TypecheckTarget, configPath: string): Promise<string> => {
  const selected = targetConfig[target]
  const trackedFiles = new Set<string>(trackedConfigFiles(target, configPath))
  for (const root of selected.scanRoots) {
    for (const file of await walkTrackedFiles(root)) trackedFiles.add(file)
  }
  const entries = (
    await Promise.all([...trackedFiles].sort().map((file) => safeStat(file)))
  ).filter((entry): entry is { path: string; size: number; mtimeMs: number } => entry !== null)
  return createHash("sha1").update(JSON.stringify(entries)).digest("hex")
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

if (!(target in targetConfig)) {
  console.error(`unknown typecheck target: ${target}`)
  console.error("usage: bun run tools/dev/typecheck.ts [src|tests|all]")
  process.exit(2)
}

const selected = targetConfig[target]
const start = performance.now()
const skipAllowed = process.env["QUANTA_TYPECHECK_NO_SKIP"] !== "1"
const buildInfoPath = join(repoRoot, selected.buildInfo)
const stampPath = join(repoRoot, selected.stamp)

await mkdir(buildInfoDir, { recursive: true })

console.log(
  `typecheck target=${target} scope=${selected.label} config=${selected.config} buildinfo=${selected.buildInfo}`,
)

const fingerprint = await buildFingerprint(target, selected.config)
const previousFingerprint = await loadPreviousFingerprint(selected.stamp)
const buildInfoExists = await safeStat(selected.buildInfo)

if (skipAllowed && buildInfoExists !== null && previousFingerprint === fingerprint) {
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
const durationMs = Math.round(performance.now() - start)

if (exitCode === 0) {
  await writeFile(
    stampPath,
    JSON.stringify(
      {
        target,
        fingerprint,
        config: selected.config,
        buildInfo: selected.buildInfo,
      },
      null,
      2,
    ),
  )
  console.log(`typecheck target=${target} passed (${durationMs}ms)`)
}

process.exit(exitCode)
