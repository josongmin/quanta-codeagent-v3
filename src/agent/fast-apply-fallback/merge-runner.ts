/**
 * Fast-apply MERGE runner (jun-7-misc 06, ADR ≥0497).
 *
 * Sibling to `runner.ts` (the V4A re-emit). Builds the `{original, editSketch}`
 * → merged-full-file prompt (Cursor 3.5.33's REWRITE/apply IO shape — naming the
 * `// ... existing code ...` elision convention), dispatches it to a DEDICATED
 * apply model via the injected side-conversation, extracts the merged file from
 * the reply, and runs a conservative STRUCTURAL verification. Every failure mode
 * (dep throw, ok:false, empty reply, verification miss, aborted) collapses to a
 * typed `{ ok:false, merged:null }` — it NEVER throws into the caller's turn.
 *
 * The merge is a PROPOSAL, never a blind write (ticket §4.c). This runner only
 * checks the merge is structurally sane (non-empty, actually changed the file);
 * the CONSUMER (the `edit` tool) applies the edit-scoped bounded check AND routes
 * the result through the SAME gated commit + diff-sink path as any edit. So even
 * a runner that returned `ok:true` on garbage can never reach disk unverified.
 */

import { errMessage } from "@/shared"
import type { FastApplyMergeDeps, FastApplyMergeResult, FastApplyPort } from "./types"

/** The fenced block the apply model is asked to wrap the merged file in, so the
 *  reply is unambiguous to extract even when the model adds prose around it. */
const FENCE = "```"
const MERGED_OPEN = "```merged"

/**
 * Extract the merged file from the apply model's reply. Prefers an explicit
 * ` ```merged … ``` ` fence (what the prompt asks for); falls back to the FIRST
 * generic fenced block; finally to the whole trimmed reply when the model
 * answered with the bare file and no fence. Returns null only for an empty
 * reply or an UNCLOSED fence (never a half file — parity with the re-emit
 * runner's truncation guard).
 */
