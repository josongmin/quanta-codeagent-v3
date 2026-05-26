# ADR-0319 — System-prompt vision priority

## Context

E2E verification of the web-daemon's image-attach path (Phase 4,
2026-05-26) discovered that even after ImageBlock was correctly wired
through `src/llm/adapters/chatgpt-oauth.ts` (Phase-2.1 follow-up that had
been TODO'd since the adapter shipped), gpt-5 still answered `"이미지 없음"`
("no image") to a vision turn when the user prompt offered an escape
phrase. Inspection of the OpenAI Responses API request body confirmed:

- `input_image` part with the full data URL DID reach the wire
  (`{type: "input_image", image_url: "data:image/png;base64,…"}`).
- `promptTokens` jumped from ~6k (text-only) to ~8.2k (text + 1024px
  PNG), confirming the model received the image in its context.
- The model nonetheless replied with 7-token "이미지 없음" instead of a
  description.

When the user retried with a prompt that did NOT offer the escape phrase
(`"이 이미지에 무엇이 보이는지 한국어로 한두 문장으로 묘사해."`), the same
gpt-5 produced 79 streaming deltas of accurate visual description
("어두운 테마의 웹 브라우저 화면에서 'quanta'라는 채팅/콘솔 인터페이스가
열려 있고…"). The vision-input pipeline is correct; the model's escape
behaviour is the failure mode.

Root cause: Quanta's static system prompt sells the agent as a coding
ReAct loop. When the user attachs an image but writes an ambiguous /
escape-friendly prompt, the model prioritises "stay in coding-tool
routes" over "describe the attached image" — the system prompt gives no
explicit signal that vision input is a first-class request.

## Decision

Add a "Vision priority" block to `BODY_AFTER_PROMPT_PACK` in
`src/agent/prompt-body.ts`. The block:

1. Tells the model that when the user attaches an image, visual
   description / interpretation is a FIRST-CLASS request.
2. Forbids skipping past the image in favour of code-tool routes
   (the failure mode we observed).
3. Forbids the literal `"no image is present"` reply when an image
   attachment IS in the message — if the image is unreadable, the model
   must name the specific failure (encoding / size / clarity).

The block lives in the static prefix so it stays cache-stable (provider
prefix cache hits unchanged turn-over-turn). Image-less turns pay the
same ~12-line cost as image turns — acceptable because the lines are
generic enough to not contradict the surrounding tool-routing guidance
(they only activate when an attachment is actually present).

## Alternatives considered

1. **Dynamic system prompt** (image-aware) — only inject the vision
   priority block when the current turn carries images. Rejected:
   breaks provider prefix cache, ~5-10× cost increase on image turns,
   plus the static-prefix invariant is the whole point of the
   `BODY_AFTER_PROMPT_PACK` split.

2. **Per-turn `<system-reminder>` prepend** — the harness already injects
   turn-scoped reminders as a trailing user message. We could prepend an
   image-attached reminder there. Rejected: the static-prompt block is
   strictly stronger (L1-level rule) and cheaper to maintain — the
   reminder lane is for short-lived per-turn signals, not policy.

3. **chatgpt-oauth adapter prompt-stuffing** — adapter-level "Image
   attached" prefix on the user message before sending. Rejected:
   provider-specific surface, breaks symmetry with the Anthropic adapter,
   and conflates wire formatting with prompt policy.

## Negative invariants

- Vision priority block is STATIC — must not branch on image presence
  (would break prefix cache).
- The block does NOT introduce new tool routes, new approval tiers, new
  permission modes. It is policy-only.
- The block does NOT add anything to user-facing UX surfaces (no UI hint
  about "vision mode" — the model just behaves correctly).

## Test plan

- WS direct e2e (already used in Phase 4 verification): send `input.append`
  with text + ImageBlock; assert assistant response contains visual
  description, not "이미지 없음".
- Run with both the legacy escape-route prompt
  (`"이미지 없으면 '이미지 없음'"`) and a neutral prompt; assert the model
  describes the image in BOTH cases (the new system block overrides the
  escape route).
- Prefix-cache regression: dump `buildSystemPrompt()` output before/after
  the patch; diff is exactly the new 12-line block in
  `BODY_AFTER_PROMPT_PACK`, no other movement (provider cache hits
  preserved on all image-less turns).
