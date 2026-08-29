/**
 * A minimal REAL `ModelRoutingAuthority` for tests that need one collaborator,
 * not a whole composition root (MR-02).
 *
 * It is the production `createModelRoutingAuthority` over an in-memory store and
 * a hand-listed catalog — deliberately not a hand-written fake, so a test using it
 * exercises the same precedence, validation and publish-after-write path the
 * shipping surfaces do. Callers that need the FULL assembly (admission from a real
 * file, eager candidate seeding, session scoping) should use
 * `createModelRoutingSession` instead.
 */

import type { ModelRoutingAuthority, ModelRoutingMode } from "@/agent/model-routing"
import { admitPersistedPicks, createModelRoutingAuthority } from "@/agent/model-routing/authority"
import { inMemoryStickyModelStore, type StickyModelStore } from "@/agent/sticky-model"
import type { LLMPort, Provider } from "@/llm"

export const fakeModelRouting = (args: {
  readonly bootModelId: string
  /** Every offerable id INCLUDING the boot model (what a picker renders). */
  readonly ids: readonly string[]
  readonly mode?: () => ModelRoutingMode
  readonly provider?: Provider
  readonly store?: StickyModelStore
  readonly pinned?: boolean
  readonly persisted?: Readonly<Record<string, string>>
}): { readonly routing: ModelRoutingAuthority; readonly store: StickyModelStore } => {
  const provider = args.provider ?? "openai"
  const store = args.store ?? inMemoryStickyModelStore()
  const port = (model: string): LLMPort => ({ model }) as unknown as LLMPort
  const candidates = args.ids
    .filter((id) => id !== args.bootModelId)
    .map((id) => ({ id, port: port(id) }))
  return {
    store,
    routing: createModelRoutingAuthority({
      store,
      catalog: { candidates, ids: () => args.ids, refresh: async () => undefined },
      provider,
      bootModelId: args.bootModelId,
      bootPort: port(args.bootModelId),
      mode: args.mode ?? ((): ModelRoutingMode => "default"),
      pinned: args.pinned ?? false,
      admitted: admitPersistedPicks(args.persisted ?? {}, provider),
    }),
  }
}
