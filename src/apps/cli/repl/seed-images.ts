import type { ImageBlock } from "@/llm"
import { logger } from "@/shared"
import { loadImageBlock } from "../image-loader"
import { argvImages } from "../internal"

/** ADR-0083: resolve `--image <path>` attachments to {@link ImageBlock}s, or
 *  exit 1 with a clear message on a load failure (bad path / unsupported type /
 *  oversize). Extracted from `runRepl` so the loader's try/catch does not push
 *  that already-large function over the biome cognitive-complexity budget.
 *  Empty when no `--image` is passed (byte-identical text-only seed). */
export const loadSeedImages = (): ImageBlock[] => {
  try {
    return argvImages().map(loadImageBlock)
  } catch (e) {
    logger.error((e as Error).message)
    process.exit(1)
  }
}
