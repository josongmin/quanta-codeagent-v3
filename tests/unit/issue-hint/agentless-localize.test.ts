/**
 * Agentless localization slice — unit contract.
 *
 *   - Normal response (5 file + reason) → 5 files extracted, in order.
 *   - Hallucinated path (not in fileTree) → silently filtered out.
 *   - Malformed response (no FILE:/REASON:) → empty result.
 *   - Duplicate path lines → first wins, rest dropped.
 *   - LLM stream throws → empty result, rawResponse carries error message.
 *   - Empty problem statement → empty result, NO LLM call made.
 *   - Empty file tree → empty result, NO LLM call made.
 *   - topK cap: response with 7 entries, topK=3 → only 3 kept.
 *   - `composeAgentlessHint` empty result → "" (byte-identity sentinel).
 */
import { describe, expect, test } from "bun:test"
import {
  agentlessLocalize,
  composeAgentlessHint,
  parseAgentlessResponse,
} from "../../../src/agent/issue-hint/agentless-localize"
import type { LLMPort, StreamEvent, StreamInput } from "../../../src/llm"

/** Construct a one-shot LLM that yields the given text as a single text_delta
 *  + message_stop. The `seen` field records the StreamInput the test can
 *  assert against. */
class ScriptedLLM implements LLMPort {
  calls = 0
  lastInput: StreamInput | undefined
  constructor(private readonly text: string) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    this.lastInput = input
    yield { type: "text_delta", delta: this.text }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class EventScriptedLLM implements LLMPort {
  calls = 0
  lastInput: StreamInput | undefined
  constructor(private readonly events: readonly StreamEvent[]) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    this.lastInput = input
    for (const ev of this.events) yield ev
  }
}

class ThrowingLLM implements LLMPort {
  calls = 0
  // biome-ignore lint/correctness/useYield: stream throws before any yield — contract is "LLM raises mid-call"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    throw new Error("provider down")
  }
}

class YieldThenThrowLLM implements LLMPort {
  calls = 0
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    yield { type: "text_delta", delta: "FILE: requests/models.py\nREASON: partial" }
    throw new Error("provider down after partial")
  }
}

const FILE_TREE = [
  "requests/models.py",
  "requests/adapters.py",
  "requests/utils.py",
  "requests/sessions.py",
  "requests/api.py",
]

describe("parseAgentlessResponse — strict line-pair parser", () => {
  test("normal 5-file response → 5 files in order", () => {
    const raw = [
      "FILE: requests/models.py",
      "REASON: IDNAError handling for invalid hostnames",
      "FILE: requests/adapters.py",
      "REASON: URL preparation in HTTPAdapter",
      "FILE: requests/utils.py",
      "REASON: Helper used by both models and adapters",
      "FILE: requests/sessions.py",
      "REASON: Top-level entrypoint",
      "FILE: requests/api.py",
      "REASON: Module-level api.get/post",
    ].join("\n")
    const set = new Set(FILE_TREE)
    const out = parseAgentlessResponse(raw, set)
    expect(out.files).toEqual([
      "requests/models.py",
      "requests/adapters.py",
      "requests/utils.py",
      "requests/sessions.py",
      "requests/api.py",
    ])
    expect(out.rationales).toHaveLength(5)
    expect(out.rationales[0]).toBe("IDNAError handling for invalid hostnames")
  })

  test("hallucinated path (not in tree) → dropped, real files kept", () => {
    const raw = [
      "FILE: nonexistent/fake.py",
      "REASON: not real",
      "FILE: requests/models.py",
      "REASON: real",
    ].join("\n")
    const set = new Set(FILE_TREE)
    const out = parseAgentlessResponse(raw, set)
    expect(out.files).toEqual(["requests/models.py"])
    expect(out.rationales).toEqual(["real"])
  })

  test("malformed response (no FILE:/REASON:) → empty", () => {
    const raw = "I think the bug is in requests/models.py probably."
    const out = parseAgentlessResponse(raw, new Set(FILE_TREE))
    expect(out.files).toEqual([])
    expect(out.rationales).toEqual([])
  })

  test("duplicate path lines → first wins", () => {
    const raw = [
      "FILE: requests/models.py",
      "REASON: first",
      "FILE: requests/models.py",
      "REASON: second",
    ].join("\n")
    const out = parseAgentlessResponse(raw, new Set(FILE_TREE))
    expect(out.files).toEqual(["requests/models.py"])
    expect(out.rationales).toEqual(["first"])
  })

  test("tolerates list-marker prefixes (1./- /*)", () => {
    const raw = [
      "1. FILE: requests/models.py",
      "REASON: numbered",
      "- FILE: requests/adapters.py",
      "REASON: dashed",
      "* FILE: requests/utils.py",
      "REASON: starred",
    ].join("\n")
    const out = parseAgentlessResponse(raw, new Set(FILE_TREE))
    expect(out.files).toEqual(["requests/models.py", "requests/adapters.py", "requests/utils.py"])
  })

  test("strips backtick / quote wrappers on the path", () => {
    const raw = [
      "FILE: `requests/models.py`",
      "REASON: backticked",
      'FILE: "requests/adapters.py"',
      "REASON: quoted",
    ].join("\n")
    const out = parseAgentlessResponse(raw, new Set(FILE_TREE))
    expect(out.files).toEqual(["requests/models.py", "requests/adapters.py"])
  })

  test("REASON without prior FILE → dropped", () => {
    const raw = "REASON: orphan reason\nFILE: requests/models.py\nREASON: legit"
    const out = parseAgentlessResponse(raw, new Set(FILE_TREE))
    expect(out.files).toEqual(["requests/models.py"])
    expect(out.rationales).toEqual(["legit"])
  })

  test("prototype-pollution path is rejected even if in tree", () => {
    const set = new Set(["__proto__", "requests/models.py"])
    const raw = [
      "FILE: __proto__",
      "REASON: proto pollution attempt",
      "FILE: requests/models.py",
      "REASON: legit",
    ].join("\n")
    const out = parseAgentlessResponse(raw, set)
    expect(out.files).toEqual(["requests/models.py"])
  })

  test("empty input → empty result", () => {
    expect(parseAgentlessResponse("", new Set(FILE_TREE))).toEqual({ files: [], rationales: [] })
  })
})

