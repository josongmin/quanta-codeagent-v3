/**
 * UUX-1-24 HELLGATE — the playbook trigger wire ships an EMPTY registry
 * (`playbook-trigger-wire.ts` `EMPTY_REGISTRY: { list: () => [] }`), so an
 * operator who opts in (`QUANTA_PLAYBOOK_TRIGGER=on`) gets a live FS watcher
 * whose fires can NEVER dispatch — and nothing ever said so (the module's
 * default logger is a noop, and the session loop passes no logger).
 *
 * Fix pinned here (smaller honest fix per the jul-10 audit: make the
 * emptiness LOUD rather than building the never-designed loader — the
 * `/play` follow-up text the dispatcher would enqueue has no slash consumer
 * yet, so a loader would enqueue prompts referencing a nonexistent command):
 *   1. opt-in + valid root + empty registry ⇒ ONE warn operator notice that
 *      says triggers will not dispatch (registry loader not built).
 *   2. opt-in + MISSING root ⇒ a warn notice too (the opt-in did nothing —
 *      previously only the noop logger heard about it).
 *   3. paired control — no opt-in ⇒ zero notices (default-OFF byte-identical).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { maybeStartPlaybookTriggerWire } from "../../../../src/apps/cli/repl/playbook-trigger-wire"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "../../../../src/shared"

let root: string
let seen: OperatorNotice[]
let handles: Array<{ stop: () => void }>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "quanta-playbook-hellgate-"))
  seen = []
  handles = []
  installOperatorNoticeSink((n) => seen.push(n))
})

afterEach(() => {
  for (const h of handles) h.stop()
  __resetOperatorNoticeSinkForTest()
  rmSync(root, { recursive: true, force: true })
})

const startWire = (env: NodeJS.ProcessEnv, registryRoot: string): void => {
  handles.push(
    maybeStartPlaybookTriggerWire({
      env,
      threadId: "t1",
      planQueueSink: { enqueue: () => ({ ok: true }) },
      registryRoot,
    }),
  )
}

describe("UUX-1-24 — empty playbook registry is loud", () => {
  test("opt-in + valid root ⇒ warn notice: no playbooks registered / will never dispatch", () => {
    startWire({ QUANTA_PLAYBOOK_TRIGGER: "on" }, root)
    const warns = seen.filter((n) => n.severity === "warn")
    expect(warns.length).toBe(1)
    const notice = warns[0] as OperatorNotice
    expect(notice.source).toBe("playbook-trigger")
    expect(notice.message).toContain("no playbooks registered")
    expect(`${notice.message} ${notice.hint ?? ""}`).toContain(".quanta/playbooks")
  })

  test("opt-in + missing root ⇒ warn notice naming the missing directory", () => {
    const missing = join(root, "does-not-exist")
    startWire({ QUANTA_PLAYBOOK_TRIGGER: "on" }, missing)
    const warns = seen.filter((n) => n.severity === "warn")
    expect(warns.length).toBe(1)
    expect((warns[0] as OperatorNotice).message).toContain("does-not-exist")
  })

  test("paired control — no opt-in ⇒ zero notices (default-OFF byte-identical)", () => {
    startWire({}, root)
    expect(seen.length).toBe(0)
  })
})
