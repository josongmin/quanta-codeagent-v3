/**
 * Hellgate — a `kind: "bool"` knob read through a STRICT helper must say so.
 *
 * `kind: "bool"` on the `/knobs` surface advertises the canonical vocabulary:
 * `1`/`on`/`true`/`yes` arm, `0`/`off`/`false`/`no` disarm (`src/shared/env-flag.ts`).
 * Two helpers deliberately do NOT honour it, and the strictness is the safety
 * property:
 *
 *   gateOnStrict(env, k)        arms ONLY on the exact literal "1"
 *   gateDisabledStrict(env, k)  disarms ONLY on the exact literal "off"
 *
 * Both measured, all twelve spellings. Neither trims, neither folds case.
 *
 * So a security gate read through `gateOnStrict` and declared `kind: "bool"` tells
 * the operator that `=true` arms it. It does not, silently, and `/knobs set` accepts
 * the value and prints "export it to apply". An operator can believe a protection is
 * armed when nothing is armed — `QUANTA_EXFIL_SCOUTING`, `QUANTA_GLOB_WRITE_GUARD`,
 * `QUANTA_FS_OWNERSHIP_ENFORCE` and `QUANTA_CIRCUMVENT_DETECT` are in this set.
 *
 * The required phrase is DERIVED from which helper reads the knob, not written here,
 * so it cannot drift from the helper. The read is located by the AST census, not a
 * regex — the same census the completeness and read-site ratchets use.
 *
 * This is a ceiling, not a ban: the rows are burned down by writing the token into
 * the describe, and the ceiling may only decrease.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CLI_KNOBS } from "@/apps/cli/cli-knobs"
import { KNOB_INVENTORY } from "@/config/knob-inventory"
import { RUNTIME_CONFIG_KNOBS } from "@/shared/runtime-config-knobs"
import {
  censusFiles,
  type KnobAccess,
  trackedSourceFiles,
} from "../../../tools/dev/knob-env-access"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/** The two strict helpers, and the ONLY token each honours. Verified by execution:
 *  every other spelling, including `OFF` and `" off "`, is refused by both. */
const STRICT_HELPERS: Readonly<Record<string, string>> = {
  gateOnStrict: "1",
  gateDisabledStrict: "off",
}

/**
 * Rows still missing the phrase. May ONLY decrease, and it is at ZERO.
 *
 * The measured population was 28: every `kind: "bool"` declaration whose read is
 * strict and whose describe did not name the one token that works. All 28 were
 * burned down in the same change by appending a phrase DERIVED from the helper, so
 * the ceiling starts where it should end. A new strict knob must carry the phrase.
 */
const UNNAMED_CEILING = 0

interface BoolRow {
  readonly envKey: string
  readonly describe: string
}

const boolRows = (): Map<string, BoolRow> => {
  const out = new Map<string, BoolRow>()
  const all = [...KNOB_INVENTORY, ...CLI_KNOBS, ...RUNTIME_CONFIG_KNOBS] as readonly {
    envKey: string
    kind: string
    describe?: string
  }[]
  for (const k of all) {
    if (k.kind !== "bool" || out.has(k.envKey)) continue
    out.set(k.envKey, { envKey: k.envKey, describe: k.describe ?? "" })
  }
  return out
}

/**
 * A hand-rolled strict comparison at an AST-located read site.
 *
 * Four knobs do not use either helper and compare a literal inline —
 * `env.QUANTA_MD_HIGHLIGHT !== "0"`, `envPort.get(K) !== "1"`. Same operator-visible
 * lie: `kind: "bool"` advertises four falsy tokens and one works.
 *
 * The line is read at a site the AST census already resolved, not found by scanning
 * the tree, so this cannot over-match onto prose. A shape it fails to recognise
 * UNDER-reports (the knob is simply not covered), never over-reports.
 */
const HAND_ROLLED = /(?:===|!==)\s*"([01]|on|off)"/

/** Cache of source lines, so one file is read once across many accesses. */
const lineCache = new Map<string, string[]>()

const sourceLine = (file: string, line: number): string => {
  if (!lineCache.has(file)) {
    lineCache.set(file, readFileSync(join(REPO_ROOT, file), "utf8").split("\n"))
  }
  return (lineCache.get(file) as string[])[line - 1] ?? ""
}

/** The strict token a single access implies, or `undefined`. */
const tokenOf = (a: KnobAccess): string | undefined => {
  if (a.kind !== "read") return undefined
  const helper = a.form === "call-arg" ? STRICT_HELPERS[a.callee ?? ""] : undefined
  if (helper !== undefined) return helper
  // EVERY other shape falls through to the line check, including a `call-arg` to a
  // NON-helper: `envPort.get(GH_ACTIONS_TRIGGER_ENV) !== "1"` is a call-arg whose
  // callee is not a strict helper, and skipping those hid three of the four
  // hand-rolled knobs on the first attempt.
  const line = sourceLine(a.file, a.line)
  const t = line.trimStart()
  if (t.startsWith("*") || t.startsWith("//")) return undefined
  return HAND_ROLLED.exec(line)?.[1]
}