describe("agentlessLocalize — full integration with mock LLM", () => {
  const goodResponse = [
    "FILE: requests/models.py",
    "REASON: prepare_url IDNAError handling",
    "FILE: requests/adapters.py",
    "REASON: HTTPAdapter URL preparation",
  ].join("\n")

  const baseDeps = {
    fileTree: async () => FILE_TREE,
  }

  test("happy path → ranked files + rationales", async () => {
    const llm = new ScriptedLLM(goodResponse)
    const out = await agentlessLocalize("UnicodeError on http://.example.com", {
      ...baseDeps,
      llm,
    })
    expect(out.files).toEqual(["requests/models.py", "requests/adapters.py"])
    expect(out.rationales).toHaveLength(2)
    expect(out.rawResponse).toBe(goodResponse)
    expect(llm.calls).toBe(1)
  })

  test("empty problem statement → empty result, NO LLM call", async () => {
    const llm = new ScriptedLLM(goodResponse)
    const out = await agentlessLocalize("", { ...baseDeps, llm })
    expect(out.files).toEqual([])
    expect(out.rawResponse).toBe("")
    expect(llm.calls).toBe(0)
  })

  test("empty file tree → empty result, NO LLM call", async () => {
    const llm = new ScriptedLLM(goodResponse)
    const out = await agentlessLocalize("real issue", {
      fileTree: async () => [],
      llm,
    })
    expect(out.files).toEqual([])
    expect(llm.calls).toBe(0)
  })

  test("LLM throws → empty result, rawResponse carries error", async () => {
    const llm = new ThrowingLLM()
    const out = await agentlessLocalize("real issue", { ...baseDeps, llm })
    expect(out.files).toEqual([])
    expect(out.rationales).toEqual([])
    expect(out.rawResponse).toContain("LLM stream failed")
    expect(out.rawResponse).toContain("provider down")
    expect(llm.calls).toBe(1)
  })

  test("malformed LLM response → empty files, raw preserved", async () => {
    const llm = new ScriptedLLM("just prose with no FILE: token anywhere")
    const out = await agentlessLocalize("real issue", { ...baseDeps, llm })
    expect(out.files).toEqual([])
    expect(out.rawResponse).toBe("just prose with no FILE: token anywhere")
  })

  test("stream_reset tombstones dead partial and keeps only fresh text", async () => {
    const llm = new EventScriptedLLM([
      { type: "text_delta", delta: "FILE: requests/api.py\nREASON: dead partial\n" },
      { type: "stream_reset" },
      { type: "text_delta", delta: "FILE: requests/models.py\n" },
      { type: "text_delta", delta: "REASON: prepare_url IDNAError handling\n" },
      { type: "text_delta", delta: "FILE: requests/adapters.py\nREASON: HTTPAdapter URL preparation" },
      { type: "message_stop", stop_reason: "end_turn" },
    ])
    const out = await agentlessLocalize("real issue", { ...baseDeps, llm })
    expect(out.files).toEqual(["requests/models.py", "requests/adapters.py"])
    expect(out.rationales).toEqual([
      "prepare_url IDNAError handling",
      "HTTPAdapter URL preparation",
    ])
    expect(out.rawResponse).toBe(goodResponse)
  })

  test("mid-stream failure still returns error surface, not partial text", async () => {
    const llm = new YieldThenThrowLLM()
    const out = await agentlessLocalize("real issue", { ...baseDeps, llm })
    expect(out.files).toEqual([])
    expect(out.rationales).toEqual([])
    expect(out.rawResponse).toContain("LLM stream failed")
    expect(out.rawResponse).toContain("provider down after partial")
  })

  test("topK=3 with 5-file response → trimmed to 3", async () => {
    const raw = FILE_TREE.flatMap((p, i) => [`FILE: ${p}`, `REASON: r${i}`]).join("\n")
    const llm = new ScriptedLLM(raw)
    const out = await agentlessLocalize("real issue", { ...baseDeps, llm, topK: 3 })
    expect(out.files).toHaveLength(3)
    expect(out.files).toEqual(FILE_TREE.slice(0, 3))
  })

  test("topK=0 → empty result (config guard)", async () => {
    const llm = new ScriptedLLM(goodResponse)
    const out = await agentlessLocalize("real issue", { ...baseDeps, llm, topK: 0 })
    expect(out.files).toEqual([])
    expect(llm.calls).toBe(0)
  })

  test("fileTree throws → empty result, NO LLM call", async () => {
    const llm = new ScriptedLLM(goodResponse)
    const out = await agentlessLocalize("real issue", {
      fileTree: async () => {
        throw new Error("permission denied")
      },
      llm,
    })
    expect(out.files).toEqual([])
    expect(llm.calls).toBe(0)
  })

  test("prompt includes file tree + topK token", async () => {
    const llm = new ScriptedLLM(goodResponse)
    await agentlessLocalize("real issue", { ...baseDeps, llm, topK: 7 })
    const sent = llm.lastInput
    expect(sent).toBeDefined()
    const text = sent?.messages[0]?.content[0]
    expect(text?.type).toBe("text")
    if (text?.type === "text") {
      expect(text.text).toContain("requests/models.py")
      expect(text.text).toContain("top 7 files")
      expect(text.text).toContain("FILE: <path>")
      expect(text.text).toContain("REASON: <one sentence>")
    }
  })
})

