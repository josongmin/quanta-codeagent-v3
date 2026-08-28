/**
 * CROSS-SESSION INJECT REMOVED ratchet (ADR-0556).
 *
 * ADR-0282 shipped a session-start injector ("System B"): a JSONL mirror of the
 * Phase-1 stage1 rows (`JsonlFileStage1Store`, ADR-0207), a promotion gate in
 * the session-end hook (`shouldPromoteForInjection` / `lexicalOverlap`, ADR-0281,
 * tuned by `QUANTA_MEMORY_THRESHOLD` / `QUANTA_MEMORY_MIN_USAGE`), and
 * `DefaultCrossSessionInjector.selectForInject` rendering a
 * `## Cross-session memory (auto)` block into the cached `session_ctx` section.
 *
 * Measured truth (ADR-0556 §Context): the gate is Jaccard(candidate, UNION of
 * all siblings) whose ceiling shrinks as the corpus grows (0.03–0.15 observed
 * against a 0.7 threshold); `touch()` — the only `usageCount` raiser — has zero
 * production callers; the real store had 15 rows, 13 selected, 2 with usage ≥ 1,
 * **0 eligible**. Every default-ON session paid a second store write and
 * injected an EMPTY block. Phase-2's `memory_summary.md` ("System C") already
 * carries every fact B's raw summaries held, into the SAME section. ADR-0556
 * deletes B and keeps C.
 *
 * RULE (closed universe, count 0, NOT a burn-down):
 *   (a) no `.ts` file under `src/` contains any retired identifier / literal in
 *       {@link FORBIDDEN} — doc-comment mentions count (a stale name in a comment
 *       is how the next reader re-wires a dead seam);
 *   (b) `AgentConfig` and `ConsolidatorHookInput` have no `stage1OutputsStore`
 *       key — TYPE-level sentinels (`bun run typecheck:tests`);
 *   (c) session-end behaviour pin: one distilled session ⇒ exactly ONE durable
 *       store write (the sqlite `upsert`); a sibling store smuggled onto the hook
 *       input receives NOTHING;
 *   (d) paired control (byte-identity): with `memory_summary.md` present, the
 *       cached `session_ctx` section the live memory-auto wires produce is
 *       byte-identical to the pure-C build and carries no B header.
 */

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import type { AgentConfig } from "@/agent"
import {
  type ConsolidatorHookInput,
  runMemoryConsolidatorHook,
} from "@/agent/memory-consolidator-hook"
import { fourSectionPreset } from "@/agent/prompt-sections"
import type { Message } from "@/llm"
import { type Phase1Port, Stage1Store } from "@/memory"
import { buildSessionMemoryAutoWires } from "@/runner/session-memory-auto"
import { assertScanPopulation } from "../_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const SRC_ROOT = join(REPO_ROOT, "src")

/** Retired identifiers / literals. Every one is a plain substring match. */
const FORBIDDEN: readonly string[] = [
  "stage1OutputsStore",
  "JsonlFileStage1Store",
  "selectForInject",
  "DefaultCrossSessionInjector",
  "mirrorStage1ToOutputsStore",
  "shouldPromoteForInjection",
  "QUANTA_MEMORY_THRESHOLD",
  "QUANTA_MEMORY_MIN_USAGE",
]

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

/**
 * The ONE sanctioned survival of the `stage1OutputsStore` token: the SDK /
 * headless wire-summary contracts keep the key for shape stability, with the
 * value pinned to the constant `false` (ADR-0556 §Decision). Allowed ONLY as a
 * `boolean`-typed field or a `false` literal — a shape that cannot carry a
 * store — in exactly these files, at exactly this count. A fifth occurrence, a
 * typed slot (`stage1OutputsStore?: Stage1OutputsStore`), a spread, or a
 * `!== undefined` probe anywhere is a hit.
 */
const CONTRACT_FALSE_SHAPE = /^\s*(?:readonly )?stage1OutputsStore: (?:boolean|false),?\s*$/
const CONTRACT_FILES: ReadonlySet<string> = new Set([
  "src/sdk/runtime/context.ts",
  "src/apps/headless/types.ts",
  "src/apps/headless/index.ts",
])
const CONTRACT_OCCURRENCES = 4

