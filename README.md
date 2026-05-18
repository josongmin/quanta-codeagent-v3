# Quanta CodeAgent v3

ReAct 기반 코딩 에이전트. 처음부터 새로 작성. 목표: 전체 20k LoC 미만.

설계는 [rfc/0001-architecture.md](rfc/0001-architecture.md) 참조.
Claude Code v2 리버스 분석은 `docs/analysis/`를 **이해 용도로만** 참고 (구조 복제 금지).

## 빠른 시작

```bash
bun install
cp .env.example .env.dev   # ANTHROPIC_API_KEY 또는 OPENAI_API_KEY 채우기
bun run dev "src/shared/types.ts 읽고 요약해줘"
```

CLI가 `.env.dev` → `.env.local` → `.env` 순으로 로드(먼저 값이 우선, 실 환경변수가 최상위).

옵션 환경변수:

- `ANTHROPIC_API_KEY` 또는 `OPENAI_API_KEY` (둘 중 하나 필수)
- `QUANTA_PROVIDER` — `anthropic` | `openai` (기본: 키로 자동 추론)
- `QUANTA_MODEL` (기본 provider별: `claude-sonnet-4-6` / `gpt-4o`)
- `QUANTA_MAX_TURNS` (기본 `40`), `QUANTA_PERMISSION` (`default`|`acceptEdits`|`bypass`)

## 스크립트

| 명령 | 설명 |
|---|---|
| `bun run dev` | 핫리로드 CLI |
| `bun test` | 단위+통합 (결정론 게이트). 머지 기준 |
| `bun run test:contract` | 실 Docker·언어서버 (환경게이트, `REQUIRE_CONTRACT`로 하드화) |
| `bun run test:eval` | 실 LLM SWE-bench (비차단, 점수) |
| `bun run test:cov` | 커버리지 측정 (게이트 아님) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | Biome 검사 (슬라이스 격리 강제 포함) |

테스트 4티어(unit/integration/contract/eval) 설계·관리: ADR-0003 (`docs/decisions/0003-test-pyramid.md`), RFC §10. CI: `.github/workflows/ci.yml`.

## Phase 1 범위

`shared · llm · tool · runtime · storage · stream · permission · agent · apps/cli`
— 단일 trajectory ReAct 루프. concurrency / compaction / hook / subagent 는 후속 Phase.
