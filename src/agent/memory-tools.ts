import { z } from "zod"
import {
  EMBED_DIM,
  type EmbedderPort,
  type MemoryEntry,
  type MemoryKind,
  type MemoryQuery,
  type PersistentStorePort,
} from "@/memory"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

/**
 * Self-edit memory tools (RFC §6.3, SOTA++ memory). Let the model search,
 * write, and revise its own durable memory mid-session. Every `execute` is
 * defensive: any failure yields a single `ok:false` result rather than
 * throwing out of the generator (the dispatcher must never see a throw).
 */

export interface MemoryToolsDeps {
  store: PersistentStorePort
  embedder?: EmbedderPort
}

/** Embed `text`, returning the vector only if it is the expected dimension. */
const tryEmbed = async (
  embedder: EmbedderPort | undefined,
  text: string,
): Promise<number[] | undefined> => {
  if (!embedder) return undefined
  try {
    const [vec] = await embedder.embed([text])
    return vec && vec.length === EMBED_DIM ? vec : undefined
  } catch {
    return undefined
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const searchSchema = z.object({
  query: z.string().describe("Free-text query; semantic when an embedder is configured."),
  limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)."),
})
type SearchInput = z.infer<typeof searchSchema>

const writeSchema = z.object({
  text: z.string().min(1).describe("The durable statement to remember."),
  kind: z
    .enum(["fact", "decision", "observation", "preference"])
    .optional()
    .describe("Memory kind (default observation)."),
  tags: z.array(z.string()).optional().describe("Short lowercase topic tags."),
  importance: z.number().min(0).max(1).optional().describe("Value weight 0..1 (default 0.6)."),
})
type WriteInput = z.infer<typeof writeSchema>

const updateSchema = z.object({
  id: z.string().describe("Id of the memory to revise."),
  text: z.string().optional().describe("New text (triggers re-embedding)."),
  tags: z.array(z.string()).optional().describe("Replacement tags."),
  importance: z.number().min(0).max(1).optional().describe("New importance 0..1."),
  delete: z.boolean().optional().describe("Hard-delete the entry instead of patching."),
})
type UpdateInput = z.infer<typeof updateSchema>

/** Build the three self-edit memory tools bound to a store (+ optional embedder). */
export const memoryTools = (deps: MemoryToolsDeps): Tool[] => {
  const memorySearch: Tool<SearchInput> = {
    name: "memory_search",
    description: "Search durable long-term memory for entries relevant to a query. Read-only.",
    inputSchema: searchSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input: SearchInput, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      try {
        const limit = input.limit ?? 5
        const embedding = await tryEmbed(deps.embedder, input.query)
        const query: MemoryQuery = { text: input.query, limit }
        if (embedding) query.embedding = embedding
        const entries = await deps.store.recall(query)
        if (entries.length === 0) {
          yield { type: "result", result: { ok: true, output: "No matching memories." } }
          return
        }
        const lines = entries.map(
          (e) => `#${e.id} (${e.kind}, ${(e.importance ?? 0.5).toFixed(2)}) ${e.text}`,
        )
        yield { type: "result", result: { ok: true, output: lines.join("\n") } }
      } catch (e) {
        yield {
          type: "result",
          result: { ok: false, output: `memory_search failed: ${errMsg(e)}` },
        }
      }
    },
  }

  const memoryWrite: Tool<WriteInput> = {
    name: "memory_write",
    description:
      "Save a new durable memory (fact/decision/observation/preference) for future sessions.",
    inputSchema: writeSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute(input: WriteInput, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      try {
        const kind: MemoryKind = input.kind ?? "observation"
        const id = `mem:tool:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
        const entry: MemoryEntry = {
          id,
          kind,
          tier: "semantic",
          text: input.text,
          tags: input.tags ?? [],
          importance: input.importance ?? 0.6,
          createdAt: Date.now(),
        }
        const embedding = await tryEmbed(deps.embedder, input.text)
        if (embedding) entry.embedding = embedding
        await deps.store.save(entry)
        yield { type: "result", result: { ok: true, output: `Saved memory ${id}.` } }
      } catch (e) {
        yield {
          type: "result",
          result: { ok: false, output: `memory_write failed: ${errMsg(e)}` },
        }
      }
    },
  }

  const memoryUpdate: Tool<UpdateInput> = {
    name: "memory_update",
    description: "Revise or delete an existing durable memory by id.",
    inputSchema: updateSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute(input: UpdateInput, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      try {
        const existing = await deps.store.get(input.id)
        if (!existing) {
          yield {
            type: "result",
            result: { ok: false, output: `Unknown memory id: ${input.id}` },
          }
          return
        }
        if (input.delete) {
          await deps.store.delete(input.id)
          yield { type: "result", result: { ok: true, output: `Deleted ${input.id}.` } }
          return
        }
        const patch: Partial<MemoryEntry> = {}
        if (input.text !== undefined) {
          patch.text = input.text
          const embedding = await tryEmbed(deps.embedder, input.text)
          if (embedding) patch.embedding = embedding
        }
        if (input.tags !== undefined) patch.tags = input.tags
        if (input.importance !== undefined) patch.importance = input.importance
        await deps.store.update(input.id, patch)
        yield { type: "result", result: { ok: true, output: `Updated ${input.id}.` } }
      } catch (e) {
        yield {
          type: "result",
          result: { ok: false, output: `memory_update failed: ${errMsg(e)}` },
        }
      }
    },
  }

  return [memorySearch as Tool, memoryWrite as Tool, memoryUpdate as Tool]
}