describe("composeAgentlessHint — markdown formatter", () => {
  test("empty result → empty string (byte-identity sentinel)", () => {
    expect(composeAgentlessHint({ files: [], rationales: [], rawResponse: "" })).toBe("")
    expect(composeAgentlessHint({ files: [], rationales: [], rawResponse: "anything" })).toBe("")
  })

  test("non-empty → markdown with header + numbered list + calibration line", () => {
    const out = composeAgentlessHint({
      files: ["requests/models.py", "requests/adapters.py"],
      rationales: ["IDNAError handling", "URL preparation"],
      rawResponse: "raw",
    })
    expect(out).toContain("## Issue Hints (Agentless localization)")
    expect(out).toContain("Top-2 files most likely to contain the bug:")
    expect(out).toContain("1. `requests/models.py` — IDNAError handling")
    expect(out).toContain("2. `requests/adapters.py` — URL preparation")
    expect(out).toContain("Use these as starting points but verify with your own tools.")
  })

  test("files-only (missing rationale) → path without trailing em-dash", () => {
    const out = composeAgentlessHint({
      files: ["requests/models.py"],
      rationales: [""],
      rawResponse: "raw",
    })
    expect(out).toContain("1. `requests/models.py`")
    expect(out).not.toContain("`requests/models.py` —")
  })

  test("calibration line is the last non-empty line", () => {
    const out = composeAgentlessHint({
      files: ["a.py"],
      rationales: ["x"],
      rawResponse: "raw",
    })
    const trimmed = out.replace(/\s+$/g, "")
    expect(trimmed.endsWith("Use these as starting points but verify with your own tools.")).toBe(
      true,
    )
  })
})
