# Codex Round-5 Implementation Ship Note (2026-05-21)

Round-4 deep-dive (`may-21-codex-desktop-build-2867-round-4.md`) → 추천 P1 6개 중 비중복 4개를 4-Agent worktree 병렬 구현 → main cherry-pick.

## 결과 요약

| Feature | ADR | 출처 영감 | Main commit |
|---|---|---|---|
| `progress-audit` system skill | 0045 | Codex `~/.codex/memories/skills/code-only-progress-audit/SKILL.md` verbatim adaptation | `49c9c02` |
| `response.in_progress` SSE event | 0048 | Codex forward-compat gap (Codex silent-drops this) | `51f3149` |
| Side-conversation seam | 0049 | Codex side-conversation assistant prompt verbatim + `codex.thread.side` (우리는 `quanta.thread.side`) | `51f3149` |
| Permission stack (per-thread + per-host + post-denial) | 0046 | Codex `heartbeat-thread-permissions-by-id` + `agent-mode-by-host-id` + Guardian "Post-denial precedence" | `cab1ae5` |
| HITL 4-tier gate | 0047 | Codex Computer Use SKILL.md (Tier rubric) | `2540a09` |

## 4-Agent worktree 분담

각 Agent는 `worktree-agent-<id>` branch에서 격리 작업, 완료 후 main에 cherry-pick.

```
worktree-agent-a187e0b... (ee0aa5d) → cherry-pick → 49c9c02   (progress-audit)
worktree-agent-ac145597... (e88e0d4) → cherry-pick → 51f3149   (streaming + side-convo)
worktree-agent-a15891ab... (55f77a4) → cherry-pick → cab1ae5   (permission stack)
worktree-agent-a9d2f632... (077a819) → cherry-pick → 2540a09   (HITL 4-tier)
```

순서는 conflict 위험도 낮은→높은. Agent 2/3가 같이 건드린 `admissibility-gate.ts` + `runtime-config.ts`는 `Auto-merging`으로 git이 자동 처리 (다른 라인이라 충돌 없음).

## 핵심 invariant 강제

- **side-conversation prompt byte-identical** (unit test `toBe(expected)`)
- **read-only-by-construction** (mutating tool 명시적 absent assertion against `planModeMutatingTable`)
- **effort cap** (high/xhigh runtime guard throws even on `as any` bypass)
- **anti-regression scanner 통과** — Agent 2/3 모두 `process.env` 직접 사용 차단되어 `runtimeConfig()` 통합으로 수렴
- **post-denial precedence**: 위험을 본 후 명시적 재승인은 모든 deny/allow 규칙 override
- **`sessionId` 누락 시 permission stack 자동 skip** — fabricated id silent failure 방지

## 검증

| 검증 | 결과 |
|---|---|
| 우리 11개 신규 test files | **145 pass / 0 fail / 274 expects** |
| 전체 suite (main wip 포함) | 3560 pass / 66 fail / 5 skip — 66 fail은 다른 트랙 (effort.ts, slash-commands.ts, shell-disclaim.ts 등 untracked 작업물 미완성) |
| `bun fc validate` | **131 features all evidence resolved** |
| baseline.json | 자동 refresh됨 (`tools/feature-catalog/refresh-baseline.ts`) |

## 카탈로그 entries 추가 (+7)

| Feature ID | Section | ADR |
|---|---|---|
| `progress-audit-skill` | 06-tier1 | 0045 |
| `per-thread-permissions` | 03-permission-safety | 0046 |
| `per-host-agent-mode` | 03-permission-safety | 0046 |
| `post-denial-precedence` | 03-permission-safety | 0046 |
| `hitl-4-tier-gate` | 03-permission-safety | 0047 |
| `response-in-progress` | 01-agent-loop | 0048 |
| `side-conversation` | 01-agent-loop | 0049 |

## 알려진 follow-up

- **main의 다른 트랙 미완성 작업물** (untracked `src/agent/effort.ts`, `src/agent/prompt-sections.ts`, `src/agent/tool-matchers.ts`, `src/apps/cli/slash-commands.ts`, `src/permission/trust-scope.ts`, `src/runtime/shell-disclaim.ts`, `src/skill/skill-size.ts`, `src/tool/apply-patch.ts` 등) — 본 R5와 무관, 별도 트랙 처리.
- `tests/integration/session-envelope-store-seam.test.ts` 2 pre-existing flakes (Agent 4 발견) — isolation 통과, 전체 suite concurrency에서만 fail. 별도 추적.
- `pnpm exec tsgo` 미설치 — 모든 Agent가 `./node_modules/.bin/tsc --noEmit`로 fallback (verify-workflow 일치).
- permission-store cleanup race로 "flush failed" warning noise — store.shutdown() 명시적 호출로 정리 가능.
- ADR-0020 (이전 4-tier gate enum)과 ADR-0047 관계: extend (supersede 아님). 같은 enum + 새 registry/composition 표면.
- 각 ADR의 §한계에 명시한 후속 wiring (slash command UI, thread 권한 UI, hand-off 핸드오프 view, "thinking..." indicator, side-conv composer input 등)은 다음 PR.

## 관련 메모리

- [[codex-desktop-build-2867-round-4]] — 도출 dive
- [[codex-system-skills-pattern]] — Agent 1 reference
- [[codex-subagent-tools]] — Agent 2 nickname pool 참조
- [[codex-collaboration-mode-pattern]] — Agent 4 side-conv 모드 비교
- [[verify-workflow]] — tsc fallback
- [[codex-absorption-complete]] — 이전 absorption
- [[may-21-cluster-integration-15-features]] — 직전 cluster ship (ADR 0028~0044)
- [[may-21-codex-r5-implementation]] — 본 라운드 메모리
