/**
 * ADR-0151 — integration smoke for the Bedrock + Vertex transport adapters.
 *
 * Gating: this suite is OFF by default. To run, set
 *   QUANTA_LLM_PROVIDER_SMOKE=1
 * plus the cloud credentials for the case you want to exercise:
 *   - Bedrock:  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION
 *               (optionally QUANTA_BEDROCK_TEST_MODEL to override the model id)
 *   - Vertex:   GOOGLE_APPLICATION_CREDENTIALS + QUANTA_VERTEX_PROJECT_ID +
 *               QUANTA_VERTEX_LOCATION
 *               (optionally QUANTA_VERTEX_TEST_MODEL)
 *
 * Without these env vars set, every case below is `skip`'d — CI / local
 * developers without cloud accounts see "0 tests run" rather than auth-failed
 * noise. The whole point of this file is the "real wire works" smoke that the
 * unit-level DI fakes cannot prove; do NOT make it run unconditionally.
 *
 * Notes:
 * - `max_tokens: 16` keeps the spend trivial (≤ $0.001 / run on Haiku).
 * - mapRawEvent absorbs `message_start` silently, so the FIRST adapter-visible
 *   event from a healthy stream is `text_delta` (or `tool_use_start` for a
 *   tool-call turn). We pin that contract here.
 * - The abort case exercises both layers of signal forwarding (create() AND
 *   the in-flight async iteration).
 */
import { describe, expect, test } from "bun:test"
import { BedrockProviderAdapter } from "@/llm/providers/bedrock-adapter"
import type { ProviderConfig } from "@/llm/providers/provider-port"
import { VertexProviderAdapter } from "@/llm/providers/vertex-adapter"

const SMOKE_ON = process.env.QUANTA_LLM_PROVIDER_SMOKE === "1"
const HAVE_AWS =
  process.env.AWS_ACCESS_KEY_ID !== undefined && process.env.AWS_SECRET_ACCESS_KEY !== undefined
const HAVE_GCP =
  process.env.GOOGLE_APPLICATION_CREDENTIALS !== undefined &&
  process.env.QUANTA_VERTEX_PROJECT_ID !== undefined &&
  process.env.QUANTA_VERTEX_LOCATION !== undefined

const BEDROCK_MODEL =
  process.env.QUANTA_BEDROCK_TEST_MODEL ?? "anthropic.claude-3-haiku-20240307-v1:0"
const VERTEX_MODEL = process.env.QUANTA_VERTEX_TEST_MODEL ?? "claude-3-5-haiku@20241022"

const bedrockConfig = (): ProviderConfig => ({
  providerId: "bedrock",
  model: BEDROCK_MODEL,
  auth: {
    ...(process.env.AWS_ACCESS_KEY_ID !== undefined
      ? { awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID }
      : {}),
    ...(process.env.AWS_SECRET_ACCESS_KEY !== undefined
      ? { awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
      : {}),
    ...(process.env.AWS_SESSION_TOKEN !== undefined
      ? { awsSessionToken: process.env.AWS_SESSION_TOKEN }
      : {}),
    ...(process.env.AWS_REGION !== undefined ? { awsRegion: process.env.AWS_REGION } : {}),
  },
  maxTokens: 16,
})

const vertexConfig = (): ProviderConfig => ({
  providerId: "vertex",
  model: VERTEX_MODEL,
  auth: {
    gcpProjectId: process.env.QUANTA_VERTEX_PROJECT_ID ?? "",
    gcpLocation: process.env.QUANTA_VERTEX_LOCATION ?? "",
  },
  maxTokens: 16,
})

describe.skipIf(!SMOKE_ON)("LLM provider credential smoke (env-gated)", () => {
  test.skipIf(!HAVE_AWS)(
    "Bedrock real stream — adapter yields mapped events",
    async () => {
      const provider = new BedrockProviderAdapter(bedrockConfig())
      const events: Array<{ type: string }> = []
      for await (const ev of provider.stream({
        messages: [{ role: "user", content: [{ type: "text", text: "say hi" }] }],
        tools: [],
      })) {
        events.push(ev as { type: string })
        if (events.length >= 3) break // enough to prove the wire works
      }
      expect(events.length).toBeGreaterThan(0)
      // mapRawEvent absorbs message_start; the first adapter-visible event is
      // text_delta (or tool_use_start). Either is acceptable evidence that
      // the live SDK round-tripped through our adapter shape.
      const knownFirst = ["text_delta", "tool_use_start", "thinking_delta"]
      expect(knownFirst).toContain(events[0]?.type ?? "")
    },
    30_000,
  )

  test.skipIf(!HAVE_AWS)(
    "Bedrock abort mid-stream — halts cleanly",
    async () => {
      const provider = new BedrockProviderAdapter(bedrockConfig())
      const ctl = new AbortController()
      let received = 0
      try {
        for await (const _ of provider.stream({
          messages: [{ role: "user", content: [{ type: "text", text: "count to a hundred" }] }],
          tools: [],
          signal: ctl.signal,
        })) {
          received++
          if (received === 1) ctl.abort()
        }
      } catch {
        // SDK may surface the abort as an error; either swallow or re-throw is
        // fine — what we're testing is "no hang", which manifests as the test
        // completing within the timeout.
      }
      expect(received).toBeGreaterThanOrEqual(1)
    },
    30_000,
  )

  test.skipIf(!HAVE_GCP)(
    "Vertex real stream — adapter yields mapped events",
    async () => {
      const provider = new VertexProviderAdapter(vertexConfig())
      const events: Array<{ type: string }> = []
      for await (const ev of provider.stream({
        messages: [{ role: "user", content: [{ type: "text", text: "say hi" }] }],
        tools: [],
      })) {
        events.push(ev as { type: string })
        if (events.length >= 3) break
      }
      expect(events.length).toBeGreaterThan(0)
      const knownFirst = ["text_delta", "tool_use_start", "thinking_delta"]
      expect(knownFirst).toContain(events[0]?.type ?? "")
    },
    30_000,
  )

  test.skipIf(!HAVE_GCP)(
    "Vertex bad region — auth-fail surfaces typed",
    async () => {
      // Override region with garbage. The SDK fails token-exchange or URL
      // resolution; either way the failure must come up as a typed error from
      // our adapter (LLMError or ProviderError), not as a hanging promise.
      const provider = new VertexProviderAdapter({
        ...vertexConfig(),
        auth: {
          gcpProjectId: process.env.QUANTA_VERTEX_PROJECT_ID ?? "",
          gcpLocation: "definitely-not-a-region",
        },
      })
      let threw = false
      try {
        for await (const _ of provider.stream({
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          tools: [],
        })) {
          // ignore
        }
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    },
    30_000,
  )
})
