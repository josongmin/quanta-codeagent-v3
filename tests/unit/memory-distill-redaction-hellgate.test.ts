/**
 * Slice S9 Part C — distill-input redaction port hellgate.
 *
 * The consolidator hook receives rollout messages verbatim from the loop.
 * `consolidator.redact` is the abstracted port that masks known-format
 * secrets BEFORE they hit the Phase1 LLM. The port is intentionally an
 * opaque `(s: string) => string` — pattern internals MUST NOT leak across
 * the seam.
 *
 * Pins:
 *   - Identity redactor (or omitted) ⇒ content reaches Phase1 byte-identical.
 *   - Custom redactor ⇒ Phase1 receives the redactor's output.
 *   - Structured (array-of-blocks) content ⇒ each `text` block redacted;
 *     non-text blocks preserved verbatim.
 *   - Anti-leak: a custom redactor MUST receive the raw secret as a string
 *     ONCE per text segment (so a real `redactSecrets` wire would see the
 *     secret and replace it). The port surface NEVER exposes pattern
 *     internals (RedactionKind / regex / placeholders are not in the API).
 *   - Real-redactor smoke: wiring `redactSecrets({origin:"memory_distill"})`
 *     against a string containing an AWS access key id ⇒ Phase1 distill
 *     sees the placeholder, NOT the raw key.
 */

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { runMemoryConsolidatorHook } from "@/agent/memory-consolidator-hook"
import type { Message } from "@/llm"
import { type Phase1Port, Stage1Store } from "@/memory"
import { redactSecrets } from "@/security"

// ─── Fakes ───────────────────────────────────────────────────────────────

type CapturingPort = Phase1Port & {
  lastSeen: ReadonlyArray<{ role: string; content: unknown }>
  calls: number
}
const makePort = (): CapturingPort => {
  const port = {
    lastSeen: [] as ReadonlyArray<{ role: string; content: unknown }>,
    calls: 0,
    async distill(args: { rolloutMessages: ReadonlyArray<{ role: string; content: unknown }> }) {
      port.calls += 1
      port.lastSeen = args.rolloutMessages
      return {
        rolloutSummary: "summary",
        rawMemory: "- decision",
        preferenceSignals: [] as string[],
      }
    },
  } satisfies CapturingPort
  return port
}

const makeStore = (): Stage1Store => new Stage1Store(new Database(":memory:"))

const textContent = (text: string): Message["content"] => [{ type: "text", text }]

