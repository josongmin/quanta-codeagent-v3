/**
 * `@/retrieval/multimodal` barrel — ADR-0276.
 *
 * Sibling slice to ADR-0261 (`@/retrieval/engines/embedder`). Text-only
 * embedders stay where they are; this slice adds image + audio support
 * via a 3-arm discriminated input and a separate `MultiModalEmbedder`
 * port. Default-OFF: no consumer imports this slice from a composition
 * root in the MVP — opt-in is a future ADR.
 */
export type { ClipRestOptions, FetchFn as ClipRestFetchFn } from "./clip-rest"
export { createClipRestEmbedder } from "./clip-rest"
export type { HeadlessMmOptions } from "./headless-stub"
export { createHeadlessMmEmbedder } from "./headless-stub"
export type { MultiModalEmbedder } from "./port"
export type { MmEmbedderEnv, MmEmbedProvider } from "./registry"
export {
  createMultiModalEmbedderFromEnv,
  isMmEmbedProvider,
  MM_EMBED_PROVIDERS,
} from "./registry"
export type {
  AudioBlob,
  EmbedResult,
  ImageBlob,
  MMCapabilities,
  MMEmbedError,
  Modality,
  MultiModalInput,
} from "./types"
export { ALL_MODALITIES, MM_EMBED_ERROR_KINDS } from "./types"
export type {
  FetchFn as VoyageMultiModalFetchFn,
  VoyageMultiModalOptions,
} from "./voyage-multimodal"
export { createVoyageMultiModalEmbedder } from "./voyage-multimodal"
