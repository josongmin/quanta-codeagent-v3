import { existsSync, readFileSync } from "node:fs"
import { KNOB_INVENTORY } from "./src/config/knob-inventory"
let missingFile = 0, notRead = 0
const offenders: string[] = []
for (const e of KNOB_INVENTORY) {
  const rs = (e as any).readSite as string | undefined
  if (!rs) continue
  const path = "src/" + rs.split(/[\s(]/)[0]
  if (!existsSync(path)) { missingFile++; offenders.push(`NOFILE  ${e.envKey} -> ${rs}`); continue }
  if (!readFileSync(path, "utf8").includes(e.envKey)) { notRead++; offenders.push(`NOREAD  ${e.envKey} -> ${rs}`) }
}
console.log(`total=${KNOB_INVENTORY.length} missingFile=${missingFile} notRead=${notRead}`)
for (const o of offenders) console.log("  " + o)
