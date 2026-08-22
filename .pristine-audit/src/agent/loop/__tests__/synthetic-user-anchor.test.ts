import { describe, expect, test } from "bun:test"
import { buildTurnContext } from "@/agent"
import type { AgentConfig } from "@/agent/types"
import type { Message } from "@/llm"
import { makeSyntheticUserMessage } from "../../synthetic-user"
import { injectRedactionBanner } from "../context-assembler"

const u = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

describe("injectRedactionBanner — human prompt anchoring", () => {
  test("prepends to the latest human user text, not a synthetic injection", () => {
    const ctx = buildTurnContext({
      baseMessages: [u("real human prompt")],
      cwd: "/repo",
      planMode: false,
      mentionInjectionMessages: [
        makeSyntheticUserMessage("mention-injection", [{ type: "text", text: "@repo" }]),
      ],
    })

    const out = injectRedactionBanner(
      {
        redaction: { disabled: true, acknowledgedRisk: "unit-test" },
      } as AgentConfig,
      ctx,
    )

    const first = out.messages[0]?.content[0]
    const second = out.messages[1]?.content[0]
    expect(first?.type === "text" ? first.text : "").toContain("Secret redaction DISABLED")
    expect(first?.type === "text" ? first.text : "").toContain("real human prompt")
    expect(second?.type === "text" ? second.text : "").toContain("@repo")
    expect(second?.type === "text" ? second.text : "").not.toContain("Secret redaction DISABLED")
  })
})
