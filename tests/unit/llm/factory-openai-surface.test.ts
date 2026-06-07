import { describe, expect, test } from "bun:test"
import { createLLM } from "@/llm/factory"

describe("createLLM openai surface selection", () => {
  test("default openai surface uses Responses on the official OpenAI route", () => {
    const llm = createLLM("openai", { model: "gpt-5-mini", apiKey: "k" }, {})
    expect(llm.surfaceId).toBe("openai-responses")
  })

  test("auto surface keeps chat completions on a custom OpenAI-compatible baseURL", () => {
    const llm = createLLM(
      "openai",
      { model: "gpt-5-mini", apiKey: "k", baseURL: "https://compatible.example/v1" },
      {},
    )
    expect(llm.surfaceId).toBe("openai-chat-completions")
  })

  test("explicit surface=responses selects the Responses adapter", () => {
    const llm = createLLM("openai", { model: "gpt-5-mini", apiKey: "k", surface: "responses" }, {})
    expect(llm.surfaceId).toBe("openai-responses")
  })

  test("env QUANTA_OPENAI_SURFACE=responses selects the Responses adapter", () => {
    const llm = createLLM(
      "openai",
      { model: "gpt-5-mini", apiKey: "k" },
      { QUANTA_OPENAI_SURFACE: "responses" },
    )
    expect(llm.surfaceId).toBe("openai-responses")
  })

  test("official OPENAI_BASE_URL override still resolves to Responses in auto mode", () => {
    const llm = createLLM(
      "openai",
      { model: "gpt-5-mini", apiKey: "k" },
      { OPENAI_BASE_URL: "https://api.openai.com/v1/" },
    )
    expect(llm.surfaceId).toBe("openai-responses")
  })
})
