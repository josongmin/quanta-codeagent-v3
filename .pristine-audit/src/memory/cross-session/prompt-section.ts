/**
 * ADR-0282 — `renderMemorySection`.
 *
 * Pure renderer: takes the (already byte-capped) entry list from
 * {@link import("./port").CrossSessionInjector.selectForInject} and
 * returns a {@link MemorySystemBlock} the composition root translates
 * to an `@/llm` `SystemBlock` at the plug site.
 *
 * Format:
 *
 *   ## Cross-session memory (auto)
 *   1. <rolloutSummary of entry 0>
 *   2. <rolloutSummary of entry 1>
 *   ...
 *
 * Empty input ⇒ `{type:"text", text:"", cache:true}`. The caller is
 * responsible for skipping injection when the text is empty.
 *
 * `cache: true` — the inject is stable within a session (the trigger
 * runs at session END, the injector runs at session START; mid-session
 * promotions do NOT mutate the prompt prefix).
 */

import type { Stage1Entry } from "../stage1-store"
import { MEMORY_SECTION_HEADER, type MemorySystemBlock } from "./types"

export const renderMemorySection = (memories: readonly Stage1Entry[]): MemorySystemBlock => {
  if (memories.length === 0) {
    return { type: "text", text: "", cache: true }
  }
  const lines: string[] = [MEMORY_SECTION_HEADER]
  let i = 1
  for (const m of memories) {
    lines.push(`${i}. ${m.rolloutSummary}`)
    i++
  }
  return { type: "text", text: lines.join("\n"), cache: true }
}
