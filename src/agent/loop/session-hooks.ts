import type { Message } from "@/llm"
import type { WorkingMemory } from "@/memory"
import type { AgentConfig } from "../types"

export const emitUserPromptSubmitHook = async (
  cfg: AgentConfig,
  wm: WorkingMemory<Message>,
  sessionId: string,
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
  return null
}

export const findTrailingUserMessageIndex = (wm: WorkingMemory<Message>): number => {
  for (let i = wm.messages.length - 1; i >= 0; i--) {
    const message = wm.messages[i]
    if (message?.role === "user") return i
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
}
