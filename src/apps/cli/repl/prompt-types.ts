import type { ImageBlock } from "@/llm"

export type CliPromptInput =
  | string
  | { readonly text: string; readonly images?: readonly ImageBlock[] }

export interface CliPromptSource {
  next(signal?: AbortSignal): Promise<CliPromptInput | null>
}

export const normalizeCliPromptInput = (
  input: CliPromptInput,
): { readonly text: string; readonly images: readonly ImageBlock[] } =>
  typeof input === "string"
    ? { text: input, images: [] }
    : { text: input.text, images: input.images ?? [] }
