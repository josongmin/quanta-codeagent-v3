/**
 * Fast-apply fallback runner (ADR-0417).
 *
 * Builds a focused re-emit prompt, dispatches it to a fast executor model via
 * the injected side-conversation, and extracts a `*** Begin Patch` … `*** End
 * Patch` V4A block from the reply. Every failure mode (dep throw, ok:false, no
 * patch, truncated patch, aborted) collapses to a typed `{ok:false}` result —
 * NEVER throws into the caller's turn.
 */

import { errMessage } from "@/shared"
import type {
  FastApplyAttemptResult,
  FastApplyFailure,
  FastApplyFallbackDeps,
  FastApplyFallbackPort,
} from "./types"

const BEGIN = "*** Begin Patch"
const END = "*** End Patch"

/**
 * Extract a complete V4A patch block from free-form model text. Returns the
 * `*** Begin Patch` … `*** End Patch` slice (inclusive) or null when no
 * COMPLETE block is present (a truncated reply with a Begin but no End yields
 * null — never a half patch).
 */
export const extractPatchBlock = (text: string): string | null => {
  if (typeof text !== "string" || text.length === 0) return null
  const start = text.indexOf(BEGIN)
  if (start < 0) return null
  const endIdx = text.indexOf(END, start + BEGIN.length)
  if (endIdx < 0) return null
  return text.slice(start, endIdx + END.length)
}

/** Compose the focused re-emit prompt. Names V4A explicitly, states the prior
 *  failure (kind + message), and folds in the source file snapshot when given
 *  so the model can re-anchor against current content. */
export const buildFastApplyPrompt = (input: {
  failure: FastApplyFailure
  sourceFile?: string
  sourceContent?: string
}): string => {
  const { failure, sourceFile, sourceContent } = input
  const lines: string[] = [
    "Re-emit the following change as a single V4A patch (apply_patch format).",
    `The prior patch failed because [${failure.errorKind}]: ${failure.errorMessage}`,
    "",
    "Prior patch that failed:",
    failure.patch,
  ]
  if (sourceFile !== undefined) {
    lines.push("", `Target file: ${sourceFile}`)
  }
  if (sourceContent !== undefined) {
    lines.push("", "Current file content (re-anchor against this):", sourceContent)
  }
  lines.push(
    "",
    `Reply with ONLY the corrected patch, beginning with "${BEGIN}" and ending with "${END}".`,
  )
  return lines.join("\n")
}

export const createFastApplyFallback = (deps: FastApplyFallbackDeps): FastApplyFallbackPort => {
  const { roleResolver, sideConversation, defaultModel } = deps

  return {
    async attempt(input, signal): Promise<FastApplyAttemptResult> {
      if (signal?.aborted === true) {
        return { ok: false, newPatch: null, rationale: "aborted before dispatch" }
      }

      let model: string
      try {
        model = roleResolver.resolve("executor", defaultModel)
      } catch (err) {
        return {
          ok: false,
          newPatch: null,
          rationale: `role resolution failed: ${errText(err)}`,
        }
      }

      const prompt = buildFastApplyPrompt(input)

      let reply: { ok: boolean; text: string }
      try {
        reply = await sideConversation.dispatch({ prompt, model })
      } catch (err) {
        return {
          ok: false,
          newPatch: null,
          rationale: `side-conversation dispatch failed: ${errText(err)}`,
          modelUsed: model,
        }
      }

      if (reply.ok !== true) {
        return {
          ok: false,
          newPatch: null,
          rationale: "side-conversation returned a non-ok result",
          modelUsed: model,
        }
      }

      const newPatch = extractPatchBlock(reply.text)
      if (newPatch === null) {
        return {
          ok: false,
          newPatch: null,
          rationale: "model reply contained no complete V4A patch block",
          modelUsed: model,
        }
      }

      return {
        ok: true,
        newPatch,
        rationale: `re-emitted patch via ${model}`,
        modelUsed: model,
      }
    },
  }
}

const errText = (err: unknown): string => errMessage(err)