/** envKey → the strict token its read requires, for knobs read strictly. */
/**
 * Computed ONCE, at module scope. The census parses every tracked src file. This file ran
 * it three to four times inside test bodies — `unnamed()` calls it again — and under a
 * loaded box the arms crossed bun's 5s per-test timeout (5065ms and 5754ms in five runs at
 * load 39). Memoising alone moved the whole cost into whichever test ran first (6840ms at
 * load 40). Module scope is where a one-time parse belongs: it reads files, starts no
 * process, and no per-test timer covers it.
 */
const strictlyRead = (): Map<string, string> => STRICTLY_READ
const computeStrictlyRead = (): Map<string, string> => {
  const files = trackedSourceFiles(REPO_ROOT, ["src"]).filter(
    (f) => !/\.test\.tsx?$/.test(f) && !f.includes("/__tests__/"),
  )
  const { accesses } = censusFiles(REPO_ROOT, files)
  const out = new Map<string, string>()
  for (const a of accesses) {
    if (out.has(a.key)) continue
    const token = tokenOf(a)
    if (token !== undefined) out.set(a.key, token)
  }
  return out
}

const STRICTLY_READ: Map<string, string> = computeStrictlyRead()

/** The describe names the token as a literal, in any of the ways we write it. */
const namesToken = (describe: string, token: string): boolean =>
  [`\`=${token}\``, `\`${token}\``, `=${token}`].some((form) => describe.includes(form))

const unnamed = (): { envKey: string; token: string }[] => {
  const rows = boolRows()
  const strict = strictlyRead()
  const out: { envKey: string; token: string }[] = []
  for (const [envKey, token] of strict) {
    const row = rows.get(envKey)
    if (row === undefined) continue
    if (!namesToken(row.describe, token)) out.push({ envKey, token })
  }
  return out.sort((a, b) => a.envKey.localeCompare(b.envKey))
}

describe("bool knob vocabulary parity", () => {
  test("ANTI-VACUITY: the census finds bool knobs AND strict reads", () => {
    const rows = boolRows()
    const strict = strictlyRead()
    expect(rows.size, "no bool declarations — the ceiling would be free").toBeGreaterThan(300)
    expect(strict.size, "no strict reads found — the census stopped resolving").toBeGreaterThan(25)
    // Both helpers must be represented, or one of them is silently unscanned.
    expect([...new Set(strict.values())].sort()).toEqual(["0", "1", "off"])
  })

  test("the required token is what the helper actually honours", async () => {
    const { gateDisabledStrict, gateOnStrict } = await import("@/shared/env-flag")
    const spellings = ["", "1", "0", "on", "off", "true", "false", "yes", "no", "OFF", " off "]
    for (const v of spellings) {
      expect(gateOnStrict({ K: v }, "K"), `gateOnStrict K=${v}`).toBe(v === "1")
      expect(gateDisabledStrict({ K: v }, "K"), `gateDisabledStrict K=${v}`).toBe(v === "off")
    }
    expect(gateOnStrict({}, "K")).toBe(false)
    expect(gateDisabledStrict({}, "K")).toBe(false)
  })

  test(`strict bool knobs whose describe hides it stay <= ${UNNAMED_CEILING}`, () => {
    const rows = unnamed()
    // biome-ignore lint/suspicious/noConsole: ratchet visibility for reviewers
    console.log(`[bool-vocab] ${rows.length}/${UNNAMED_CEILING} strict bool knobs unnamed`)
    if (rows.length > UNNAMED_CEILING) {
      const list = rows
        .map((r) => `  ${r.envKey}  (read strictly: only \`=${r.token}\` works)`)
        .join("\n")
      throw new Error(
        `${rows.length} bool-declared knobs are read through a STRICT helper and do not say so ` +
          `(ceiling ${UNNAMED_CEILING}). \`kind: "bool"\` advertises 1/on/true/yes and ` +
          `0/off/false/no; these honour ONE literal. Name it in the describe:\n${list}`,
      )
    }
    expect(rows.length).toBeLessThanOrEqual(UNNAMED_CEILING)
  })

  /** PAIRED CONTROL: the phrase check must be capable of both answers, or the
   *  ceiling could be met by a matcher that accepts everything. */
  test("the describe check is not vacuous in either direction", () => {
    expect(namesToken("Strict: only `=1` arms it.", "1")).toBe(true)
    expect(namesToken("Set =off to disable.", "off")).toBe(true)
    expect(namesToken("A perfectly ordinary bool knob.", "1")).toBe(false)
    expect(namesToken("Set =off to disable.", "1")).toBe(false)
    expect(namesToken("Kill-switch: `=0` only.", "0")).toBe(true)
    // At least one row in the tree already passes, so the ceiling is not the whole set.
    const strict = strictlyRead()
    expect(strict.size - unnamed().length, "no strict row names its token").toBeGreaterThan(0)
  })
})
