# ADR-0311 — GitHub Actions trigger adapter (Tier 0 PR webhook bot)

- **Status**: accepted (2026-05-26)
- **Related**: [[0132-autonomous-proactive-reactor]] (TriggerSourcePort SoT), [[0078-secret-redaction-content-plane-invariant]] (`@/security` source), [[may-23-git-axis-absorption]] (gh CLI port shape), [[0312-github-app-webhook-host-scaffold]] (Tier-1 sibling), [[0313-pr-output-sink-redaction]] (output sink), [[0314-mention-filter-trust-scope]] (mention gate)
- **References**:
  - Codex `codex-action` (issue_comment + pull_request_review + workflow_dispatch handler shape)
  - Cursor BugBot (`@cursor review` mention vocabulary, code-block exclusion)
  - Anthropic claude-code-action (delivery-id dedup + trust-scope gating)

## Problem

quanta는 `gh pr checks` / `gh api comments` 폴링 외에는 GitHub의 능동적 신호를 받지 못한다. Codex/Cursor/Claude Code는 GitHub Action runner에서 `GITHUB_EVENT_PATH` JSON을 ONCE 읽어 self-trigger하는 1-shot 어댑터를 이미 정착시켰다. quanta는 같은 자리에 first-party slice가 비어 있어 사용자가 외부에서 prompt를 짜 넣어야 한다.

## Decision

`src/integrations/github/` 신규 leaf slice. 핵심 entry: `createActionsEventSource(opts) → TriggerSourcePort`.

- 모든 IO는 port: `FsPort` (event JSON), `EnvPort` (env var 5종), `ClockPort`, `GhCliPort`(컨텍스트 로더 측)
- **default-OFF**: `EnvPort.get("QUANTA_GH_ACTIONS_TRIGGER") !== "1"` ⇒ poll 빈 배열
- **6 closed event kind**: `issue_comment` / `pull_request_review_comment` / `pull_request_review` / `pull_request` / `issues` / `workflow_dispatch` (`ALL_GH_EVENT_KINDS` 상수, 추가는 컴파일 에러)
- **dedup**: `DeliveryStore`(1024 cap FIFO) — `GITHUB_DELIVERY` 키. 두 번째 poll은 무조건 빈 배열
- **trust scope**: `MentionFilter` `requireTrustScope: "collaborator"` 기본 — `author_association` 기반 즉시 차단
- **self-loop 방지**: `sender.type === "Bot"` 차단 + 우리 idempotency marker(`<!-- quanta:idempotency=`)가 body에 있으면 mention false
- **evidence anchor**: 모든 `ProactiveTrigger.evidence`는 PR html_url (`kind: "url"`)
- **size cap**: event JSON 10MB, simulatedMessage snippet 280자
- 어떤 hostile input(빈 JSON / 100MB payload / NUL byte / 알 수 없는 sender.type)도 throw하지 않고 빈 배열

핵심 슬라이스 파일:

- [[../../src/integrations/github/event-payload.ts]] — `parseGhEventFile` + `normalizeGhEvent` (6 kind exhaustive switch)
- [[../../src/integrations/github/event-source-actions.ts]] — `createActionsEventSource` (default-OFF + dedup)
- [[../../src/integrations/github/mention-filter.ts]] — `matchMention` + `createMentionFilter` (code-block / blockquote exclude)
- [[../../src/integrations/github/idempotency.ts]] — `createDeliveryStore` + `computeIdempotencyKey`
- [[../../src/integrations/github/pr-context-loader.ts]] — 4-shot gh bundle into `PrContext`
- [[../../src/integrations/github/pr-output-sink.ts]] — `createPrOutputSink` (자매조 [[0313-pr-output-sink-redaction]])
- [[../../src/integrations/github/index.ts]] — slice barrel + `ALL_GH_EVENT_KINDS` 상수
- [[../../src/apps/cli/from-pr-cmd.ts]] — `runFromPrCmd` lib entry (port-only)
- [[../../src/apps/cli/from-pr-cmd-adapters.ts]] — production adapter set (node:fs / Bun.spawn / `@/security`)

## Consequences

- 사람 안 보이는 자리(GH Actions runner) 진입 1줄: composition root가 `createActionsEventSource(...)`를 `apps/agent/mode-presets/daemon.ts`의 trigger source 슬롯에 wire. 호스트는 OUT OF REPO ([[surface-model]]).
- 새 PR 봇 모드(`gh pr review` 자동 응답)가 dedup + trust scope + bot guard 세 겹 방어로 default-OFF 시작.
- `pr-context-loader`는 어느 gh 콜이라도 fail 시 `undefined` — partial PrContext는 surface하지 않는다 ([[no-heuristics-only-validated]] 적용: 불완전 컨텍스트로 추론 금지).
- Tier 1 webhook(외부 호스트) 진입은 [[0312-github-app-webhook-host-scaffold]]에서 분리. Signature 검증은 이미 [[../../src/integrations/github/signature-verify.ts]]에 wire되어 있다.
- 62 hellgate 케이스(이벤트 malformed 13 + 멘션 필터 17 + 시그니처 15 + 출력 sink 9 + idempotency 8)로 회귀 봉인. 추가로 R2 fuzz/state/cap 배터리 6개(`*-r2.test.ts`)로 보완.
- 워크플로 템플릿 [[../../.github/workflows/quanta-pr-bot.yml.template]] + 사용자 가이드 [[../../docs/integrations/github/SETUP.md]]로 외부 진입 표면 마감. 운영자 시각 슬라이스 차트는 [[../../docs/integrations/github/README.md]].

## Negative invariants

- pr-output-sink는 redactPort 없이는 **construct 자체를 거부** ([[0313-pr-output-sink-redaction]] 본 결정의 자매조).
- mention filter는 phrase가 코드블록(```...```) 또는 인라인 코드(`` ` ``) 또는 blockquote(`>`) 안에 있으면 무조건 false.
- bot sender의 mention은 `allowBots=true` 명시가 없으면 자동 거부 — self-loop도 dependabot wake도 둘 다 방지.
