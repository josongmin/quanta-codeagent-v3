/**
 * ★ CONTRACT — jun-6-vertex-region-routing RFC §4.1 / §6.1
 *   Per-model Vertex region routing on the ADAPTER OPTS (NOT ProviderConfig —
 *   the prompt threads the map in via `VertexAdapterOptions.vertexRegionByModel`
 *   so the shared `provider-port.ts` / `factory.ts` are untouched in this wave;
 *   the composition root derives the map from `VERTEX_REGION_<MODEL>` env and
 *   passes it down).
 *
 *   Resolution rule: `region = vertexRegionByModel[model] ?? gcpLocation`.
 *   - model IN map ⇒ its region.
 *   - model NOT in map ⇒ fallback `gcpLocation` (byte-identical to today).
 *   - empty / undefined map ⇒ byte-identical single-region path.
 *   - the mandatory `gcpLocation` fallback guard is NOT weakened by a map.
 */
import { describe, expect, test } from "bun:test"
import type { ProviderConfig } from "@/llm/providers/provider-port"
import { ProviderError } from "@/llm/providers/provider-port"
import { type VertexClientFactory, VertexProviderAdapter } from "@/llm/providers/vertex-adapter"

const base = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  providerId: "vertex",
  model: "claude-opus-4-8",
  auth: { gcpProjectId: "my-proj", gcpLocation: "us-central1" },
  ...over,
})

async function* fakeStream(): AsyncGenerator<unknown> {
  yield { type: "message_start", message: { model: "x", usage: { input_tokens: 1 } } }
  yield { type: "message_stop" }
}

interface CallLog {
  region?: string
  clientOptions?: Record<string, unknown>
}

const recordingFactory =
  (log: CallLog): VertexClientFactory =>
  (opts) => {
    log.clientOptions = { ...opts }
    log.region = opts.region
    return {
      messages: {
        async create() {
          return fakeStream() as AsyncIterable<never>
        },
      },
    }
  }

async function drive(a: VertexProviderAdapter): Promise<void> {
  for await (const _ of a.stream({ messages: [], tools: [] })) {
    // drain to force client construction
  }
}

describe("vertex region routing — hellgate", () => {
  test("HELL-R1: model IN map ⇒ the map's region wins over gcpLocation", async () => {
    const log: CallLog = {}
    const a = new VertexProviderAdapter(base({ model: "claude-opus-4-8" }), {
      clientFactory: recordingFactory(log),
      vertexRegionByModel: { "claude-opus-4-8": "us-east5" },
    })
    await drive(a)
    expect(log.region).toBe("us-east5")
  })

  test("HELL-R2: model NOT in map ⇒ fallback gcpLocation (byte-identical to today)", async () => {
    const log: CallLog = {}
    const a = new VertexProviderAdapter(base({ model: "claude-sonnet-4-6" }), {
      clientFactory: recordingFactory(log),
      vertexRegionByModel: { "claude-opus-4-8": "us-east5" },
    })
    await drive(a)
    expect(log.region).toBe("us-central1")
  })

  test("HELL-R3: undefined map ⇒ byte-identical single-region path", async () => {
    const log: CallLog = {}
    const a = new VertexProviderAdapter(base(), { clientFactory: recordingFactory(log) })
    await drive(a)
    expect(log.region).toBe("us-central1")
    expect(log.clientOptions).toEqual({ projectId: "my-proj", region: "us-central1" })
  })

  test("HELL-R4: empty map ⇒ byte-identical single-region path", async () => {
    const log: CallLog = {}
    const a = new VertexProviderAdapter(base(), {
      clientFactory: recordingFactory(log),
      vertexRegionByModel: {},
    })
    await drive(a)
    expect(log.region).toBe("us-central1")
  })

  test("HELL-R5: map present but model NOT in it AND no gcpLocation ⇒ still typed-fail (guard not weakened)", () => {
    try {
      new VertexProviderAdapter(base({ auth: { gcpProjectId: "p" } }), {
        vertexRegionByModel: { "some-other-model": "us-east5" },
      })
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
      expect((e as ProviderError).message).toContain("gcpLocation")
    }
  })

  test("HELL-R6: map entry coexists with explicit accessToken (region overridden, token preserved)", async () => {
    const log: CallLog = {}
    const a = new VertexProviderAdapter(
      base({
        model: "claude-opus-4-8",
        auth: { gcpProjectId: "p", gcpLocation: "us-central1", gcpAccessToken: "ya29.tok" },
      }),
      {
        clientFactory: recordingFactory(log),
        vertexRegionByModel: { "claude-opus-4-8": "europe-west1" },
      },
    )
    await drive(a)
    expect(log.clientOptions).toEqual({
      projectId: "p",
      region: "europe-west1",
      accessToken: "ya29.tok",
    })
  })

  test("HELL-R7: exact-key lookup — a near-miss slug falls through to fallback (no fuzzy match)", async () => {
    const log: CallLog = {}
    const a = new VertexProviderAdapter(base({ model: "claude-opus-4-8" }), {
      clientFactory: recordingFactory(log),
      // key differs only in case / separator — must NOT match
      vertexRegionByModel: { "claude-opus-4_8": "us-east5", "CLAUDE-OPUS-4-8": "us-west1" },
    })
    await drive(a)
    expect(log.region).toBe("us-central1")
  })
})
