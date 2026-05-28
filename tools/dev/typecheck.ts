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
    label: string
  }
> = {
  src: {
    config: "tsconfig.typecheck.src.json",
    buildInfo: ".cache/typescript/typecheck-src.tsbuildinfo",
    label: "src+tools",
  },
  tests: {
    config: "tsconfig.typecheck.tests.json",
    buildInfo: ".cache/typescript/typecheck-tests.tsbuildinfo",
    label: "tests",
  },
  all: {
    config: "tsconfig.json",
    buildInfo: ".cache/typescript/typecheck-all.tsbuildinfo",
    label: "full-tree",
  },
}

if (!(target in targetConfig)) {
  console.error(`unknown typecheck target: ${target}`)
  console.error("usage: bun run tools/dev/typecheck.ts [src|tests|all]")
  process.exit(2)
}

await Bun.$`mkdir -p ${buildInfoDir}`.quiet()

const selected = targetConfig[target]
const start = performance.now()

console.log(
  `typecheck target=${target} scope=${selected.label} config=${selected.config} buildinfo=${selected.buildInfo}`,
)

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
  console.log(`typecheck target=${target} passed (${durationMs}ms)`)
}

process.exit(exitCode)
