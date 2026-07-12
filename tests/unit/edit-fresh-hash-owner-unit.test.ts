/** jul-13 OWNER pure-unit — edit-fresh-hash CONTRACT surface, finer grain than
 *  the behavior hellgate + the dispatch wire hellgate (which this deliberately
 *  does NOT duplicate).
 *
 *  The two sibling hellgates prove (a) the TOOL LOGIC end-to-end (behavior) and
 *  (b) the DISPATCH SEAM threads the flag (wire). This suite pins the remaining
 *  contract seams at leaf-unit grain, home-bonus ZERO:
 *
 *    1. GATE STRICTNESS — a mutation TABLE over the REAL runtimeConfig().editFreshHash
 *       proving it is TRUE for exactly "1" and FALSE for every loose-truthy /
 *       whitespace / numeric neighbour. Catches a `=== "1"` → truthy loosening in
 *       gateOnStrict that the wire hellgate's 5-value probe could miss.
 *    2. KNOB CATALOG PARITY — QUANTA_EDIT_FRESH_HASH is DISCOVERABLE in
 *       RUNTIME_CONFIG_KNOBS with kind:"bool"/default:false (guards a wired-but-
 *       undiscoverable knob).
 *    3. OUTPUT CONTRACT EXACTNESS — FULL-STRING equality of the ON success output:
 *       legacy line + "\nfresh sha256: <64-hex> (pass as expected_hash …)". A
 *       wording/format drift is RED (not merely a .toContain miss).
 *    4. OFF BYTE-IDENTITY ACROSS OUTCOMES — OFF success is EXACTLY the legacy line
 *       (no newline/hash); and the not_found + stale_precondition FAILURE outputs
 *       are byte-identical in BOTH flag states (the flag touches ONLY the success
 *       path — a failed edit with the flag ON never appends a fresh hash).
 *    5. NO "sha256" LEAK WHEN OFF — zero "sha256" substring on OFF success AND
 *       OFF failure paths.
 *
 *  Non-vacuity is by DESIGN: full-string equality + the gate mutation table are
 *  inherently non-vacuous (a wrong constant / loosened gate flips them RED). */

import { afterEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"
import { RUNTIME_CONFIG_KNOBS } from "@/shared/runtime-config-knobs"
import type { FileInfo, FileSystemPort } from "@/storage"
import { sha256Hex } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"

const KNOB = "QUANTA_EDIT_FRESH_HASH"

// ─── test-double port (mirrors the behavior hellgate's makeFullPort convention) ───
const makeFullPort = (seed: Record<string, string>) => {
  const files = new Map<string, string>(Object.entries(seed))
  const port: FileSystemPort = {
    async readFile(path: string): Promise<string> {
      const v = files.get(path)
      if (v === undefined) throw new Error(`File not found: ${path}`)
      return v
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content)
    },
    async statFile(path: string): Promise<FileInfo> {
      return {
        path,
        size: files.get(path)?.length ?? 0,
        isDirectory: false,
        mtimeMs: 0,
        isFIFO: false,
        isCharacterDevice: false,
        isBlockDevice: false,
      }
    },
    async fileExists(path: string): Promise<boolean> {
      return files.has(path)
    },
    async writeFileAtomic(path: string, content: string): Promise<void> {
      files.set(path, content)
    },
  }
  return { port, files }
}

const ctx = (cwd: string, freshHash: boolean): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  ...(freshHash ? { editFreshHash: true } : {}),
})

const run = async (
  tool: ReturnType<typeof makeEditTool>,
  input: unknown,
  cwd: string,
  freshHash: boolean,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx(cwd, freshHash))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GATE STRICTNESS — mutation table over the REAL runtimeConfig().
