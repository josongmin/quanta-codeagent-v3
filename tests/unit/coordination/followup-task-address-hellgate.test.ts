/**
 * BUG#4 (jun-07) — `followup_task` must deliver to the child's MAILBOX label,
 * not its registry TASK id.
 *
 * The two id namespaces are disjoint: a child is tracked in the `TaskRegistry`
 * (and the wake registry) under `task_<uuid>`, but reads its inbox under its
 * mailbox label (`root/N`). `followup_task` receives the TASK id; if it sends the
 * mailbox message addressed to that task id the child never sees it (it drains
 * `root/N`), yet the tool reported `delivered:true` — a false success.
 *
 * The fix records the task-id → mailbox-label binding on the `TurnWakeRegistry`
 * at child spawn, and the introspect wire resolves the delivery address through
 * it. These cases pin both the binding and the end-to-end address translation.
 */

import { describe, expect, test } from "bun:test"
import { createSubagentMailbox } from "@/agent/subagent-mailbox"
import { handleFollowupTask, TaskRegistry, TurnWakeRegistry } from "@/subagent"

describe("TurnWakeRegistry — mailbox-label binding (BUG#4)", () => {
  test("binds a label on register and exposes it via labelOf", () => {
    const wake = new TurnWakeRegistry()
    wake.register("task_1", () => "woke", "root/0")
    expect(wake.labelOf("task_1")).toBe("root/0")
  })

  test("disposer clears the label (no leak)", () => {
    const wake = new TurnWakeRegistry()
    const dispose = wake.register("task_1", () => "woke", "root/0")
    dispose()
    expect(wake.labelOf("task_1")).toBeUndefined()
  })

  test("a stale disposer does NOT clobber a re-registered label (identity guard)", () => {
    const wake = new TurnWakeRegistry()
    const dispose1 = wake.register("task_1", () => "woke", "root/0")
    wake.register("task_1", () => "woke", "root/1") // last-writer-wins re-home
    dispose1() // the OLD disposer must not delete the NEW binding
    expect(wake.labelOf("task_1")).toBe("root/1")
  })

  test("register without a label leaves labelOf undefined (back-compat)", () => {
    const wake = new TurnWakeRegistry()
    wake.register("task_1", () => "woke")
    expect(wake.labelOf("task_1")).toBeUndefined()
  })
})

describe("handleFollowupTask — delivers to the resolved mailbox label (BUG#4)", () => {
  const setup = () => {
    const registry = new TaskRegistry()
    const taskId = registry.newId()
    registry.register({ id: taskId, description: "child" })
    const mailbox = createSubagentMailbox()
    const wake = new TurnWakeRegistry()
    const childLabel = "root/0"
    // The child wired its waker under the TASK id, binding its MAILBOX label.
    wake.register(taskId, () => "woke", childLabel)
    return { registry, mailbox, wake, taskId, childLabel }
  }

  test("with resolveLabel wired, the message lands in the child's REAL inbox", () => {
    const { registry, mailbox, wake, taskId, childLabel } = setup()
    const out = handleFollowupTask(
      { agentId: taskId, message: "do X" },
      {
        registry,
        mailbox,
        wake,
        callerLabel: "root",
        resolveLabel: (id) => wake.labelOf(id),
      },
    )
    expect(out.kind).toBe("success")
    // The child, draining its mailbox label, sees the message.
    expect(mailbox.read(childLabel).map((m) => m.body)).toEqual(["do X"])
    // And nothing sits at the phantom task-id address.
    expect(mailbox.read(taskId).map((m) => m.body)).toEqual([])
  })

  test("REGRESSION GUARD — without resolveLabel the message misses the inbox (the bug)", () => {
    const { registry, mailbox, wake, taskId, childLabel } = setup()
    handleFollowupTask(
      { agentId: taskId, message: "do X" },
      { registry, mailbox, wake, callerLabel: "root" }, // no resolveLabel ⇒ old broken path
    )
    // The message went to the task-id phantom address; the child's inbox is empty.
    expect(mailbox.read(childLabel).map((m) => m.body)).toEqual([])
    expect(mailbox.read(taskId).map((m) => m.body)).toEqual(["do X"])
  })
})