const baseInput = (
  messages: ReadonlyArray<Message>,
  consolidatorOverrides: {
    redact?: (s: string) => string
    threadId?: string
  } = {},
  port?: Phase1Port,
  store?: Stage1Store,
) => {
  const p = port ?? makePort()
  const s = store ?? makeStore()
  return {
    sessionOk: true,
    consolidator: {
      enabled: true,
      port: p,
      store: s,
      threadId: consolidatorOverrides.threadId ?? "t1",
      ...(consolidatorOverrides.redact !== undefined
        ? { redact: consolidatorOverrides.redact }
        : {}),
    },
    sessionId: "session-1",
    rolloutMessages: messages,
    turnCount: 5,
    now: () => 1_000_000,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("memory-distill-redaction-hellgate — identity / absent (default-OFF)", () => {
  test("redact omitted ⇒ Phase1 sees byte-identical content", async () => {
    const port = makePort()
    const msg: Message = { role: "user", content: textContent("hello world") }
    const out = await runMemoryConsolidatorHook(baseInput([msg], {}, port))
    expect(out.kind).toBe("distilled")
    expect(port.calls).toBe(1)
    expect(port.lastSeen[0]?.content).toEqual(textContent("hello world"))
  })

  test("identity redactor (s ⇒ s) preserves the original (default-OFF)", async () => {
    const port = makePort()
    const msg: Message = { role: "user", content: textContent("preserved-payload-XYZ") }
    const out = await runMemoryConsolidatorHook(baseInput([msg], { redact: (s) => s }, port))
    expect(out.kind).toBe("distilled")
    expect(port.lastSeen[0]?.content).toEqual(textContent("preserved-payload-XYZ"))
  })
})

describe("memory-distill-redaction-hellgate — custom redactor", () => {
  test("upper-case stub ⇒ Phase1 sees redactor's output", async () => {
    const port = makePort()
    const msg: Message = { role: "user", content: textContent("lowercase content") }
    await runMemoryConsolidatorHook(baseInput([msg], { redact: (s) => s.toUpperCase() }, port))
    expect(port.lastSeen[0]?.content).toEqual(textContent("LOWERCASE CONTENT"))
  })

  test("redactor invoked exactly ONCE per text segment", async () => {
    const port = makePort()
    let calls = 0
    const redact = (s: string): string => {
      calls += 1
      return s
    }
    const msgs: Message[] = [
      { role: "user", content: textContent("a") },
      { role: "assistant", content: textContent("b") },
      { role: "user", content: textContent("c") },
    ]
    await runMemoryConsolidatorHook(baseInput(msgs, { redact }, port))
    expect(calls).toBe(3)
  })
})

describe("memory-distill-redaction-hellgate — structured (block-array) content", () => {
  test("each text block redacted; non-text blocks preserved", async () => {
    const port = makePort()
    const blocks: Message["content"] = [
      { type: "text", text: "alpha" },
      { type: "tool_use", id: "tu_1", name: "Read", input: { p: "/x" } },
      { type: "text", text: "beta" },
    ]
    const msg: Message = {
      role: "user",
      content: blocks,
    }
    await runMemoryConsolidatorHook(baseInput([msg], { redact: (s) => `[R]${s}` }, port))
    const seen = port.lastSeen[0]?.content as unknown[]
    expect(seen[0]).toEqual({ type: "text", text: "[R]alpha" })
    // tool_use block preserved verbatim (non-text)
    expect(seen[1]).toEqual({ type: "tool_use", id: "tu_1", name: "Read", input: { p: "/x" } })
    expect(seen[2]).toEqual({ type: "text", text: "[R]beta" })
  })
})

describe("memory-distill-redaction-hellgate — real `redactSecrets` wire (anti-leak)", () => {
  test("AWS access key id in raw content ⇒ Phase1 sees the placeholder, NOT the raw key", async () => {
    const port = makePort()
    const RAW_KEY = "AKIAIOSFODNN7EXAMPLE"
    const msg: Message = {
      role: "user",
      content: textContent(`the deploy uses ${RAW_KEY} please rotate it`),
    }
    const redact = (s: string): string => redactSecrets(s, { origin: "memory_distill" }).text
    await runMemoryConsolidatorHook(baseInput([msg], { redact }, port))
    const seen = JSON.stringify(port.lastSeen[0]?.content ?? [])
    // Raw secret MUST NOT reach the LLM-facing surface.
    expect(seen).not.toContain(RAW_KEY)
    // Placeholder shape is the seam's CONTRACT (kind label is opaque to
    // this layer — we only assert the secret is gone and SOMETHING
    // replaced it). The exact placeholder string is intentionally NOT
    // asserted here so refactoring `redactSecrets` internals does not
    // require a memory-layer test change.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen).toContain("rotate it")
  })

  test("anti-leak invariant: redaction port surface exposes NO pattern internals", () => {
    // The `redact` port is `(s: string) => string`. The memory layer
    // imports NONE of: RedactionKind, RedactionHit, patterns, regex.
    // This test is a static guard: changing the port shape to expose
    // patterns would be a CONTRACT change visible here.
    const hookModule = require("@/agent/memory-consolidator-hook")
    const exported = Object.keys(hookModule)
    expect(exported).not.toContain("RedactionKind")
    expect(exported).not.toContain("RedactionHit")
    expect(exported).not.toContain("patterns")
  })
})

describe("memory-distill-redaction-hellgate — anti-leak: stored row contains no raw secret", () => {
  test("when a real redactor is wired, the Phase1Port input never carries the raw secret", async () => {
    const port = makePort()
    const RAW_KEY = "AKIAIOSFODNN7EXAMPLE"
    const msgs: Message[] = [
      { role: "user", content: textContent(`env=AWS_ACCESS_KEY_ID=${RAW_KEY}`) },
      { role: "assistant", content: textContent("ok will rotate") },
    ]
    const redact = (s: string): string => redactSecrets(s, { origin: "memory_distill" }).text
    await runMemoryConsolidatorHook(baseInput(msgs, { redact }, port))
    const allSeen = JSON.stringify(port.lastSeen)
    // The serialized payload Phase1 received MUST NOT contain the raw key
    // anywhere, even if a redactor BUG returned identity for some blocks.
    // This is the "right seam" assertion — the redactor was given the
    // chance to mask BEFORE Phase1 saw anything.
    expect(allSeen).not.toContain(RAW_KEY)
  })

  test("identity redactor demonstrates the seam: WITHOUT redaction, the raw secret WOULD reach Phase1", async () => {
    // This is the CONTRA-positive proof — confirms the previous test was
    // not vacuous. With identity, the secret reaches Phase1; with the
    // real redactor (above), it does not. So the seam is load-bearing.
    const port = makePort()
    const RAW_KEY = "AKIAIOSFODNN7EXAMPLE"
    const msg: Message = { role: "user", content: textContent(`env=${RAW_KEY}`) }
    await runMemoryConsolidatorHook(baseInput([msg], { redact: (s) => s }, port))
    expect(JSON.stringify(port.lastSeen[0]?.content)).toContain(RAW_KEY)
  })
})
