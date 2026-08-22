/**
 * ticket-11 (P8) finding #7 — comp-root env-gate for the active-worktree slot.
 *
 * The CLI composition root mints `AgentConfig.activeWorktreeSlot` ONLY when
 * `QUANTA_WORKTREE_TOOL` is on (default-OFF). This pins both directions of that
 * gate over the extracted pure minter so the contract is testable without a full
 * session boot:
 *   - env WITHOUT the knob ⇒ undefined (tools unregistered + cwd byte-identical).
 *   - env WITH `QUANTA_WORKTREE_TOOL=1` ⇒ a slot carrying
 *     `repoRoot === sessionCwd === boot.cwd`.
 */

import { describe, expect, test } from "bun:test"
import { mintActiveWorktreeSlot } from "@/agent"

const BOOT_CWD = "/tmp/session-jail-root"

describe("mintActiveWorktreeSlot — QUANTA_WORKTREE_TOOL gate", () => {
  test("env WITHOUT the knob ⇒ undefined (default-OFF)", () => {
    expect(mintActiveWorktreeSlot({}, BOOT_CWD)).toBeUndefined()
    expect(mintActiveWorktreeSlot({ QUANTA_WORKTREE_TOOL: "0" }, BOOT_CWD)).toBeUndefined()
    expect(mintActiveWorktreeSlot({ QUANTA_WORKTREE_TOOL: "" }, BOOT_CWD)).toBeUndefined()
  })

  test("env WITH QUANTA_WORKTREE_TOOL=1 ⇒ slot carrying repoRoot===sessionCwd===boot.cwd", () => {
    const slot = mintActiveWorktreeSlot({ QUANTA_WORKTREE_TOOL: "1" }, BOOT_CWD)
    expect(slot).toBeDefined()
    expect(slot?.repoRoot).toBe(BOOT_CWD)
    expect(slot?.sessionCwd).toBe(BOOT_CWD)
    // Starts empty — enter_worktree sets it.
    expect(slot?.current()).toBeUndefined()
  })
})
