/**
 * WS-D batch-1 (UUX-1-01) — `/edit-plan` effect-receipt hellgate.
 *
 * Template: **success text ("updated") while the plan store is unchanged ⇒
 * RED.** The REAL wired adapter (`buildPlanEditAdapter` over the REAL
 * in-memory `PlanStore`) is driven through the REAL `/edit-plan` command with
 * an injected editor seam that mutates the temp file. The structured plan
 * store cannot losslessly absorb a free-form markdown edit (the rendered body
 * drops todo ids/deps/phases), so the adapter must FAIL-CLOSED: nonzero exit
 * + an honest "not persisted" line — never "updated (N chars)" over a no-op.
 *
 * The port-level contract (a wire whose `setPlan` genuinely persists → success
 * print allowed) stays pinned by `edit-plan-cmd-hellgate.test.ts` HELL-EDPL-07.
 */

import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import { createInMemoryPlanStore, type PlanStore } from "@/agent/plan/state"
import { editPlanCmd } from "@/apps/cli/edit-plan-cmd"
import { buildPlanEditAdapter } from "@/apps/cli/repl/ctx-adapters/plan-edit-adapter"
import type { SlashContext } from "@/apps/cli/slash-commands"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const seededStore = (): PlanStore => {
  const store = createInMemoryPlanStore({ now: () => 1_000 })
  const r = store.create({
    name: "Ship WS-D",
    overview: "kill false success",
    todos: [
      { content: "fix snapshot ordinal" },
      { content: "fix edit-plan receipt", status: "in_progress" },
    ],
  })
  if (!r.ok) throw new Error("seed plan failed")
  return store
}

interface Io {
  readonly out: string[]
  readonly err: string[]
}

const makeCtx = (
  store: PlanStore,
  editedBody: string | ((original: string) => string),
): { ctx: SlashContext; io: Io } => {
  const io: Io = { out: [], err: [] }
  const ctx = {
    out: (s: string) => io.out.push(s),
    err: (s: string) => io.err.push(s),
    cwd: "/tmp",
    planEdit: buildPlanEditAdapter(store),
    editorOverride: "fake-editor",
    // Editor seam: rewrite the temp file the command handed us, exit 0.
    editorSpawn: async (_cmd: string, args: readonly string[]) => {
      const path = args[args.length - 1] as string
      const original = await fs.readFile(path, "utf8")
      const next = typeof editedBody === "function" ? editedBody(original) : editedBody
      await fs.writeFile(path, next, "utf8")
      return 0
    },
  } as SlashContext
  return { ctx, io }
}

/** Deep, fresh snapshot of the store's observable state. */
const storeState = (store: PlanStore): string => JSON.stringify(store.current())

/* ------------------------------------------------------------------ */
/* hellgate                                                            */
/* ------------------------------------------------------------------ */

describe("/edit-plan over the REAL plan-edit adapter — effect receipt", () => {
  test("HELLGATE: edited body ⇒ plan store changed OR nonzero exit; 'updated' while the store is unchanged is unrepresentable", async () => {
    const store = seededStore()
    const before = storeState(store)
    const { ctx, io } = makeCtx(store, "# Totally new plan\n\nrewritten by user\n")

    const exit = await editPlanCmd.run([], ctx)
    const after = storeState(store) // fresh readback from the live store

    if (exit === 0) {
      // A success exit is only honest when the store actually absorbed the edit.
      expect(after).not.toBe(before)
    } else {
      // Fail-closed: store untouched AND no success copy.
      expect(after).toBe(before)
      expect(io.out.join("")).not.toContain("updated")
      expect(io.err.join("")).toContain("not persisted")
    }
    // The RED clincher: exit 0 + unchanged store (the legacy no-op setPlan
    // printing "updated (N chars)") is the forbidden state.
    expect(exit === 0 && after === before).toBe(false)
  })

  test("paired control: byte-identical editor round-trip stays a clean no-op ('unchanged', exit 0, store untouched)", async () => {
    const store = seededStore()
    const before = storeState(store)
    const { ctx, io } = makeCtx(store, (original) => original)

    const exit = await editPlanCmd.run([], ctx)

    expect(exit).toBe(0)
    expect(storeState(store)).toBe(before)
    expect(io.out.join("")).toContain("unchanged")
    expect(io.out.join("")).not.toContain("updated (")
  })

  test("paired control: getPlan renders the structured plan (name + todos) for the editor", async () => {
    const store = seededStore()
    let seen = ""
    const { ctx } = makeCtx(store, (original) => {
      seen = original
      return original
    })
    await editPlanCmd.run([], ctx)
    expect(seen).toContain("# Ship WS-D")
    expect(seen).toContain("fix snapshot ordinal")
    expect(seen).toContain("[~] fix edit-plan receipt")
  })

  test("adversarial: empty editor buffer (user wiped the file) must NOT be success-printed as an update", async () => {
    const store = seededStore()
    const before = storeState(store)
    const { ctx, io } = makeCtx(store, "")

    const exit = await editPlanCmd.run([], ctx)
    const after = storeState(store)

    expect(exit === 0 && after === before).toBe(false)
    if (exit !== 0) {
      expect(io.out.join("")).not.toContain("updated")
    }
  })
})
