import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { collectBiomeTargets } from "./biome-targets"

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const biomeBin = join(repoRoot, "node_modules/.bin/biome")
const argv = process.argv.slice(2)
const [subcommand = "check", ...rest] = argv
const targets = collectBiomeTargets(repoRoot)

const proc = Bun.spawn([biomeBin, subcommand, ...rest, ...targets], {
  cwd: repoRoot,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
})

process.exit(await proc.exited)