export const extractMergedFile = (text: string): string | null => {
  if (typeof text !== "string" || text.length === 0) return null
  // 1) explicit ```merged … ``` fence.
  const tagged = extractFenced(text, MERGED_OPEN)
  if (tagged !== null) return tagged
  // 2) first generic ``` … ``` fence (allow a language tag on the open line).
  const generic = extractFirstGenericFence(text)
  if (generic !== null) return generic
  // 3) bare file, no fence — but if a fence was OPENED and never closed, that is
  //    a truncated reply; refuse it rather than return a partial file.
  if (text.includes(FENCE)) return null
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Extract the body of a fenced block opened with EXACTLY `open` (e.g.
 *  ` ```merged `) and closed by the next ` ``` ` on its own. Null when the open
 *  marker is absent or the closing fence is missing (truncated). */
const extractFenced = (text: string, open: string): string | null => {
  const start = text.indexOf(open)
  if (start < 0) return null
  // Body begins after the open marker's line.
  const afterOpen = text.indexOf("\n", start)
  if (afterOpen < 0) return null
  const closeIdx = text.indexOf(`\n${FENCE}`, afterOpen + 1)
  if (closeIdx < 0) return null
  return text.slice(afterOpen + 1, closeIdx)
}

/** Extract the first generic ` ``` … ``` ` block (open line may carry a language
 *  tag like ` ```ts `). Null when no complete block is present. */
const extractFirstGenericFence = (text: string): string | null => {
  const open = text.indexOf(FENCE)
  if (open < 0) return null
  const afterOpen = text.indexOf("\n", open)
  if (afterOpen < 0) return null
  const closeIdx = text.indexOf(`\n${FENCE}`, afterOpen + 1)
  if (closeIdx < 0) return null
  return text.slice(afterOpen + 1, closeIdx)
}

/**
 * Compose the apply/merge prompt. Names the `// ... existing code ...` elision
 * convention (Cursor's apply IO shape), hands the model the ORIGINAL file
 * verbatim + the terse edit sketch, and asks for the FULL merged file as the
 * ONLY output (REWRITE flavor), wrapped in a ` ```merged ` fence. Deterministic
 * intent ("do not invent, do not drop, do not reorder") is stated so the model
 * resolves elisions against the original rather than re-authoring.
 */
export const buildMergePrompt = (input: {
  original: string
  editSketch: string
  path?: string
}): string => {
  const { original, editSketch, path } = input
  const lines: string[] = [
    "You are a fast APPLY model. Merge the terse edit below INTO the original",
    "file and return the COMPLETE merged file — every unchanged line preserved",
    "verbatim, only the edited region changed.",
    "",
    "The edit uses `// ... existing code ...` to elide unchanged regions: expand",
    "each elision back to the EXACT original lines it stands for. Do NOT drop,",
    "reorder, summarize, or invent any code. Do NOT add commentary.",
  ]
  if (path !== undefined) {
    lines.push("", `Target file: ${path}`)
  }
  lines.push(
    "",
    "Original file:",
    `${FENCE}`,
    original,
    `${FENCE}`,
    "",
    "Terse edit to apply:",
    `${FENCE}`,
    editSketch,
    `${FENCE}`,
    "",
    `Reply with ONLY the full merged file, wrapped exactly as:\n${MERGED_OPEN}\n<full merged file>\n${FENCE}`,
  )
  return lines.join("\n")
}

/**
 * STRUCTURAL verification of a merged file (conservative, deterministic — no
 * model, no magic threshold). Returns the rejection reason, or null when the
 * merge passes. This is the runner-level backstop; the consumer adds the
 * edit-scoped bounded check + the normal gate.
 *
 * Rejects:
 *   - empty / whitespace-only merge (a model that dropped the whole file),
 *   - a merge byte-identical to the original (the edit did not land — surfacing
 *     it as a success would mask a no-op apply),
 *   - a merge that still literally contains the elision marker (the model
 *     copied the sketch instead of expanding it).
 */
export const verifyMergeStructural = (original: string, merged: string): string | null => {
  if (merged.trim().length === 0) return "merged file is empty"
  if (merged === original) return "merged file is identical to the original (no edit landed)"
  if (merged.includes("// ... existing code ...")) {
    return "merged file still contains the elision marker (sketch not expanded)"
  }
  return null
}

export const createFastApplyMerge = (deps: FastApplyMergeDeps): FastApplyPort => {
  const { roleResolver, sideConversation, applyModel } = deps

  return {
    async apply(input, signal): Promise<FastApplyMergeResult> {
      if (signal?.aborted === true) {
        return { ok: false, merged: null, rationale: "aborted before dispatch" }
      }

      let model: string
      try {
        model = roleResolver.resolve("apply", applyModel)
      } catch (err) {
        return {
          ok: false,
          merged: null,
          rationale: `apply-role resolution failed: ${errMessage(err)}`,
        }
      }

      const prompt = buildMergePrompt(input)

      let reply: { ok: boolean; text: string }
      try {
        reply = await sideConversation.dispatch({ prompt, model })
      } catch (err) {
        return {
          ok: false,
          merged: null,
          rationale: `apply-model dispatch failed: ${errMessage(err)}`,
          modelUsed: model,
        }
      }

      if (reply.ok !== true) {
        return {
          ok: false,
          merged: null,
          rationale: "apply-model returned a non-ok result",
          modelUsed: model,
        }
      }

      const merged = extractMergedFile(reply.text)
      if (merged === null) {
        return {
          ok: false,
          merged: null,
          rationale: "apply-model reply contained no complete merged file",
          modelUsed: model,
        }
      }

      const structuralReject = verifyMergeStructural(input.original, merged)
      if (structuralReject !== null) {
        return {
          ok: false,
          merged: null,
          rationale: `merge verification failed: ${structuralReject}`,
          modelUsed: model,
        }
      }

      return {
        ok: true,
        merged,
        rationale: `merged via apply model ${model}`,
        modelUsed: model,
      }
    },
  }
}