const isSanctionedContractLine = (file: string, line: string): boolean =>
  CONTRACT_FILES.has(file) && CONTRACT_FALSE_SHAPE.test(line)

/** Classify ONE source line: every forbidden needle it contains is a hit,
 *  except the sanctioned contract shape, which is counted separately. */
const classifyLine = (
  file: string,
  lineNo: number,
  line: string,
  acc: { hits: Hit[]; sanctioned: number },
): void => {
  for (const needle of FORBIDDEN) {
    if (!line.includes(needle)) continue
    if (needle === "stage1OutputsStore" && isSanctionedContractLine(file, line)) {
      acc.sanctioned += 1
      continue
    }
    acc.hits.push({ file, line: lineNo, needle })
  }
}

/** Pure detector — reused by the red-on-injection self-test below. Returns the
 *  hits AND the count of sanctioned contract lines so the caller can pin it. */
const scanSources = (
  sources: ReadonlyArray<{ file: string; text: string }>,
): { hits: Hit[]; sanctioned: number } => {
  const acc = { hits: [] as Hit[], sanctioned: 0 }
  for (const { file, text } of sources) {
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) classifyLine(file, i + 1, lines[i] ?? "", acc)
  }
  return acc
}

const loadSrc = () =>
  walkTs(SRC_ROOT).map((abs) => ({
    file: relative(REPO_ROOT, abs),
    text: readFileSync(abs, "utf8"),
  }))

const format = (hits: readonly Hit[]): string =>
  hits.map((h) => `  ${h.file}:${h.line}  [${h.needle}]`).join("\n")

// ─── (c) session-end pin harness ─────────────────────────────────────────

const rollout = (turns: number): Message[] => {
  const out: Message[] = []
  for (let i = 0; i < turns; i++) {
    out.push({ role: "user", content: [{ type: "text", text: `q${i}` }] })
    out.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }] })
  }
  return out
}

const fakePhase1Port = (): Phase1Port => ({
  async distill() {
    return {
      rolloutSummary: "one durable summary",
      rawMemory: "- decision: one write per session end",
      preferenceSignals: [],
    }
  },
})

/** Every write-capable method a sibling usage/selection store used to expose.
 *  Each one counts; the pin is that NONE fires. */
const siblingStoreProbe = () => {
  const writes: string[] = []
  const probe = {
    get: () => null,
    list: () => Object.freeze([]),
    prune: () => 0,
    put: () => {
      writes.push("put")
    },
    touch: () => {
      writes.push("touch")
    },
    markSelectedForPhase2: () => {
      writes.push("mark")
    },
  }
  return { probe, writes }
}

// ─── (d) paired-control harness ──────────────────────────────────────────

/** Phase-2 aggregate (System C) — the ONLY thing that may reach `session_ctx`. */
const MEMORY_SUMMARY_MD =
  "- The team pins bun and runs rg before grep.\n" +
  "- Bench boxes are always SPOT; stop them when idle.\n" +
  "- Memory writes go through the atomic writer, never raw fs.\n"

/** The exact two row classes the real `stage1.jsonl` mirror held (ADR-0556
 *  §Context: 13 selected, 2 with usage ≥ 1, 0 in the intersection). Seeded so
 *  the control is a REAL paired run over B's production-shaped input, not an
 *  empty-store vacuity: before the deletion B selected nothing from these rows;
 *  after the deletion nothing reads them. Either way `session_ctx` must be
 *  byte-identical to the pure-C build. */
