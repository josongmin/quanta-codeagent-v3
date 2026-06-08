/**
 * `image-gen` slice barrel (H14a) — text→image generation + edit.
 *
 * The first binary-ARTIFACT-GENERATION tool in quanta (a NEW category beyond
 * the read-only `read_image*` / document `*-read` tools). Default-OFF: the
 * composition root registers it only when `DefaultToolPorts.imageGen` is wired
 * (gated behind `QUANTA_IMAGE_GEN`), passing a key-bound provider port.
 */

export type {
  GeneratedImage,
  ImageAspectRatio,
  ImageGenFormat,
  ImageGenOutcome,
  ImageGenPort,
  ImageGenRequest,
  OpenAiImagePortOptions,
} from "./port"
export { openAiImagePort } from "./port"
export type { ImageWritePort } from "./store"
export { defaultImageWritePort } from "./store"
export type { ImageGenInput, ImageGenToolOptions } from "./tool"
export {
  IMAGE_GEN_MAX_BYTES,
  IMAGE_GEN_MAX_N,
  imageGenInputSchema,
  imageGenTool,
} from "./tool"
