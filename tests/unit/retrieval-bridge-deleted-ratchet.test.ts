/**
 * RETRIEVAL-BRIDGE DELETED ratchet (ADR-0553).
 *
 * The ADR-0159 "composition-root wire" shipped a memory ↔ retrieval bridge
 * (`rankWithRetrievalStack`), a localize bridge (`runLocalizeHybrid`, already
 * deleted jul-3 D2), an `AgentConfig.retrievalStack` slot, and the
 * `QUANTA_RETRIEVAL_HYBRID` env gate that built the stack at the host root.
 * Measured truth: the slot was WRITTEN (`buildRetrievalStackFromEnv`) and never
 * READ; the bridge had zero non-test callers; and even if wired it could not
 * change a recall result (memory's `rankEntries` clips BEFORE the rerank stage,
 * and the stock stack's default reranker is `identity`). ADR-0553 deletes the
 * bridge + slot + gate rather than wiring them.
 *
 * RULE (closed universe, count 0, NOT a burn-down):
 *   (a) no `.ts` file under `src/` (tests under `src/**` included) contains any
 *       of the retired identifiers / literals listed in {@link FORBIDDEN};
 *   (b) no `.ts` file under `src/` declares a `retrievalStack` property / object
 *       key (the slot), matched as `retrievalStack?:` / `retrievalStack:`;
 *   (c) `AgentConfig` has no `retrievalStack` key — enforced at the TYPE level
 *       (`bun run typecheck:tests`) via a `never` sentinel below.
 *
 * Doc-comment mentions count too: the jul-3 D2 deletion left `runLocalizeHybrid`
 * alive in a catalog YAML for weeks — a stale name in a comment is exactly how
 * the next reader re-wires a dead seam. The universe is `src/**` only: ADRs and
 * plans legitimately keep the history.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import type { AgentConfig } from "@/agent"
import { assertScanPopulation } from "./_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const SRC_ROOT = join(REPO_ROOT, "src")

/** Retired identifiers / literals. Every one is a plain substring match. */
const FORBIDDEN: readonly string[] = [
  "rankWithRetrievalStack",
  "runLocalizeHybrid",
  "retrieval-localize-bridge",
  "retrieval-memory-bridge",
  "buildRetrievalStackFromEnv",
  "QUANTA_RETRIEVAL_HYBRID",
]

/** The slot declaration / object-key shape (`retrievalStack?:` or `retrievalStack:`). */
const SLOT_KEY_RE = /\bretrievalStack\??\s*:/

interface Hit {
  readonly file: string
  readonly line: number
  readonly needle: string
}

const walkTs = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__snapshots__") continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walkTs(abs, out)
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(abs)
  }
  return out
}

/** Pure detector — reused by the red-on-injection self-test below. */
const scanSources = (sources: ReadonlyArray<{ file: string; text: string }>): Hit[] => {
  const hits: Hit[] = []
  for (const { file, text } of sources) {
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      for (const needle of FORBIDDEN) {
        if (line.includes(needle)) hits.push({ file, line: i + 1, needle })
      }
      if (SLOT_KEY_RE.test(line))
        hits.push({ file, line: i + 1, needle: "retrievalStack slot key" })
    }
  }
  return hits
}

const loadSrc = () =>
  walkTs(SRC_ROOT).map((abs) => ({
    file: relative(REPO_ROOT, abs),
    text: readFileSync(abs, "utf8"),
  }))

const format = (hits: readonly Hit[]): string =>
  hits.map((h) => `  ${h.file}:${h.line}  [${h.needle}]`).join("\n")

describe("retrieval bridge deleted ratchet (ADR-0553)", () => {
  test("ANTI-VACUITY: the src walk reaches a real, populated tree", () => {
    // The ratchet asserts a bridge is GONE. A walk that lost a subtree finds no
    // survivor there and reports exactly the deletion it wants to see.
    assertScanPopulation(walkTs(SRC_ROOT), SRC_ROOT, {
      id: "tests/unit/retrieval-bridge-deleted-ratchet.test.ts#SRC-ROOT",
      skipDirs: ["__snapshots__"],
      collectable: (n) => n.endsWith(".ts") || n.endsWith(".tsx"),
    })
  })

  test("(a)+(b) no src/ file references the retired bridge / gate / slot (0 hits)", () => {
    const hits = scanSources(loadSrc())
    if (hits.length > 0) {
      throw new Error(
        `${hits.length} reference(s) to the deleted retrieval bridge / slot / gate under src/ — ` +
          `ADR-0553 deleted them; do not re-add (see the ADR for what a real ` +
          `BM25-over-memory would need instead):\n${format(hits)}`,
      )
    }
    expect(hits).toHaveLength(0)
  })

  test("(c) AgentConfig has no `retrievalStack` key (type-level sentinel)", () => {
    // Under `typecheck:tests` this line fails to compile if the key returns:
    // `"retrievalStack" extends keyof AgentConfig` ⇒ the sentinel type is `never`
    // and `true` is not assignable to it.
    type SlotAbsent = "retrievalStack" extends keyof AgentConfig ? never : true
    const absent: SlotAbsent = true
    expect(absent).toBe(true)
  })

  test("DETECTOR has teeth (red-on-injection): each retired needle and the slot key are flagged", () => {
    for (const needle of FORBIDDEN) {
      const hits = scanSources([{ file: "x.ts", text: `// mentions ${needle} here\n` }])
      expect(hits.map((h) => h.needle)).toEqual([needle])
    }
    const slot = scanSources([
      { file: "y.ts", text: "interface A {\n  retrievalStack?: { registry: unknown }\n}\n" },
      { file: "z.ts", text: "const cfg = {\n  retrievalStack: stack,\n}\n" },
    ])
    expect(slot).toHaveLength(2)
    expect(slot[0]?.line).toBe(2)
    // A bare prose mention of the word (no key shape) is NOT the slot.
    expect(scanSources([{ file: "w.ts", text: "// the old retrievalStack idea\n" }])).toHaveLength(
      0,
    )
  })
})
