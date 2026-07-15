/**
 * W1-b (jul-15) HELLGATE — mailbox factory SSOT (F2 DoS-cap split-brain).
 *
 * F2: the per-sender undelivered DoS cap (`maxUndeliveredPerSender`, audit-H R2)
 * was baked ONLY into `optional-ports.ts`'s private `defaultSubagentMailbox()`.
 * The host assembler minted its mailbox with the RAW `createSubagentMailbox()`
 * (no cap) at BOTH the `maybeWireMailbox` slot and the side-agent fallback — so
 * any surface that reaches the mailbox through the assembler (web-daemon, bench,
 * eval) got an UNCAPPED mailbox: one hostile sender flooding `send({to:"ghost"})`
 * could consume the entire global retention budget and evict legit sibling mail.
 *
 * Fix: `createDefaultSubagentMailbox()` in the owner slice (the cap baked once),
 * called by ALL three sites.
 *
 * RED today on the assembler path: `assembleAgentConfig(... QUANTA_SUBAGENT_MAILBOX=1)`
 * mints an UNCAPPED mailbox, so a 33-deep single-sender flood retains all 33.
 * GREEN after the fix: the cap (32) evicts the flooder's oldest, and — the audit-H
 * isolation guarantee — a DIFFERENT sender's mail is untouched.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import {
  createDefaultSubagentMailbox,
  DEFAULT_SUBAGENT_MAILBOX_MAX_UNDELIVERED_PER_SENDER as CAP,
  type MailboxPort,
} from "@/agent/subagent-mailbox"
import { assembleAgentConfig } from "@/host/runtime/agent-config-assembler"

const baseReq = (sessionId: string) => ({
  llm: {
    stream() {
      throw new Error("unexpected stream()")
    },
  } as unknown as AgentConfig["llm"],
  registry: {
    register: () => undefined,
    get: () => undefined,
    list: () => [],
  } as unknown as AgentConfig["registry"],
  stream: { emit: () => undefined },
  permission: { mode: "default" as const },
  messages: [],
  system: "test",
  cwd: process.cwd(),
  maxTurns: 1,
  signal: new AbortController().signal,
  sessionId,
})

/** Flood `mailbox` with `n` undelivered messages from `from` to a never-reading
 *  ghost target. Returns the mailbox for chaining. */
const flood = (mailbox: MailboxPort, from: string, n: number): MailboxPort => {
  for (let i = 0; i < n; i++) {
    mailbox.send({ from, to: "ghost-never-reads", kind: "request", body: `m${i}` })
  }
  return mailbox
}

describe("W1-b — assembler-minted mailbox enforces the per-sender DoS cap", () => {
  test("a single-sender flood past the cap is bounded (oldest evicted), NOT retained whole", () => {
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseReq("sess-w1b") },
      { QUANTA_SUBAGENT_MAILBOX: "1" },
    )
    const mailbox = (cfg as AgentConfig & { subagentMailbox?: MailboxPort }).subagentMailbox
    expect(mailbox).toBeDefined()
    if (mailbox === undefined) throw new Error("expected subagentMailbox wired")

    flood(mailbox, "flooder", CAP + 1)

    // RED pre-fix (uncapped ⇒ all CAP+1 retained). GREEN post-fix: cap holds.
    expect(mailbox.list({ from: "flooder" }).length).toBe(CAP)
  })

  test("audit-H isolation: the flooder's cap does NOT evict a DIFFERENT sender's mail", () => {
    const cfg = assembleAgentConfig(
      { mode: "interactive", base: baseReq("sess-w1b-iso") },
      { QUANTA_SUBAGENT_MAILBOX: "1" },
    )
    const mailbox = (cfg as AgentConfig & { subagentMailbox?: MailboxPort }).subagentMailbox
    if (mailbox === undefined) throw new Error("expected subagentMailbox wired")

    mailbox.send({ from: "legit", to: "ghost-never-reads", kind: "request", body: "keep-me" })
    flood(mailbox, "flooder", CAP + 5)

    // The legit sender is well under its own cap ⇒ its mail survives the flood.
    expect(mailbox.list({ from: "legit" }).length).toBe(1)
    expect(mailbox.list({ from: "flooder" }).length).toBe(CAP)
  })
})

describe("W1-b — the owner-slice factory bakes the cap (SSOT)", () => {
  test("createDefaultSubagentMailbox enforces the same per-sender cap directly", () => {
    const mailbox = createDefaultSubagentMailbox()
    flood(mailbox, "flooder", CAP + 10)
    expect(mailbox.list({ from: "flooder" }).length).toBe(CAP)
  })

  test("CAP is a positive integer (a real bound, not undefined/0)", () => {
    expect(Number.isInteger(CAP)).toBe(true)
    expect(CAP).toBeGreaterThan(0)
  })

  test("an explicit maxUndeliveredPerSender override WINS over the baked default (opts spread order)", () => {
    // Proves store.ts merges `...opts` AFTER the baked default ⇒ a caller override
    // is honored (RED if the factory hard-coded the cap before the spread).
    const mailbox = createDefaultSubagentMailbox({ maxUndeliveredPerSender: 3 })
    flood(mailbox, "flooder", 3 + 10)
    expect(mailbox.list({ from: "flooder" }).length).toBe(3)
  })
})
