import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { CLI_KNOBS } from "../src/apps/cli/cli-knobs.ts"
import { CLI_FEATURE_GATES } from "../src/apps/cli/cli-feature-gates.ts"
import { KNOB_INVENTORY } from "../src/config/knob-inventory.ts"
import { RUNTIME_CONFIG_KNOBS } from "../src/shared/runtime-config-knobs.ts"
import { allKnobs } from "../src/runner/knobs/index.ts"
import "../src/runner/knobs/knobs/index.ts"

const rcKeys = new Set(RUNTIME_CONFIG_KNOBS.map((k) => k.envKey))
const runnerMap = allKnobs()

console.log("=== DUAL CHANNEL runner envKey in runtime-config-knobs ===")
const dual = [...runnerMap.values()].filter((k) => rcKeys.has(k.envKey))
console.log(dual.map((k) => k.envKey).sort().join(", ") || "(none by envKey)")

console.log("\n=== inventory home=runtime-config NOT in runtime-config-knobs ===")
const orphans = KNOB_INVENTORY.filter((k) => k.home === "runtime-config" && !rcKeys.has(k.envKey))
console.log("count:", orphans.length)
const bySite: Record<string, number> = {}
for (const o of orphans) bySite[o.readSite] = (bySite[o.readSite] ?? 0) + 1
console.log(
  "top readSites:",
  Object.entries(bySite)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([s, n]) => `${n}:${s}`)
    .join("\n  "),
)

console.log("\n=== CLI_FEATURE_GATES also in runtime-config-knobs ===")
const gatesInRc = CLI_FEATURE_GATES.filter((g) => rcKeys.has(g.gate)).map((g) => g.gate)
console.log(gatesInRc.join(", "))

console.log("\n=== CLI_KNOBS referenced in runtime-config.ts source ===")
const rcSrc = readFileSync("./src/shared/runtime-config.ts", "utf8")
for (const k of CLI_KNOBS) {
  if (rcSrc.includes(k.envKey)) console.log(k.envKey)
}

const rcReads = new Set<string>()
for (const m of rcSrc.matchAll(
  /(?:env\.(QUANTA_[A-Z0-9_]+)|[`"'](QUANTA_[A-Z0-9_]+)[`"'])/g,
)) {
  const name = m[1] ?? m[2]
  if (name) rcReads.add(name)
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) {
      if (e === "__tests__" || e === "node_modules") continue
      out.push(...walk(p))
    } else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p)
  }
  return out
}

const RAW =
  /process\.env\.(QUANTA_[A-Z0-9_]+)|process\.env\[\s*[`"'](QUANTA_[A-Z0-9_]+)[`"']|gate(?:On|Disabled)(?:Strict)?\s*\(\s*process\.env\b[^)]*[`"'](QUANTA_[A-Z0-9_]+)[`"']/g

console.log("\n=== runtime-config vars with RAW process.env reads elsewhere (exempt bench) ===")
const rawDup: Record<string, string[]> = {}
for (const file of walk("./src")) {
  if (file.includes("/apps/bench/")) continue
  if (file.endsWith("runtime-config.ts")) continue
  if (file.endsWith("cli-knobs-accessor.ts")) continue
  const src = readFileSync(file, "utf8")
  for (const line of src.split("\n")) {
    if (line.trimStart().startsWith("//")) continue
    for (const m of line.matchAll(RAW)) {
      const key = m[1] ?? m[2] ?? m[3]
      if (key && rcReads.has(key)) {
        const rel = file.replace(/.*src\//, "src/")
        ;(rawDup[key] ??= []).push(rel)
      }
    }
  }
}
for (const [k, files] of Object.entries(rawDup)
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 25)) {
  console.log(`${k}: ${[...new Set(files)].join(", ")}`)
}

console.log("\n=== parseEnvFlag definition sites ===")
for (const file of walk("./src")) {
  const src = readFileSync(file, "utf8")
  if (/export (?:function|const) parseEnvFlag/.test(src)) {
    console.log(file.replace(/.*src\//, "src/"))
  }
}

console.log("\n=== gateOn/gateDisabled definition sites ===")
for (const file of walk("./src")) {
  const src = readFileSync(file, "utf8")
  if (/export (?:function|const) gateOn/.test(src)) {
    console.log(file.replace(/.*src\//, "src/"))
  }
}

console.log("\n=== runtime-config-knobs vars with RAW process.env reads outside runtime-config.ts ===")
const rcKnobKeys = RUNTIME_CONFIG_KNOBS.map((k) => k.envKey)
const rawOutsideRc: Record<string, string[]> = {}
for (const file of walk("./src")) {
  if (
    file.includes("/apps/bench/") ||
    file.endsWith("runtime-config.ts") ||
    file.endsWith("cli-knobs-accessor.ts")
  ) {
    continue
  }
  const src = readFileSync(file, "utf8")
  for (const line of src.split("\n")) {
    if (line.trimStart().startsWith("//")) continue
    if (!/process\.env|gate(?:On|Disabled)(?:Strict)?\s*\(\s*process\.env/.test(line)) continue
    for (const k of rcKnobKeys) {
      if (line.includes(k)) {
        const rel = file.replace(/.*src\//, "src/")
        ;(rawOutsideRc[k] ??= []).push(rel)
      }
    }
  }
}
for (const [k, files] of Object.entries(rawOutsideRc).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${k}: ${[...new Set(files)].join(", ")}`)
}

console.log("\n=== inventory-only gates (in inventory, NOT runtime-config-knobs, seeded by CLI) ===")
const invOnly = KNOB_INVENTORY.filter((k) => k.home === "runtime-config" && !rcKeys.has(k.envKey))
const seededInvOnly = invOnly.filter((k) => CLI_FEATURE_GATES.some((g) => g.gate === k.envKey))
console.log(seededInvOnly.map((k) => k.envKey).sort().join(", "))
