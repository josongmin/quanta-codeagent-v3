/**
 * W1-c (jul-15) HELLGATE — honest cross-team deny (F3 dishonest `ok:true`).
 *
 * F3: with team messaging on (`QUANTA_TEAM_PEER_MSG`), the `TeamScopedMailbox`
 * decorator DROPS a cross-team / un-teamed `send` before enqueue and returns a
 * stand-in `MailboxMessage` (`id:"msg_cross-team-denied"`). The
 * `subagent_send_message` tool rendered that stand-in as
 * `{ ok:true, output:"sent message msg_cross-team-denied ..." }` — the model
 * BELIEVED delivery succeeded. A child→parent direct message from an un-teamed
 * agent silently no-op'd with a success receipt.
 *
 * Fix: the decorator stamps `denied:"cross-team"` on the dropped stand-in (store
 * NEVER sets it); the tool maps a `denied` result to `{ ok:false }` + guidance.
 *
 * This hellgate:
 *   1. un-teamed direct send (decorator denies) ⇒ `ok:false` + team guidance.
 *      RED pre-fix: today it renders `ok:true`.
 *   2. un-teamed broadcast (reaches no one) ⇒ `ok:false` (honest no-op).
 *   3. PAIRED CONTROL — same-team direct send ⇒ `ok:true` (real delivery).
 *   4. BYTE-IDENTITY CONTROL — a PLAIN mailbox (no team decorator, knob off) ⇒
 *      `ok:true` unchanged (the fix touches ONLY the denied path).
 */

import { describe, expect, test } from "bun:test"
import {
  createSubagentMailbox,
  type MailboxPort,
  type TeamMembershipGate,
  teamScopedMailbox,
} from "@/agent/subagent-mailbox"
import type { Tool, ToolContext, ToolResult } from "@/tool"
import { subagentMailboxTools } from "@/tool/subagent-mailbox"

const sendTool = (port: MailboxPort): Tool => {
  const tools = subagentMailboxTools(port)
  const t = tools.find((x) => x.name === "subagent_send_message")
  if (t === undefined) throw new Error("subagent_send_message tool not found")
  return t
}

const rootCtx = (): ToolContext => ({ depth: 0 }) as unknown as ToolContext

const runSend = async (port: MailboxPort, input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of sendTool(port).execute(input, rootCtx())) {
    if (ev.type === "result") result = ev.result
  }
  if (result === undefined) throw new Error("tool yielded no result")
  return result
}

/** An un-teamed gate: `sameTeam` is always false (nobody shares a team) and the
 *  roster is empty — exactly the state of a fresh session before `team_create`. */
const unteamedGate: TeamMembershipGate = {
  sameTeam: () => false,
  membersOf: () => [],
}

/** A single-team gate: every agent is in the one team (roster = the two ids). */
const oneTeamGate = (members: readonly string[]): TeamMembershipGate => ({
  sameTeam: () => true,
  membersOf: () => members,
})

describe("W1-c — honest cross-team deny at the tool surface", () => {
  test("un-teamed DIRECT send is reported ok:false with team guidance (not a fake success)", async () => {
    const port = teamScopedMailbox(createSubagentMailbox(), unteamedGate)
    const res = await runSend(port, { to: "sibling-1", kind: "request", body: "compute the sum" })

    expect(res.ok).toBe(false)
    // Guidance names the remedy so the model can react (create/join a team).
    expect(res.output.toLowerCase()).toContain("team")
    // It must NOT masquerade as a successful send.
    expect(res.output.toLowerCase()).not.toContain("sent message")
  })

  test("un-teamed BROADCAST (reaches no one) is reported ok:false", async () => {
    const port = teamScopedMailbox(createSubagentMailbox(), unteamedGate)
    const res = await runSend(port, { to: "*", kind: "broadcast", body: "anyone?" })
    expect(res.ok).toBe(false)
  })

  test("PAIRED CONTROL — same-team direct send IS ok:true (real delivery)", async () => {
    const inner = createSubagentMailbox()
    const port = teamScopedMailbox(inner, oneTeamGate(["root", "sibling-1"]))
    const res = await runSend(port, { to: "sibling-1", kind: "request", body: "hi teammate" })

    expect(res.ok).toBe(true)
    expect(res.output).toContain("sent message")
    // The message really enqueued for the sibling.
    expect(inner.pendingFor("sibling-1")).toBe(1)
  })

  test("BYTE-IDENTITY CONTROL — a plain (un-decorated) mailbox send is unchanged ok:true", async () => {
    const port = createSubagentMailbox()
    const res = await runSend(port, { to: "sibling-1", kind: "request", body: "hi" })
    expect(res.ok).toBe(true)
    expect(res.output).toContain("sent message")
    expect(port.pendingFor("sibling-1")).toBe(1)
  })
})
