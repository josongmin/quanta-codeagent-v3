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
- `QUANTA_MEMORY` (`sqlite`|`memory`, 미설정 시 OFF) — 메모리 표는 아래 참조
- `QUANTA_PLAN=1` / `--plan` (plan mode), `QUANTA_METRICS=1` (메트릭)
- `QUANTA_STATE_PATH` / `--state`, `QUANTA_RESUME` / `--resume` (state 영속·resume, 기본 OFF)
- `QUANTA_MCP_CONFIG` — MCP 서버 설정 JSON 파일 경로 (미설정 시 OFF)

## 메모리

세션 내 working 메모리 + 영속 SOTA++ 계층형 시맨틱 메모리(설계: RFC §6.3,
ADR-0008). store가 켜지면 종료된 세션을 LLM으로 distill해 구조화 지식으로
적재하고, 다음 세션 시작 시 임베딩 기반 하이브리드 회상으로 관련 메모리를
주입한다. 중복은 LLM 중재로 merge/supersede되고 tier별 정원으로 eviction된다.
**전부 기본 OFF** — `QUANTA_MEMORY` 미설정 시 루프는 byte-for-byte 불변이고,
임베더/LLM 부재 시 lexical 회상으로 graceful degrade한다. 신규 npm 의존성 0.

| 환경변수 | 값 / 기본 | 효과 |
|---|---|---|
| `QUANTA_MEMORY` | `sqlite` \| `memory` \| 미설정(OFF) | 영속 store: 온디스크 sqlite / 휘발 in-memory / 없음 |
| `QUANTA_MEMORY_PATH` | 기본 `.quanta/memory.sqlite` | sqlite store 파일 경로 |
| `QUANTA_MEMORY_EMBED` | `off` \| 기타(기본 ON) | `off`면 임베딩 비활성(lexical만). store + `OPENAI_API_KEY` 있을 때만 ON |
| `QUANTA_MEMORY_EMBED_MODEL` | 기본 `text-embedding-3-small` | 임베딩 모델 override |
| `QUANTA_MEMORY_RECALL_LIMIT` | 정수, 기본 5 | 회상 컨텍스트에 접는 최대 엔트리 수 |
| `QUANTA_MEMORY_DISTILL` | `off` (기본 ON) | `off`면 세션 종료 LLM distill 끔(휴리스틱 요약으로 degrade) |
| `QUANTA_MEMORY_CONSOLIDATE` | `off` (기본 ON) | `off`면 LLM 중재 중복 통합 끔 |
| `QUANTA_MEMORY_SELF_EDIT` | `off` (기본 ON) | `off`면 `memory.selfEditTools=false` → `memory_search/write/update` self-edit 도구 미등록 |

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
— 단일 trajectory ReAct 루프 + in-loop 실패 복구, proactive·reactive compaction,
per-input concurrency 배칭, hook, 프롬프트 캐시 프리픽스 고정(ADR-0004).

이후 Phase 1.5/2/3 구현 반영: memory · lsp · observability · mcp 슬라이스,
SWE-bench 하니스 + Best-of-N 샘플러. MCP·Best-of-N 구현됨, subagent는 범위 외.
