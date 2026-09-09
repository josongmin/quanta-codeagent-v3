import {
  type EmbedderCapabilities,
  type EmbeddingSpace,
  embeddingSpaceNamespace,
  negotiateCapabilities,
  type SqliteDb,
  type VectorStore,
} from "@/retrieval/engines"
import { errMessage, logger } from "@/shared"
import { bindPersistedEmbeddingNamespace, bindPersistedEmbeddingSpace } from "./space-bind"

export interface ActiveVectorStoreSelection {
  readonly kind: "implicit" | "explicit"
  readonly provider: "in-memory" | "sqlite" | "lance" | "qdrant"
}

interface EmbedderCapabilitySource {
  capabilities(): Promise<EmbedderCapabilities>
}

export interface VectorRuntimeRefused {
  readonly kind: "space-refused"
  readonly reason: string
}

export const remoteNamespaceFor = (
  provider: ActiveVectorStoreSelection["provider"],
  env: Record<string, string | undefined>,
  space: EmbeddingSpace,
): string | undefined => {
  if (provider === "lance") return embeddingSpaceNamespace(env.QUANTA_LANCE_TABLE ?? "", space)
  if (provider === "qdrant") {
    return embeddingSpaceNamespace(env.QUANTA_QDRANT_COLLECTION ?? "", space)
  }
  return undefined
}

const warnStoreFailure = (selection: ActiveVectorStoreSelection, detail: string): void => {
  const provider = selection.provider
  logger.warn(
    selection.kind === "explicit"
      ? `search index ${provider} ${detail}; semantic backend disabled for explicit QUANTA_VECTOR_STORE.`
      : `search index ${provider} ${detail}; falling back to legacy in-memory index.`,
  )
}

export const reportUnavailableStore = (selection: ActiveVectorStoreSelection): void => {
  warnStoreFailure(selection, "store unavailable")
}

export const negotiateVectorStore = async (
  selection: ActiveVectorStoreSelection,
  resolvedEmbedder: EmbedderCapabilitySource,
  store: VectorStore,
): Promise<boolean> => {
  try {
    const caps = await resolvedEmbedder.capabilities()
    const negotiated = negotiateCapabilities(caps, store.capabilities())
    if (negotiated.ok) return true
    warnStoreFailure(selection, `capability mismatch (${negotiated.error.kind})`)
    return false
  } catch (error) {
    warnStoreFailure(selection, `capability negotiation failed (${errMessage(error)})`)
    return false
  }
}

export const bindRuntimeEmbeddingSpace = (
  db: SqliteDb | undefined,
  remoteNamespace: string | undefined,
  persistTable: string,
  space: EmbeddingSpace,
): VectorRuntimeRefused | null => {
  if (db === undefined) return null
  const bind =
    remoteNamespace === undefined
      ? bindPersistedEmbeddingSpace(db, persistTable, space)
      : bindPersistedEmbeddingNamespace(db, remoteNamespace, space)
  if (bind.kind === "ok") return null
  logger.warn(`search index embedding space ${bind.kind}: ${bind.reason}`)
  return { kind: "space-refused", reason: bind.reason }
}
