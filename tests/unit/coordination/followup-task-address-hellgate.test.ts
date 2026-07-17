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
import {
  createSubagentDeliveryController,
  createTargetResolver,
  type DeliveryMailboxPort,
  type SubagentControlRegistry,
} from "@/agent/subagent-delivery"
import { createSubagentMailbox } from "@/agent/subagent-mailbox"
import { handleFollowupTask, TaskRegistry, TurnWakeRegistry } from "@/subagent"

/** Build the WS3 delivery deps over the real mailbox/registry/wake. The
 *  task-id → mailbox-label translation (BUG#4) is now owned by the controller
 *  via `control.labelOf()`; self/lineage fold into the target resolver. */
const followupDeps = (
  registry: TaskRegistry,
  mailbox: ReturnType<typeof createSubagentMailbox>,
  wake: TurnWakeRegistry,
  callerLabel: string,
  over: { ownTaskId?: string } = {},
) => {
  const control = wake as unknown as SubagentControlRegistry
  return {
    delivery: createSubagentDeliveryController({
      control,
      mailbox: mailbox as unknown as DeliveryMailboxPort,
      formatPeer: (from, kind, body) => `[teammate ${from} — untrusted] [${kind}] ${body}`,
      resolveTarget: createTargetResolver({
        registry,
        control,
        ...(over.ownTaskId !== undefined ? { ownTaskId: over.ownTaskId } : {}),
      }),
      newDeliveryId: (() => {
        let n = 0
        return () => {
          n += 1
          return `del-${n}`
        }
      })(),
      steerEnabled: false,
    }),
    callerLabel,
  }
}

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
  // WS3: the task-id → mailbox-label translation is now owned by the delivery
  // CONTROLLER (via `control.labelOf()`), not a `resolveLabel` tool dep. The
  // child registers a typed control ENDPOINT binding its mailbox label; the
  // controller resolves the delivery address through it.
  const setup = (opts: { withLabel?: boolean } = {}) => {
    const registry = new TaskRegistry()
    const taskId = registry.newId()
    registry.register({ id: taskId, description: "child" })
    const mailbox = createSubagentMailbox()
    const wake = new TurnWakeRegistry()
    const childLabel = "root/0"
    if (opts.withLabel !== false) {
      wake.registerEndpoint(taskId, {
        mailboxLabel: childLabel,
        wake: () => "woke",
        interrupt: () => "woke_idle",
        steer: () => "accepted",
      })
    }
    return { registry, mailbox, wake, taskId, childLabel }
  }

  test("the message lands in the child's REAL inbox (task id → mailbox label)", () => {
    const { registry, mailbox, wake, taskId, childLabel } = setup()
    const out = handleFollowupTask(
      { agentId: taskId, message: "do X" },
      followupDeps(registry, mailbox, wake, "root"),
    )
    expect(out.kind).toBe("success")
    // The child, draining its mailbox label, sees the message.
    expect(mailbox.read(childLabel).map((m) => m.body)).toEqual(["do X"])
    // And nothing sits at the phantom task-id address.
    expect(mailbox.read(taskId).map((m) => m.body)).toEqual([])
  })

  test("no label bound ⇒ falls back to the task-id address (verbatim)", () => {
    // No endpoint/label wired ⇒ `labelOf` is undefined ⇒ the controller sends to
    // the task id verbatim (honest fallback; the ensure-turn wake degrades to
    // no_waker since there's no live endpoint). Proves the label resolution is
    // the ONLY thing routing to `root/N`.
    const { registry, mailbox, wake, taskId, childLabel } = setup({ withLabel: false })
    const out = handleFollowupTask(
      { agentId: taskId, message: "do X" },
      followupDeps(registry, mailbox, wake, "root"),
    )
    // Delivered (honest degrade), but to the task-id phantom address, not root/N.
    expect(out.kind).toBe("error") // no_waker degrade surfaces as an honest error
    expect(mailbox.read(childLabel).map((m) => m.body)).toEqual([])
    expect(mailbox.read(taskId).map((m) => m.body)).toEqual(["do X"])
  })

  test("self-target guard — a child cannot followup_task its OWN task id", () => {
    const { registry, mailbox, wake, taskId, childLabel } = setup()
    const out = handleFollowupTask(
      { agentId: taskId, message: "wake myself" },
      followupDeps(registry, mailbox, wake, childLabel, { ownTaskId: taskId }),
    )
    expect(out.kind).toBe("error")
    if (out.kind === "error") expect(out.cause).toBe("self_target")
    // No message was delivered (the guard short-circuits before send).
    expect(mailbox.read(childLabel).map((m) => m.body)).toEqual([])
  })

  test("self-target guard absent (ownTaskId unset) ⇒ no guard, delivery proceeds", () => {
    const { registry, mailbox, wake, taskId, childLabel } = setup()
    const out = handleFollowupTask(
      { agentId: taskId, message: "hi" },
      followupDeps(registry, mailbox, wake, "root"),
    )
    expect(out.kind).toBe("success")
    expect(mailbox.read(childLabel).map((m) => m.body)).toEqual(["hi"])
  })
})
