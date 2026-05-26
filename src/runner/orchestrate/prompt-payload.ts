import type { ImageBlock } from "@/llm"

/**
 * Structured multi-modal prompt envelope for one-shot turn execution.
 * Text-only callers may keep passing a plain string; multi-modal callers
 * use the object form so images attach to that turn's user message.
 */
export type PromptPayload = string | { readonly text: string; readonly images?: ImageBlock[] }

/**
 * Normalize a {@link PromptPayload} into a stable `{ text, images }` shape.
 */
export const normalizePromptPayload = (
  payload: PromptPayload,
): { text: string; images: ImageBlock[] } => {
  if (typeof payload === "string") return { text: payload, images: [] }
  return { text: payload.text, images: payload.images ?? [] }
}
