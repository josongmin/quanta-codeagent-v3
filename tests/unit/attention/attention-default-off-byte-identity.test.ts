/**
 * RFC-01 A1 — default-OFF byte-identity, INCLUDING the panel-ON / attention-OFF
 * cross-case (_review-01 §C2 / RFC trap T7).
 *
 * The subagent lifecycle emitter is present under the PANEL gate
 * (`QUANTA_WEB_SUBAGENTS`), NOT the attention gate — so "emitter absent ⇒ OFF"
 * is the WRONG guard. The real leak is: a park-site attention write that does
 * not check its OWN `QUANTA_ATTENTION_NAV` gate would leak in the panel-ON /
 * attention-OFF cross-case.
 *
 * A1 is the FOUNDATION packet — it adds the broker + a pure resolver and wires
 * NO producer. This test pins that foundation is clean:
 *   1. `TaskStatus` stays exactly 4-valued (no 5th value cascade), and
 *      `TaskRecord` gains no `awaitingInput` field (blueprint §10; R6 supersedes
 *      the older `TaskRecord.awaitingInput` design).
 *   2. Cross-case: with an emitter wired (panel ON) and no attention producer,
 *      the emitted subagent event stream carries ONLY the pre-existing
 *      `subagent_spawn` / `subagent_status` arms — zero attention bytes.
 *   3. The park-site loop + the registry do NOT import the new attention/
 *      question modules, so the leak PATH does not exist in A1.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type SubagentLifecycleEvent, TaskRegistry } from "@/subagent"
import { nth, present } from "../../_helpers/expect-present"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8")

describe("A1 foundation — no 5th TaskStatus value, no awaitingInput field", () => {
  const registrySrc = read("src/subagent/registry.ts")

  test("TaskStatus stays the exact 4-valued closed union", () => {
    const m = /export type TaskStatus =\s*("[^"]+"(?:\s*\|\s*"[^"]+")*)/.exec(registrySrc)
    expect(m).not.toBeNull()
    const union = nth(present(m, "TaskStatus union match"), 1, "TaskStatus union match")
    const values = present(union.match(/"([^"]+)"/g), "quoted TaskStatus values").map((s) =>
      s.replace(/"/g, ""),
    )
    expect(values.sort()).toEqual(["completed", "failed", "running", "stopped"])
  })

  test("TaskRecord gains no `awaitingInput` (or attention) field", () => {
    const recordBlock = nth(
      present(
        /export interface TaskRecord \{([\s\S]*?)\n\}/.exec(registrySrc),
        "TaskRecord interface block",
      ),
      1,
      "recordBlock",
    )
    expect(recordBlock.includes("awaitingInput")).toBe(false)
    expect(/\battention\b/i.test(recordBlock)).toBe(false)
  })
})

describe("A1 foundation — panel-ON / attention-OFF cross-case byte-identity", () => {
  test("with an emitter wired (panel ON) and no attention producer, only spawn/status arms emit", () => {
    // Panel ON is simulated by wiring the lifecycle emitter (its presence is what
    // `QUANTA_WEB_SUBAGENTS` composition decides). Attention is OFF: A1 wired no
    // producer, so no attention arm/field may appear on this stream.
    const events: SubagentLifecycleEvent[] = []
    const reg = new TaskRegistry()
    reg.setEmitter((e) => events.push(e))

    reg.register({ id: "task_1", description: "child A" })
    reg.complete("task_1", { ok: true, finalText: "done", turns: 1 })

    expect(events.length).toBeGreaterThan(0)
    for (const e of events) {
      // Closed 2-arm union — no attention arm leaked into the panel stream.
      expect(["subagent_spawn", "subagent_status"]).toContain(e.type)
      // No attention/awaiting field rides on any emitted event.
      expect("awaitingInput" in e).toBe(false)
      expect("pendingQuestion" in e).toBe(false)
    }
    // No TaskRecord carries an attention field either.
    for (const rec of reg.list()) {
      expect("awaitingInput" in rec).toBe(false)
    }
  })
})

describe("A1 foundation — leak path does not exist (source-absence heuristic)", () => {
  // HONEST SCOPE: this is a SOURCE-ABSENCE heuristic, not a byte-identity proof —
  // the byte-identity guarantee is carried by the BEHAVIORAL cross-case above
  // (the emitted stream + records carry zero attention bytes) and by the ADR-0024
  // slice-boundary tests. This check adds a cheap "the import edge isn't even
  // present" tripwire. It is import-FORM-agnostic: matching only `@/attention`
  // would let a relative `../attention` / barrel re-export evade it, so we match
  // any import specifier that resolves to the attention or user-question module.
  const importsModule = (src: string, seg: string): boolean =>
    // `from "...<seg>..."` or `import("...<seg>...")` in any path form (@/, relative, barrel).
    new RegExp(`(from|import)\\s*\\(?\\s*["'][^"']*\\b${seg}\\b[^"']*["']`).test(src)

  test("park-site loop + registry do not import the new attention/question modules (any import form)", () => {
    for (const rel of [
      "src/agent/loop/turn-outcome.ts",
      "src/agent/loop/turn-loop.ts",
      "src/subagent/registry.ts",
    ]) {
      const src = read(rel)
      expect(importsModule(src, "attention")).toBe(false)
      expect(importsModule(src, "user-question")).toBe(false)
    }
  })
})
