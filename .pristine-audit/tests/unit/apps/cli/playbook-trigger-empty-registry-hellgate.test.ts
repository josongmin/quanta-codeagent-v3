/**
 * UUX-1-24 HELLGATE — an opted-in playbook trigger must report empty or
 * unreadable disk registries instead of silently starting zero subscriptions.
 *
 * Contract pinned here:
 *   1. opt-in + valid root + empty registry ⇒ ONE warn operator notice that
 *      says triggers will not dispatch.
 *   2. opt-in + MISSING root ⇒ a warn notice too (the opt-in did nothing —
 *      previously only the noop logger heard about it).
 *   3. paired control — no opt-in ⇒ zero notices (default-OFF byte-identical).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExternalPromptQueue } from "../../../../src/apps/cli/repl/external-prompt-queue"
import { maybeStartPlaybookTriggerWire } from "../../../../src/apps/cli/repl/playbook-trigger-wire"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "../../../../src/shared"
import { createMemoryWatcher, type PlaybookPlanQueueSink } from "../../../../src/skill/playbook"

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
  test("DOF-14 disk markdown reaches the production external prompt queue", async () => {
    const playbookName = "refactor-sweep"
    const marker = "QUANTA-DISPATCH!"
    writeFileSync(
      join(root, "refactor-sweep.md"),
      [
        "---",
        `name: ${playbookName}`,
        "trigger:",
        `  comment-marker: ${marker}`,
        '  watch-glob: "**/*.ts"',
        "---",
        "Refactor the marked code.",
      ].join("\n"),
    )
    const queue = new ExternalPromptQueue()
    const sink: PlaybookPlanQueueSink = {
      enqueue: (input) => {
        queue.push(input.text)
        return { ok: true }
      },
    }
    const watcher = createMemoryWatcher(() => 1_000)
    const handle = maybeStartPlaybookTriggerWire({
      env: { QUANTA_PLAYBOOK_TRIGGER: "on" },
      threadId: "dof-14-real-queue",
      planQueueSink: sink,
      registryRoot: root,
      watcherFactory: () => watcher,
    })
    handles.push(handle)

    expect(watcher.active()).toBe(1)
    expect(watcher.fire("src/thing.ts", `// ${marker}\n`)).toBe(true)
    expect(queue.size()).toBe(1)
    expect(await queue.next(new AbortController().signal)).toBe(`/play ${playbookName}`)
  })

  test("opt-in + valid root ⇒ warn notice: no playbooks registered / will never dispatch", () => {
    startWire({ QUANTA_PLAYBOOK_TRIGGER: "on" }, root)
    const warns = seen.filter((n) => n.severity === "warn")
    expect(warns.length).toBe(1)
    const notice = warns[0] as OperatorNotice
    expect(notice.source).toBe("playbook-trigger")
    expect(notice.message).toContain("no playbooks registered")
    expect(`${notice.message} ${notice.hint ?? ""}`).toContain("top-level *.md playbooks")
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
