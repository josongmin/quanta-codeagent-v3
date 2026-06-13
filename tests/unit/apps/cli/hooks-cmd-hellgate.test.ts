/**
 * HELLGATE — `/hooks` slash command (T04 trust-gate approval surface).
 *
 * Proves the CLI surface is NON-INERT: it lists configured hooks with review
 * status, and an `approve` writes the SAME on-disk ledger the runner's review
 * port reads — so an approval actually takes effect. The ledger path is keyed
 * off `QUANTA_CONFIG_DIR` (pointed at a temp dir here) exactly as the host runtime
 * resolves it.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultHookApprovalsPath, hookBindingKey, HookReviewStore } from "@/agent"
import { hooksCmd } from "@/apps/cli/hooks-cmd"
import type { SlashContext } from "@/apps/cli/slash-contract"

const settingsWithHook = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "guard.sh" }] }] },
})

const ctxOf = (cwd: string): { ctx: SlashContext; out: () => string; err: () => string } => {
  let outBuf = ""
  let errBuf = ""
  const ctx = {
    out: (s: string) => {
      outBuf += s
    },
    err: (s: string) => {
      errBuf += s
    },
    cwd,
  } as unknown as SlashContext
  return { ctx, out: () => outBuf, err: () => errBuf }
}

describe("/hooks — list / review / approve", () => {
  test("list shows the cwd hook as NEEDS REVIEW; approve writes the runner's ledger", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hooks-cmd-cwd-"))
    const cfg = await mkdtemp(join(tmpdir(), "hooks-cmd-cfg-"))
    const prev = process.env.QUANTA_CONFIG_DIR
    process.env.QUANTA_CONFIG_DIR = cfg
    try {
      await writeFile(join(cwd, "settings.json"), settingsWithHook, "utf8")
      const binding = { event: "PreToolUse", matcher: "Write", command: "guard.sh" }
      const key = hookBindingKey(binding)

      // list ⇒ the repo hook is review-gated and surfaces its key.
      const { ctx, out } = ctxOf(cwd)
      expect(await hooksCmd.run([], ctx)).toBe(0)
      expect(out()).toContain("NEEDS REVIEW")
      expect(out()).toContain(key)
      expect(out()).toContain("guard.sh")

      // approve ⇒ writes the ledger the RUNNER reads (defaultHookApprovalsPath(cfg)).
      const { ctx: ctx2, out: out2 } = ctxOf(cwd)
      expect(await hooksCmd.run(["approve", key], ctx2)).toBe(0)
      expect(out2()).toContain("approved")

      const store = await HookReviewStore.load(defaultHookApprovalsPath(cfg))
      expect(store.isApproved(binding)).toBe(true)

      // re-list ⇒ now shows approved (no pending).
      const { ctx: ctx3, out: out3 } = ctxOf(cwd)
      await hooksCmd.run(["review"], ctx3)
      expect(out3()).not.toContain("NEEDS REVIEW")
    } finally {
      if (prev === undefined) delete process.env.QUANTA_CONFIG_DIR
      else process.env.QUANTA_CONFIG_DIR = prev
      await rm(cwd, { recursive: true, force: true })
      await rm(cfg, { recursive: true, force: true })
    }
  })

  test("approve with an unknown key is rejected (cannot approve a non-configured hook)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hooks-cmd-cwd2-"))
    const cfg = await mkdtemp(join(tmpdir(), "hooks-cmd-cfg2-"))
    const prev = process.env.QUANTA_CONFIG_DIR
    process.env.QUANTA_CONFIG_DIR = cfg
    try {
      await writeFile(join(cwd, "settings.json"), settingsWithHook, "utf8")
      const { ctx, err } = ctxOf(cwd)
      expect(await hooksCmd.run(["approve", "deadbeefdeadbeef"], ctx)).toBe(1)
      expect(err()).toContain("no configured hook")
      // Nothing was written to the ledger.
      const store = await HookReviewStore.load(defaultHookApprovalsPath(cfg))
      expect(store.list().length).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.QUANTA_CONFIG_DIR
      else process.env.QUANTA_CONFIG_DIR = prev
      await rm(cwd, { recursive: true, force: true })
      await rm(cfg, { recursive: true, force: true })
    }
  })
})
