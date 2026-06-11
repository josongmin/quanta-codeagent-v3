// #24 one-shot codemod — neutralize stale `=== "1"` strict claims ONLY inside
// the doc/inline ranges of LOOSE-resolver (gateOn / parseBool) knobs. gateOnStrict
// knobs are left untouched (their `=== "1"` claim is TRUE). Run once; the ratchet
// (runtime-config-gate-doc-drift-hellgate) verifies completeness.
import { readFileSync, writeFileSync } from "node:fs"

const path = "src/shared/runtime-config.ts"
const lines = readFileSync(path, "utf8").split("\n")

// 1. resolver kind per field
const resolverRe = /^\s*(\w+):\s*(gateOnStrict|gateOn|parseBool)\(/
const looseFields = new Set()
const looseInlineRanges = [] // [startIdx, endIdxInclusive] of `//` block above a loose resolver
for (let i = 0; i < lines.length; i++) {
  const m = resolverRe.exec(lines[i] ?? "")
  if (m === null) continue
  if (m[2] === "gateOnStrict") continue
  looseFields.add(m[1])
  let s = i
  for (let j = i - 1; j >= 0; j--) {
    if ((lines[j] ?? "").trim().startsWith("//")) s = j
    else break
  }
  if (s < i) looseInlineRanges.push([s, i - 1])
}

// 2. doc-block ranges for each loose `readonly <field>:`
const fieldRe = /^\s*readonly\s+(\w+):/
const looseDocRanges = []
for (let i = 0; i < lines.length; i++) {
  const m = fieldRe.exec(lines[i] ?? "")
  if (m === null || !looseFields.has(m[1])) continue
  let s = -1
  for (let j = i - 1; j >= 0; j--) {
    const ln = (lines[j] ?? "").trim()
    if (ln.endsWith("*/") || ln.startsWith("*") || ln.startsWith("/**")) {
      s = j
      if (ln.startsWith("/**")) break
    } else break
  }
  if (s >= 0) looseDocRanges.push([s, i - 1])
}

const inRange = new Set()
for (const [s, e] of [...looseInlineRanges, ...looseDocRanges])
  for (let k = s; k <= e; k++) inRange.add(k)

// 3. replacements, applied IN ORDER, only to in-range lines
const apply = (line) => {
  let s = line
  s = s.replace(/Strict opt-in \(`=== "1"`\)/g, "Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24)")
  s = s.replace(/strict `=== "1"` opt-in/g, "opt-in (`gateOn` vocab; #24)")
  s = s.replace(/Strict opt-in/g, "Opt-in")
  s = s.replace(/opt-in \(`=== "1"`\)/g, "opt-in (`gateOn` vocab; #24)")
  // catch-all — any remaining `=== "1"` claim in a loose range is false.
  s = s.replace(/`=== "1"`/g, "the `gateOn` truthy vocab (#24)")
  return s
}

let changed = 0
for (const k of inRange) {
  const next = apply(lines[k] ?? "")
  if (next !== lines[k]) {
    lines[k] = next
    changed++
  }
}
writeFileSync(path, lines.join("\n"))
console.log(`loose fields: ${looseFields.size}, in-range lines: ${inRange.size}, lines changed: ${changed}`)
