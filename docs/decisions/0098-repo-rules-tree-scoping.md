# ADR-0098: Repo-rules 트리 scoping + deeper-wins (Codex §18.1 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0099(default-NO-git posture, 같은 batch), Codex §18.1 디렉토리 트리 scoping
- **참조**: `src/agent/repo-rules.ts`, `tests/unit/repo-rules-tree-hellgate.test.ts`(15 적대), `tests/unit/repo-rules.test.ts`(기존 16 보존)

## 맥락

기존 `loadRepoRules(cwd)`는 cwd 디렉토리 단일 root만 봤다. monorepo에서 `packages/foo/AGENTS.md` 같은 패키지별 규칙을 모델이 자동으로 받지 못해 — 사용자가 매번 cwd를 정확히 잡거나 root에 모든 규칙을 우겨넣어야 했다.

Codex §18.1: "폴더부터 모든 하위 적용, deeper-wins 우선순위, CWD→root 경로의 AGENTS.md 자동 prepend". cwd→root로 트리 walk + deeper-wins(렌더 순서 root→cwd, 후순위 = LLM positional bias로 win).

## 결정

`loadRepoRules`를 트리 워커로 확장. backward compat 유지 — 단일 레이어 발견 시 body는 원본 그대로(`### From` subheader 없음). 다중 레이어 시 `### From <relativePath>` 섹션 헤더로 attribution.

**stop 조건**: (1) `.git` 디렉토리 있는 dir(repo root, 포함 후 정지), (2) filesystem root, (3) MAX_DEPTH=16.

**RepoRules** 타입 확장(`layers?: RepoRulesLayer[]` optional — 기존 fixture 호환).

## 결과

- `tests/unit/repo-rules.test.ts` 16 기존 케이스 전부 통과(byte-identical) + 3 신규 (단일/다층 header, layers-undefined 호환).
- `tests/unit/repo-rules-tree-hellgate.test.ts` 15 신규 적대 케이스(트리 walk / 혼합 entrypoint / `.git` 경계 / symlink 거부 per-layer / 깊이 cap / 동시성).
- `tests/integration/agents-md-scope-e2e.test.ts` 3 e2e — runAgent까지 흘러 per-turn reminder에 shallow→deep 본문 + 명시적 deeper-wins notice + 단일 레이어 byte-identical 보존을 검증.
- `prompt.ts:491` 소비 site 변경 없음(렌더된 body 그대로 주입).
- `renderRepoRulesBlock` 헤더 확장: 다층(`layers.length > 1`)일 때만 `(from <entrypoint>; rules from deeper directories override shallower ones)`로 §18.1 verbatim 규칙을 명시. 단일 레이어 / `layers` 미설정 fixture는 byte-identical(`(from <entrypoint>)`)로 유지 — sota-codex-full / prompt-dynamic의 기존 단언 + cached system-prompt prefix 무영향.

## 한계

- relativePath는 cwd 기준 — process cwd가 turn 중에 바뀌면 라벨이 stale. 우리는 turn 내 일정한 cwd를 가정.
- MAX_DEPTH=16은 정상 monorepo 깊이를 충분히 초과. 그 이상은 무시.
- symlink는 per-layer로 reject — 부모 디렉토리의 진짜 AGENTS.md는 살리되 sub의 symlinked AGENTS.md만 skip.
