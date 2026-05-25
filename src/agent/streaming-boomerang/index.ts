/**
 * Streaming boomerang slice barrel (ADR-0251).
 *
 * Closed surface for parent ↔ child progressive consumption (Roo
 * Boomerang absorption). Default-OFF: the loop never constructs a
 * streamer; callers (apps / tier1 builders / future CLI) opt in by
 * wiring through AgentConfig. Sibling of ADR-0218 — the two slices are
 * independently consumable and do not import each other.
 */

export {
  type ChunkProducer,
  type DefaultStreamerOpts,
  defaultStreamer,
} from "./default-streamer"
export type {
  StreamingBoomerang,
  StreamingBoomerangSpec,
} from "./port"
export {
  BOOMERANG_CHUNK_KINDS,
  BOOMERANG_ERROR_KINDS,
  type BoomerangChunk,
  type BoomerangChunkErrorKind,
  type BoomerangErrorChunk,
  type BoomerangProgressChunk,
  type BoomerangResultChunk,
  type ChunkProducerHandle,
  StreamingBoomerangError,
} from "./types"