// ─────────────────────────────────────────────────────────────────────────────
describe("edit-fresh-hash · GATE STRICTNESS (runtimeConfig mutation table)", () => {
  // Snapshot → mutate env → reset cached config → read → restore. The gate is
  // `gateOnStrict(env,"QUANTA_EDIT_FRESH_HASH")` === `env[...] === "1"`.
  const gateFor = (value: string | undefined): boolean => {
    const prev = process.env[KNOB]
    if (value === undefined) delete process.env[KNOB]
    else process.env[KNOB] = value
    __resetRuntimeConfig()
    try {
      return runtimeConfig().editFreshHash
    } finally {
      if (prev === undefined) delete process.env[KNOB]
      else process.env[KNOB] = prev
      __resetRuntimeConfig()
    }
  }

  afterEach(() => {
    __resetRuntimeConfig()
  })

  test("exactly \"1\" ⇒ TRUE (the sole enabling literal)", () => {
    expect(gateFor("1")).toBe(true)
  })

  // Every neighbour a truthy-loosening regression would flip ON. `undefined`
  // stands in for the UNSET env var. If gateOnStrict ever becomes truthy-based,
  // "on"/"true"/"yes"/"2"/"01"/" 1" would flip TRUE and this table goes RED.
  const OFF_CASES: ReadonlyArray<readonly [label: string, value: string | undefined]> = [
    ["unset", undefined],
    ["empty", ""],
    ["zero", "0"],
    ["on", "on"],
    ["true", "true"],
    ["TRUE", "TRUE"],
    ["yes", "yes"],
    ["leading-space \" 1\"", " 1"],
    ["trailing-space \"1 \"", "1 "],
    ["zero-padded \"01\"", "01"],
    ["two", "2"],
  ]

  for (const [label, value] of OFF_CASES) {
    test(`${label} ⇒ FALSE (strict \`=== "1"\`, not truthy)`, () => {
      expect(gateFor(value)).toBe(false)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. KNOB CATALOG PARITY — the knob is DISCOVERABLE with the right shape.
// ─────────────────────────────────────────────────────────────────────────────
describe("edit-fresh-hash · KNOB CATALOG PARITY", () => {
  test("QUANTA_EDIT_FRESH_HASH is registered in RUNTIME_CONFIG_KNOBS", () => {
    const entry = RUNTIME_CONFIG_KNOBS.find((k) => k.envKey === KNOB)
    // Wired-but-undiscoverable guard: a runtime gate with no catalog row is
    // invisible to --help / knob-registry tooling.
    expect(entry).toBeDefined()
  })

  test("catalog row has kind:\"bool\" and default:false (default-OFF opt-in)", () => {
    const entry = RUNTIME_CONFIG_KNOBS.find((k) => k.envKey === KNOB)
    expect(entry?.kind).toBe("bool")
    expect(entry?.default).toBe(false)
  })

  test("exactly ONE catalog row for the knob (no duplicate registration)", () => {
    const rows = RUNTIME_CONFIG_KNOBS.filter((k) => k.envKey === KNOB)
    expect(rows).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. OUTPUT CONTRACT EXACTNESS — full-string equality of the ON success output.
// ─────────────────────────────────────────────────────────────────────────────
describe("edit-fresh-hash · OUTPUT CONTRACT EXACTNESS (ON success)", () => {
  test("ON success output is EXACTLY legacy-line + \"\\nfresh sha256: <hex> (pass …)\"", async () => {
    const path = "/in-mem/exact.txt"
    const after = "const a = 2"
    const { port } = makeFullPort({ [path]: "const a = 1" })
    const r = await run(makeEditTool(port), { path, old_string: "1", new_string: "2" }, "/in-mem", true)
    expect(r.ok).toBe(true)

    // The digest is over the POST-edit bytes (`planned.next`). Pin the WHOLE
    // string so any wording/format/ordering drift is RED — not merely a
    // substring probe. `Replaced 1 occurrence(s)` is the legacy exact-edit line.
    const expected =
      `${path}: Replaced 1 occurrence(s)` +
      `\nfresh sha256: ${sha256Hex(after)}` +
      " (pass as expected_hash for the next edit to this file — no re-read needed)"
    expect(r.output).toBe(expected)
  })

  test("the advertised hex is a 64-char lowercase sha256 digest", async () => {
    const path = "/in-mem/hex.txt"
    const { port } = makeFullPort({ [path]: "x = 1" })
    const r = await run(makeEditTool(port), { path, old_string: "1", new_string: "9" }, "/in-mem", true)
    expect(r.ok).toBe(true)
    const m = r.output?.match(/fresh sha256: ([0-9a-f]{64}) \(/)
    expect(m).not.toBeNull()
    expect(m?.[1]).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. OFF BYTE-IDENTITY ACROSS OUTCOMES + the flag touches ONLY the success path.
// ─────────────────────────────────────────────────────────────────────────────
describe("edit-fresh-hash · OFF BYTE-IDENTITY & failure-path invariance", () => {
  test("OFF success output is EXACTLY the legacy line (no trailing newline, no hash)", async () => {
    const path = "/in-mem/off-success.txt"
    const { port } = makeFullPort({ [path]: "const a = 1" })
    const r = await run(makeEditTool(port), { path, old_string: "1", new_string: "2" }, "/in-mem", false)
    expect(r.ok).toBe(true)
    // Removing the `ctx.editFreshHash` gate (always-append) flips this RED.
    expect(r.output).toBe(`${path}: Replaced 1 occurrence(s)`)
  })

  test("not_found failure output is BYTE-IDENTICAL in both flag states", async () => {
    const input = { path: "/in-mem/nf.txt", old_string: "ABSENT_NEEDLE", new_string: "z" }
    const seed = { "/in-mem/nf.txt": "const a = 1" }
    const off = await run(makeEditTool(makeFullPort(seed).port), input, "/in-mem", false)
    const on = await run(makeEditTool(makeFullPort(seed).port), input, "/in-mem", true)
    expect(off.ok).toBe(false)
    expect(on.ok).toBe(false)
    expect(off.failure?.mode).toBe("not_found")
    expect(on.failure?.mode).toBe("not_found")
    // The success-only flag must NOT perturb a failed edit's rendered output.
    expect(on.output).toBe(off.output)
    // …and a failed edit with the flag ON must never advertise a fresh hash.
    expect(on.output).not.toContain("fresh sha256")
  })

  test("stale_precondition failure output is BYTE-IDENTICAL in both flag states", async () => {
    // Supply a wrong expected_hash so the precondition gate rejects before commit.
    const input = {
      path: "/in-mem/stale.txt",
      old_string: "1",
      new_string: "2",
      expected_hash: sha256Hex("SOME OTHER CONTENT"),
    }
    const seed = { "/in-mem/stale.txt": "const a = 1" }
    const off = await run(makeEditTool(makeFullPort(seed).port), input, "/in-mem", false)
    const on = await run(makeEditTool(makeFullPort(seed).port), input, "/in-mem", true)
    expect(off.failure?.mode).toBe("stale_precondition")
    expect(on.failure?.mode).toBe("stale_precondition")
    expect(on.output).toBe(off.output)
    expect(on.output).not.toContain("fresh sha256")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. NO "sha256" LEAK WHEN OFF — success AND failure paths.
// ─────────────────────────────────────────────────────────────────────────────
describe("edit-fresh-hash · NO sha256 leak when OFF", () => {
  test("OFF success output contains zero \"sha256\" substring", async () => {
    const path = "/in-mem/off-nolek.txt"
    const { port } = makeFullPort({ [path]: "let v = 1" })
    const r = await run(makeEditTool(port), { path, old_string: "1", new_string: "2" }, "/in-mem", false)
    expect(r.ok).toBe(true)
    expect(r.output).not.toContain("sha256")
  })

  test("OFF not_found output contains zero \"sha256\" substring", async () => {
    const path = "/in-mem/off-nf-nolek.txt"
    const { port } = makeFullPort({ [path]: "let v = 1" })
    const r = await run(makeEditTool(port), { path, old_string: "NOPE", new_string: "2" }, "/in-mem", false)
    expect(r.ok).toBe(false)
    expect(r.output).not.toContain("sha256")
  })
})
