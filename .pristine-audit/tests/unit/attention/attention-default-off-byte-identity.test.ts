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

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8")

describe("A1 foundation — no 5th TaskStatus value, no awaitingInput field", () => {
  const registrySrc = read("src/subagent/registry.ts")

  test("TaskStatus stays the exact 4-valued closed union", () => {
    const m = /export type TaskStatus =\s*("[^"]+"(?:\s*\|\s*"[^"]+")*)/.exec(registrySrc)
    expect(m).not.toBeNull()
    const values = m![1]!.match(/"([^"]+)"/g)!.map((s) => s.replace(/"/g, ""))
    expect(values.sort()).toEqual(["completed", "failed", "running", "stopped"])
  })

  test("TaskRecord gains no `awaitingInput` (or attention) field", () => {
    const recordBlock = /export interface TaskRecord \{([\s\S]*?)\n\}/.exec(registrySrc)![1]!
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

describe("A1 foundation — leak path does not exist", () => {
  test("park-site loop + registry do not import the new attention/question modules", () => {
    for (const rel of [
      "src/agent/loop/turn-outcome.ts",
      "src/agent/loop/turn-loop.ts",
      "src/subagent/registry.ts",
    ]) {
      const src = read(rel)
      expect(src.includes("@/attention")).toBe(false)
      expect(src.includes("@/session/user-question")).toBe(false)
    }
  })
})
