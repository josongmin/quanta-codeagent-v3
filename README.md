# Quanta CodeAgent v3

ReAct 기반 코딩 에이전트. 처음부터 새로 작성. 목표: 전체 20k LoC 미만.

설계는 [rfc/0001-architecture.md](rfc/0001-architecture.md) 참조.
Claude Code v2 리버스 분석은 `docs/analysis/`를 **이해 용도로만** 참고 (구조 복제 금지).

## 빠른 시작

```bash
bun install
export ANTHROPIC_API_KEY=sk-...
bun run dev "src/shared/types.ts 읽고 요약해줘"
```

옵션 환경변수:

- `ANTHROPIC_API_KEY` (필수)
- `QUANTA_MODEL` (기본 `claude-sonnet-4-6`)
- `QUANTA_MAX_TURNS` (기본 `40`)

## 스크립트

| 명령 | 설명 |
|---|---|
| `bun run dev` | 핫리로드 CLI |
| `bun test` | 단위/통합 테스트 |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | Biome 검사 (슬라이스 격리 강제 포함) |

## Phase 1 범위

`shared · llm · tool · runtime · storage · stream · permission · agent · apps/cli`
— 단일 trajectory ReAct 루프. concurrency / compaction / hook / subagent 는 후속 Phase.
