/**
 * MENTION-GATE DECLARED-DEFAULT PARITY.
 *
 * INVARIANT: for every `@mention` gate, the default recorded in
 * `KNOB_INVENTORY` equals what the REAL resolver does when the knob is unset.
 *
 * WHY THIS EXISTS. `QUANTA_MENTION_FILE` and `QUANTA_MENTION_SKILL` were declared
 * with `default: false` and a describe reading "Unset ⇒ the resolver returns
 * undefined". Both were false. Every mention gate reads through one helper —
 *
 *     const isOn = (env, key) => parseEnvFlag(env[key], /* defaultOn *_/ true)
 *
 * — so unset means ON, and the five siblings declared alongside them
 * (`_FOLDER`, `_GIT`, `_MCP`, `_SUBAGENT`, `_THREAD`) were all correctly
 * `default: true`. The `/knobs` surface printed the wrong default for two rows on
 * both the CLI and the web daemon, and an operator reading it would have exported
 * `QUANTA_MENTION_FILE=1` believing they were turning something on.
 *
 * Nothing caught it: the completeness ratchet only asks whether a key is declared
 * SOMEWHERE, and the read-site domain ratchet only asks whether the declaration
 * lives in the right registry. Neither compares the declared VALUE against the
 * runtime. This does.
 *
 * METHOD. Not a scan. `buildDefaultMentionResolver` is the production factory the
 * host composition root calls; `createCompositeMentionResolver` attaches each
 * resolve method ONLY when its dep survived the gate, so method presence on the
 * returned port is a direct, real observation of the gate's decision. Every port
 * the gate additionally requires is injected, so an absent method means the GATE
 * closed and nothing else.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MentionResolverPort } from "@/agent/mention-injection"
import { buildDefaultMentionResolver } from "@/agent/mention-runner"
import { KNOB_INVENTORY } from "@/config/knob-inventory"

/**
 * Created on FIRST USE, not at module load.
 *
 * `mkdtempSync` at module scope is a module-load external effect, and
 * `tests/unit/_arch/module-load-effect-guard.test.ts` refuses one with no
 * allowlist entry — it went red on `main` when this landed. The effect is also
 * paid by any run that only collects this file, or filters every test out of it.
 */
let cwdDir: string | undefined
const cwd = (): string => {
  cwdDir ??= mkdtempSync(join(tmpdir(), "mention-gate-parity-"))
  return cwdDir
}

/** Minimal stand-ins for the ports each gate additionally requires. A gate that
 *  is ON but whose port is missing also yields an absent method, which would
 *  read as "the gate is OFF" — so every port is supplied. */
const PORTS = {
  // A GETTER: `PORTS` is a module-scope const, so a plain `cwd: cwd()` would
  // still create the directory at module load, which is the thing being fixed.
  get cwd(): string {
    return cwd()
  },
  skills: { lookup: () => ({ name: "s", description: "d" }) },
  lsp: { lookup: async () => null },
  semantic: { lookup: async () => null },
  git: { status: async () => "", log: async () => "", diff: async () => "" },
  mcpListing: { listServers: () => [] },
  subagents: { resolve: () => null, list: () => [] },
  threadSummary: { list: async () => [] },
} as unknown as Parameters<typeof buildDefaultMentionResolver>[0]

/**
 * The closed set of `isOn`-gated mention knobs and the port method each one
 * controls. `resolveSkill` is always present on the composite — it is built from
 * `deps.skills`, which the gate nulls out — so `@skill` is observed by resolving.
 */
const GATES: readonly {
  readonly envKey: string
  readonly observe: (port: MentionResolverPort) => Promise<boolean>
}[] = [
  { envKey: "QUANTA_MENTION_FILE", observe: async (p) => "resolveFile" in p },
  { envKey: "QUANTA_MENTION_SYMBOL", observe: async (p) => "resolveSymbol" in p },
  { envKey: "QUANTA_MENTION_FOLDER", observe: async (p) => "resolveFolder" in p },
  { envKey: "QUANTA_MENTION_GIT", observe: async (p) => "resolveGit" in p },
  { envKey: "QUANTA_MENTION_MCP", observe: async (p) => "resolveMcp" in p },
  { envKey: "QUANTA_MENTION_SUBAGENT", observe: async (p) => "resolveSubagent" in p },
  { envKey: "QUANTA_MENTION_THREAD", observe: async (p) => "resolveThread" in p },
  { envKey: "QUANTA_MENTION_SKILL", observe: async (p) => (await p.resolveSkill("s")) !== null },
]

const declaredDefault = (envKey: string): boolean => {
  const row = KNOB_INVENTORY.find((k) => k.envKey === envKey)
  if (row === undefined) throw new Error(`${envKey} is not declared in KNOB_INVENTORY`)
  // A gate declared with a non-boolean default is itself the defect this guard
  // exists to catch, so fail loudly rather than coercing.
  if (typeof row.default !== "boolean") {
    throw new Error(
      `${envKey} is a gate but declares a non-boolean default: ${String(row.default)}`,
    )
  }
  return row.default
}

const build = (env: Record<string, string | undefined>): MentionResolverPort =>
  buildDefaultMentionResolver({ ...PORTS, env })

describe("mention-gate declared-default parity", () => {
  test("ANTI-VACUITY: every gate in the table is declared and observable", () => {
    expect(GATES.length).toBe(8)
    for (const g of GATES) expect(typeof declaredDefault(g.envKey)).toBe("boolean")
    // At least one gate must be observable as ON, or every `.toBe(false)` below
    // would be satisfiable by a resolver that builds nothing at all.
    expect(GATES.some((g) => declaredDefault(g.envKey))).toBe(true)
  })

  for (const g of GATES) {
    test(`${g.envKey}: unset behaves as declared`, async () => {
      const observedUnset = await g.observe(build({}))
      expect(
        observedUnset,
        `KNOB_INVENTORY declares ${g.envKey} default=${declaredDefault(g.envKey)}, ` +
          `but the real resolver with the knob UNSET produced ${String(observedUnset)}. ` +
          `The /knobs surface prints the declared value on both CLI and web.`,
      ).toBe(declaredDefault(g.envKey))
    })

    test(`${g.envKey}: the falsy vocabulary actually closes the gate`, async () => {
      for (const off of ["0", "off", "false", "no"]) {
        expect(await g.observe(build({ [g.envKey]: off })), `${g.envKey}=${off}`).toBe(false)
      }
      // parseEnvFlag treats an empty string and an unrecognized token as the
      // default — the mention gates are the default-ON family, so both are ON.
      for (const on of ["", "1", "on", "yes", "garbage"]) {
        expect(await g.observe(build({ [g.envKey]: on })), `${g.envKey}=${on}`).toBe(true)
      }
    })
  }

  /** PAIRED CONTROL: the gates must be independent, or one true observation
   *  could stand in for another and the table would prove less than it looks. */
  test("closing one gate leaves the others open", async () => {
    for (const g of GATES) {
      const port = build({ [g.envKey]: "off" })
      for (const other of GATES) {
        if (other.envKey === g.envKey) continue
        expect(await other.observe(port), `${g.envKey}=off should not close ${other.envKey}`).toBe(
          true,
        )
      }
    }
  })
})
