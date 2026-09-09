import { createHash } from "node:crypto"
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

export interface RemoteVectorOwner {
  readonly key: string
  readonly provider: "lance" | "qdrant"
  readonly transportEndpoint: string
  readonly endpointFingerprint: string
  readonly namespace: string
}

const canonicalTransportEndpoint = (raw: string): string => {
  try {
    const url = new URL(raw)
    url.hash = ""
    url.search = ""
    url.pathname = url.pathname.replace(/\/+$/u, "")
    return url.toString().replace(/\/$/u, "")
  } catch {
    return raw.replace(/\/+$/u, "")
  }
}

const endpointFingerprint = (transportEndpoint: string): string => {
  // Hash the complete canonical transport identity, including userinfo, so
  // credential-scoped tenants never share a manifest. Only the digest is
  // persisted; plaintext credentials never cross the sidecar boundary.
  return `qep_${createHash("sha256").update(transportEndpoint).digest("hex").slice(0, 32)}`
}

const remoteOwnerKey = (provider: string, endpointIdentity: string, namespace: string): string =>
  `qro_${createHash("sha256")
    .update(provider)
    .update("\0")
    .update(endpointIdentity)
    .update("\0")
    .update(namespace)
    .digest("hex")
    .slice(0, 32)}`

export const remoteVectorOwnerFor = (
  provider: ActiveVectorStoreSelection["provider"],
  env: Record<string, string | undefined>,
  space: EmbeddingSpace,
): RemoteVectorOwner | undefined => {
  if (provider === "lance") {
    const base = env.QUANTA_LANCE_TABLE
    const endpoint = env.QUANTA_LANCE_BASE_URL
    if (base === undefined || base === "" || endpoint === undefined || endpoint === "") {
      return undefined
    }
    const transportEndpoint = canonicalTransportEndpoint(endpoint)
    const endpointIdentity = endpointFingerprint(transportEndpoint)
    const namespace = embeddingSpaceNamespace(base, space)
    return {
      key: remoteOwnerKey(provider, endpointIdentity, namespace),
      provider,
      transportEndpoint,
      endpointFingerprint: endpointIdentity,
      namespace,
    }
  }
  if (provider === "qdrant") {
    const base = env.QUANTA_QDRANT_COLLECTION
    if (base === undefined || base === "") return undefined
    const transportEndpoint = canonicalTransportEndpoint(
      env.QUANTA_QDRANT_BASE_URL ?? "http://localhost:6333",
    )
    const endpointIdentity = endpointFingerprint(transportEndpoint)
    const namespace = embeddingSpaceNamespace(base, space)
    return {
      key: remoteOwnerKey(provider, endpointIdentity, namespace),
      provider,
      transportEndpoint,
      endpointFingerprint: endpointIdentity,
      namespace,
    }
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
  remoteOwner: RemoteVectorOwner | undefined,
  persistTable: string,
  space: EmbeddingSpace,
): VectorRuntimeRefused | null => {
  if (db === undefined) return null
  const bind =
    remoteOwner === undefined
      ? bindPersistedEmbeddingSpace(db, persistTable, space)
      : bindPersistedEmbeddingNamespace(db, remoteOwner, space)
  if (bind.kind === "ok") return null
  logger.warn(`search index embedding space ${bind.kind}: ${bind.reason}`)
  return { kind: "space-refused", reason: bind.reason }
}
