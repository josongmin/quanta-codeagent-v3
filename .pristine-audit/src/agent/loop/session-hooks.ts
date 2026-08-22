import type { Message } from "@/llm"
import type { WorkingMemory } from "@/memory"
import type { HookPromptInject } from "../hooks"
import { isSyntheticUserMessage } from "../synthetic-user"
import type { AgentConfig } from "../types"

export const emitUserPromptSubmitHook = async (
  cfg: AgentConfig,
  wm: WorkingMemory<Message>,
  sessionId: string,
  // RFC09-1 DRAIN — the SAME `hookPromptPending` accumulator the `turn_start`
  // drain (turn-iteration.ts) and the plan-mode reminders push into. A command
  // hook shipped on `user_prompt_submit` returns its exit-0 stdout context on
  // `emit.promptHook`; without draining it here the bridge is INERT for its
  // intended event (the loop assembles the request from `hookPromptPending`).
  // Optional so pre-existing callers/tests that don't thread the accumulator
  // keep their old (deny/updatedPrompt-only) behavior byte-identical.
  hookPromptPending?: HookPromptInject[],
): Promise<string | null> => {
  if (cfg.hooks === undefined) return null
  const lastUserIdx = findTrailingUserMessageIndex(wm)
  if (lastUserIdx < 0) return null
  const userMsg = wm.messages[lastUserIdx]
  if (userMsg === undefined) return null
  const { promptText, attachmentsCount } = summarizeUserPrompt(userMsg)
  const emit = (await cfg.hooks.emit({
    type: "user_prompt_submit",
    prompt: promptText,
    attachmentsCount,
    threadId: sessionId,
  })) ?? { deny: null }
  if (emit.deny !== null) {
    return emit.deny.deny
  }
  if (typeof emit.updatedPrompt === "string") {
    rewriteUserPromptMessage(wm, lastUserIdx, userMsg, emit.updatedPrompt)
  }
  // Drain the accumulated `promptHook` into the SHARED pending accumulator so it
  // reaches real turn assembly. The `HookRegistry.emit` fold already bounded /
  // sanitized the inject and (for untrusted command output) restricted it to
  // `injectBeforeUser` — this site adds no new inject store, it only forwards.
  if (emit.promptHook !== undefined) hookPromptPending?.push(emit.promptHook)
  return null
}

export const findTrailingUserMessageIndex = (wm: WorkingMemory<Message>): number => {
  for (let i = wm.messages.length - 1; i >= 0; i--) {
    const message = wm.messages[i]
    // ALBB-20 #10 — SKIP synthetic user messages (focus-chain / turn-budget /
    // identity reminders appended at the tail via `makeSyntheticUserMessage`).
    // Without this filter a trailing synthetic reminder was misread as the
    // operator's real prompt and fed to the `user_prompt_submit` hook. Reuse the
    // EXISTING `isSyntheticUserMessage` predicate (SSOT) — the same skip the
    // recall-query / context-injection walks already apply.
    if (message?.role === "user" && !isSyntheticUserMessage(message)) return i
  }
  return -1
}

export const summarizeUserPrompt = (
  userMsg: Message,
): { readonly promptText: string; readonly attachmentsCount: number } => {
  let promptText = ""
  let attachmentsCount = 0
  for (const block of userMsg.content) {
    if (block.type === "text") {
      promptText = promptText.length > 0 ? `${promptText}\n${block.text}` : block.text
    } else {
      attachmentsCount += 1
    }
  }
  return { promptText, attachmentsCount }
}

export const rewriteUserPromptMessage = (
  wm: WorkingMemory<Message>,
  lastUserIdx: number,
  userMsg: Message,
  newText: string,
): void => {
  let rewritten = false
  const newContent = userMsg.content.map((block) => {
    if (!rewritten && block.type === "text") {
      rewritten = true
      return { ...block, text: newText }
    }
    return block
  })
  if (!rewritten) newContent.unshift({ type: "text", text: newText })
  wm.messages[lastUserIdx] = { ...userMsg, content: newContent }
  // This in-place element write bypasses `append`/`replace`, so the delta-token
  // counter (when wired, knob ON) would not observe the char-count change.
  // Re-anchor it to the live snapshot to keep `tokenTotal()` byte-identical to a
  // full `estimateTokens` re-scan. No-op (method absent) when the knob is OFF.
  ;(wm as WorkingMemory<Message> & { tokenReseed?(): void }).tokenReseed?.()
}
