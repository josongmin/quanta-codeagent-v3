/* LLM-backed permission auto-mode ClassifierPort.
 *
 * The 2-stage orchestration + denial-limit state lives in @/permission's
 * AutoModeClassifier. This module supplies the single round-trip ClassifierPort
 * that orchestrator calls once per (stage). It:
 *   - forwards `req.systemPrompt` (CLASSIFIER_SYSTEM_PROMPT + the stage tail,
 *     already assembled by the permission slice) as a cached SystemBlock so the
 *     provider's ~1h prompt cache holds across calls (mirrors prompt.ts
 *     buildTurnContext: a single byte-stable block flagged cache:true);
 *   - sends one user message: the tool name + canonical-JSON input wrapped in a
 *     <transcript>, with optional recentContext as prior context;
 *   - streams via llm.stream, assembles with assembleFromEvents, and parses the
 *     XML verdict (<block>no> ⇒ allow; <block>yes> + <reason> ⇒ block);
 *   - never throws — any failure (stream error or unparseable reply) fails safe
 *     to a block;
 *   - memoizes deterministic verdicts in an in-memory TTL cache (default ~1h)
 *     keyed by a stable hash of (tool + canonical-JSON input + stage).
 */

import {
  assembleFromEvents,
  type LLMPort,
  type Message,
  type StreamEvent,
  type SystemBlock,
} from "@/llm"
import type { ClassifierPort, ClassifyDecision, ClassifyRequest } from "@/permission"

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000 // ~1h, matches the provider cache window

export interface AutoClassifierOptions {
  llm: LLMPort
  /** TTL for the deterministic-verdict cache. Default ~1h. */
  cacheTtlMs?: number
  /** Injectable clock (ms epoch) for deterministic cache-expiry tests. */
  now?: () => number
}

interface CacheEntry {
  decision: ClassifyDecision
  expiresAt: number
}

/** Stable, order-independent JSON for cache keying. Objects get sorted keys so
 *  semantically identical inputs collide; arrays preserve order. */
const canonicalJson = (value: unknown): string => {
  const seen = new WeakSet<object>()
  const enc = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
    if (seen.has(v as object)) return '"[circular]"'
    seen.add(v as object)
    if (Array.isArray(v)) return `[${v.map(enc).join(",")}]`
    const obj = v as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${enc(obj[k])}`).join(",")}}`
  }
  return enc(value)
}

/** Stable string key for (tool + canonical input + stage). djb2 over the
 *  canonical composite — collision-resistant enough for an in-process cache and
 *  cheap with no deps. */
const cacheKey = (req: ClassifyRequest): string => {
  const composite = `${req.tool}\x00${canonicalJson(req.input)}\x00${req.stage ?? "none"}`
  let h = 5381
  for (let i = 0; i < composite.length; i++) h = ((h << 5) + h + composite.charCodeAt(i)) | 0
  return `c${(h >>> 0).toString(36)}:${composite.length}`
}

/** Build the single user message: the action under review wrapped in a
 *  <transcript>, optionally preceded by prior context. */
const buildUserMessage = (req: ClassifyRequest): Message => {
  const action = `${req.tool} ${canonicalJson(req.input)}`
  const ctx = req.recentContext?.trim()
  const transcript = ctx ? `${ctx}\n${action}` : action
  return {
    role: "user",
    content: [{ type: "text", text: `<transcript>\n${transcript}\n</transcript>` }],
  }
}

const tagContent = (text: string, tag: string): string | undefined => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`, "i").exec(text)
  if (m === null) return undefined
  const captured = m[1]
  return captured === undefined ? undefined : captured.trim()
}

const FAILSAFE: ClassifyDecision = {
  verdict: "block",
  reason: "classifier response unparseable (failed safe)",
}

/** Map the model's XML reply to a ClassifyDecision. The doc's output contract:
 *    allowed → `<block>no</block>` (no <reason>)
 *    blocked → `<block>yes</block><reason>one short sentence</reason>`
 *  Stage 1 may be cut at `</block>` by a stop sequence, so the closing tag can
 *  be absent. Parse robustly:
 *   - a clear "no" inside <block> ⇒ allow;
 *   - a clear "yes" inside <block> ⇒ block, using <reason> if present;
 *   - anything else (no <block>, ambiguous token) ⇒ fail-safe block.
 *  `deterministic` reports whether the verdict came from an unambiguous reply
 *  (cacheable) vs. a fail-safe guess (never cached — a transient bad stream
 *  must not poison the cache for an hour). */
const parseDecision = (raw: string): { decision: ClassifyDecision; deterministic: boolean } => {
  const block = tagContent(raw, "block")
  if (block === undefined) return { decision: FAILSAFE, deterministic: false }
  const norm = block.toLowerCase().replace(/[^a-z]/g, "")
  if (norm === "no" || norm.startsWith("no")) {
    return { decision: { verdict: "allow", reason: "Allowed by classifier" }, deterministic: true }
  }
  if (norm === "yes" || norm.startsWith("yes")) {
    const reason = tagContent(raw, "reason")
    return {
      decision: {
        verdict: "block",
        reason: reason && reason.length > 0 ? reason : "Blocked by classifier",
      },
      deterministic: true,
    }
  }
  return { decision: FAILSAFE, deterministic: false }
}

/**
 * Build an LLM-backed {@link ClassifierPort}. One invocation = one streamed
 * model round-trip (plus an in-memory TTL memo for repeat identical requests).
 *
 * @param opts.llm        the LLMPort to stream through
 * @param opts.cacheTtlMs deterministic-verdict cache TTL (default ~1h)
 * @param opts.now        injectable ms-epoch clock for tests
 */
export const createAutoClassifierPort = (opts: AutoClassifierOptions): ClassifierPort => {
  const { llm } = opts
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const clock = opts.now ?? Date.now
  const cache = new Map<string, CacheEntry>()

  return async (req: ClassifyRequest): Promise<ClassifyDecision> => {
    const key = cacheKey(req)
    const hit = cache.get(key)
    if (hit) {
      if (hit.expiresAt > clock()) return hit.decision
      cache.delete(key)
    }

    const system: SystemBlock[] = [{ type: "text", text: req.systemPrompt, cache: true }]
    const input = { messages: [buildUserMessage(req)], system, tools: [] }

    let raw: string
    try {
      const events: StreamEvent[] = []
      for await (const ev of llm.stream(input)) events.push(ev)
      const { message } = assembleFromEvents(events)
      raw = message.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim()
    } catch {
      // Stream failure: fail safe, do NOT cache (transient — retry may differ).
      return FAILSAFE
    }

    const { decision, deterministic } = parseDecision(raw)
    if (deterministic) cache.set(key, { decision, expiresAt: clock() + ttl })
    return decision
  }
}