const PRODUCTION_SHAPED_JSONL = [
  {
    op: "put",
    entry: {
      threadId: "prior-selected-unused",
      sourceUpdatedAt: 1,
      rawMemory: "- raw",
      rolloutSummary: "B-ONLY-MARKER selected but never touched",
      generatedAt: 1,
      rolloutSlug: "slug-a",
      usageCount: 0,
      lastUsage: 1,
      selectedForPhase2: true,
      selectedForPhase2SourceUpdatedAt: 1,
    },
  },
  {
    op: "put",
    entry: {
      threadId: "prior-used-unselected",
      sourceUpdatedAt: 2,
      rawMemory: "- raw",
      rolloutSummary: "B-ONLY-MARKER used but not selected",
      generatedAt: 2,
      rolloutSlug: "slug-b",
      usageCount: 1,
      lastUsage: 2,
      selectedForPhase2: false,
    },
  },
]
  .map((row) => JSON.stringify(row))
  .join("\n")

const B_HEADER = "## Cross-session memory (auto)"

describe("cross-session inject removed ratchet (ADR-0556)", () => {
  test("ANTI-VACUITY: the src walk reaches a real, populated tree", () => {
    // The ratchet asserts a token was REMOVED. A walk that lost a subtree finds
    // no occurrences there and reports exactly the removal it wants to see.
    assertScanPopulation(walkTs(SRC_ROOT), SRC_ROOT, {
      min: 500,
      skipDirs: ["__snapshots__"],
      collectable: (n) => n.endsWith(".ts") || n.endsWith(".tsx"),
    })
  })

  test("(a) no src/ file references the retired injector / mirror / gate / knobs (0 hits; 4 constant-false contract keys)", () => {
    const { hits, sanctioned } = scanSources(loadSrc())
    if (hits.length > 0) {
      throw new Error(
        `${hits.length} reference(s) to the deleted cross-session inject slice under src/ — ` +
          `ADR-0556 deleted it (System B was dead in effect; memory_summary.md already ` +
          `carries the facts); do not re-add:\n${format(hits)}`,
      )
    }
    expect(hits).toHaveLength(0)
    // The wire-summary contract keys are pinned by COUNT: a new `: boolean` /
    // `: false` field elsewhere is a hit (file allowlist), a fifth one here
    // moves this number.
    expect(sanctioned).toBe(CONTRACT_OCCURRENCES)
  })

  test("(b) AgentConfig + ConsolidatorHookInput have no `stage1OutputsStore` key (type-level sentinels)", () => {
    // Under `typecheck:tests` these lines fail to compile if either key returns.
    type ConfigSlotAbsent = "stage1OutputsStore" extends keyof AgentConfig ? never : true
    type HookSlotAbsent = "stage1OutputsStore" extends keyof ConsolidatorHookInput ? never : true
    const configAbsent: ConfigSlotAbsent = true
    const hookAbsent: HookSlotAbsent = true
    expect(configAbsent).toBe(true)
    expect(hookAbsent).toBe(true)
  })

  test("(c) session end ⇒ exactly ONE durable store write (sqlite upsert); a smuggled sibling store gets nothing", async () => {
    const db = new Database(":memory:")
    const store = new Stage1Store(db)
    let upserts = 0
    const originalUpsert = store.upsert.bind(store)
    store.upsert = (out) => {
      upserts += 1
      return originalUpsert(out)
    }
    const { probe, writes } = siblingStoreProbe()
    // The sibling slot no longer exists on the input type; it is smuggled in
    // through a cast so the pin also proves there is no hidden mirror path
    // that would pick up a stray `stage1OutputsStore` key at runtime.
    const input = {
      sessionOk: true,
      consolidator: { enabled: true, port: fakePhase1Port(), store },
      sessionId: "s-one-write",
      rolloutMessages: rollout(5),
      turnCount: 5,
      stage1OutputsStore: probe,
    } as unknown as ConsolidatorHookInput
    try {
      const out = await runMemoryConsolidatorHook(input)
      expect(out.kind).toBe("distilled")
      const rows = db.query("SELECT thread_id FROM stage1_outputs").all() as { thread_id: string }[]
      expect(rows.map((r) => r.thread_id)).toEqual(["s-one-write"])
      expect(writes).toEqual([])
      expect(upserts + writes.length).toBe(1)
    } finally {
      db.close()
    }
  })

  test("(d) PAIRED CONTROL: live memory-auto wires ⇒ `session_ctx` byte-identical to the pure memory_summary.md build; no B header", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "q-cross-session-removed-"))
    try {
      const memoryRoot = join(tempHome, ".quanta", "memory")
      mkdirSync(memoryRoot, { recursive: true })
      await writeFile(join(memoryRoot, "memory_summary.md"), MEMORY_SUMMARY_MD, "utf8")
      await writeFile(join(memoryRoot, "stage1.jsonl"), `${PRODUCTION_SHAPED_JSONL}\n`, "utf8")

      const llm = { stream: async function* () {} } as never
      const wires = await buildSessionMemoryAutoWires({
        env: {},
        llm,
        sessionId: "paired-control",
        homeDir: tempHome,
      })
      if (wires === undefined) throw new Error("expected default-ON memory wires")
      try {
        // A B-style session-start block would have surfaced here. The probe is
        // deliberately untyped: the slot is gone from the wire type, and any
        // future re-introduction under the same name must trip this pin.
        const bBlock = (wires as { readonly sessionCtx?: string }).sessionCtx
        expect(bBlock).toBeUndefined()
        expect(wires.memorySummaryMd).toBe(MEMORY_SUMMARY_MD)

        const live = fourSectionPreset({
          base: "BASE",
          ...(wires.memorySummaryMd !== undefined
            ? { memorySummaryMd: wires.memorySummaryMd }
            : {}),
          ...(bBlock !== undefined ? { sessionCtx: bBlock } : {}),
        })
        const pureC = fourSectionPreset({ base: "BASE", memorySummaryMd: MEMORY_SUMMARY_MD })
        expect(live).toEqual(pureC)

        const sessionCtx = live.find((s) => s.name === "session_ctx")
        if (sessionCtx === undefined) throw new Error("session_ctx section must exist (C present)")
        expect(sessionCtx.text.includes(B_HEADER)).toBe(false)
        expect(sessionCtx.text.includes("B-ONLY-MARKER")).toBe(false)
        expect(sessionCtx.text.includes("runs rg before grep")).toBe(true)
        expect(
          Buffer.from(sessionCtx.text, "utf8").equals(
            Buffer.from(pureC.find((s) => s.name === "session_ctx")?.text ?? "", "utf8"),
          ),
        ).toBe(true)
      } finally {
        await wires.drain()
        wires.dispose()
      }
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  test("DETECTOR has teeth (red-on-injection): each retired needle is flagged; the contract shape is narrow", () => {
    for (const needle of FORBIDDEN) {
      const { hits } = scanSources([{ file: "x.ts", text: `// mentions ${needle} here\n` }])
      expect(hits.map((h) => h.needle)).toEqual([needle])
    }
    expect(
      scanSources([{ file: "w.ts", text: "// unrelated memory summary text\n" }]).hits,
    ).toHaveLength(0)
    // Sanctioned: constant-false contract field, in an allowlisted file.
    const ok = scanSources([
      {
        file: "src/apps/headless/index.ts",
        text: "  memoryAuto: {\n    stage1OutputsStore: false,\n",
      },
      { file: "src/sdk/runtime/context.ts", text: "    readonly stage1OutputsStore: boolean\n" },
    ])
    expect(ok.hits).toHaveLength(0)
    expect(ok.sanctioned).toBe(2)
    // NOT sanctioned: same shape outside the allowlist; a typed slot, a spread,
    // a truthy literal, or a `!== undefined` probe inside it.
    const bad = scanSources([
      { file: "src/agent/types.ts", text: "  stage1OutputsStore: false,\n" },
      { file: "src/sdk/runtime/context.ts", text: "  stage1OutputsStore?: Stage1OutputsStore\n" },
      {
        file: "src/apps/headless/index.ts",
        text: "  ...(cfg.stage1OutputsStore !== undefined ? {} : {}),\n",
      },
      { file: "src/apps/headless/types.ts", text: "    stage1OutputsStore: true,\n" },
      {
        file: "src/sdk/runtime/context.ts",
        text: "    stage1OutputsStore: snapshot.stage1OutputsStore !== undefined,\n",
      },
    ])
    expect(bad.hits).toHaveLength(5)
    expect(bad.sanctioned).toBe(0)
  })
})
