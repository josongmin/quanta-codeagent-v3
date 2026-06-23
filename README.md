# Quanta CodeAgent v3

ReAct 기반 코딩 에이전트. 처음부터 새로 작성.

설계는 [rfc/0001-architecture.md](rfc/0001-architecture.md) 참조.
Claude Code v2 리버스 분석은 `docs/analysis/`를 **이해 용도로만** 참고 (구조 복제 금지).

## 빠른 시작

```bash
bun install
cp .env.example .env.dev   # ANTHROPIC_API_KEY 또는 OPENAI_API_KEY 채우기
bun run dev "src/shared/types.ts 읽고 요약해줘"
```

CLI가 `.env.dev` → `.env.local` → `.env` 순으로 로드(먼저 값이 우선, 실 환경변수가 최상위).

## Reading order

First-time / returning-after-months:

1. **Run it** — see §빠른시작 above (1 min).
2. **Architecture** — [rfc/0001-architecture.md](rfc/0001-architecture.md) §1, §3.
3. **Operational reference** — [docs/runbooks/agent-loop-reference.md](docs/runbooks/agent-loop-reference.md) — loop boundary map, trust ladder, recovery enum. (Use this for debugging / context recovery after a break.)
4. **Contract specification** — [docs/analysis/경쟁사리뷰/code-agent-loop/quanta-comparison.md](docs/analysis/경쟁사리뷰/code-agent-loop/quanta-comparison.md) — every "quanta wins X" claim maps to a `bun test <hellgate>` proof (see §실행 가능한 증거 인덱스).
5. **Test suite** — `tests/` layout (`unit/`, `integration/`, `contract/`, `smoke/`) — tier taxonomy in ADR-0003 ([docs/decisions/0003-test-pyramid.md](docs/decisions/0003-test-pyramid.md)); inner-loop commands in §스크립트 below.
6. **ADRs** — [docs/decisions/README.md](docs/decisions/README.md) — 99+ records, indexed by number and slice.
7. **Test naming** — [docs/test-naming.md](docs/test-naming.md) — `*-hellgate` vs `*-hell-e2e` vs `*-e2e` convention.
8. **Adding a tool** — [docs/tool-authoring.md](docs/tool-authoring.md) — canonical `defineTool` template + registration steps.
9. **Feature catalog** — `bun fc list` (see [AGENTS.md](AGENTS.md) for the workflow).

옵션 환경변수:

- `ANTHROPIC_API_KEY` 또는 `OPENAI_API_KEY` (둘 중 하나 필수)
- `QUANTA_PROVIDER` — `anthropic` | `openai` (기본: 키로 자동 추론)
- `QUANTA_MODEL` (기본 provider별: `claude-sonnet-4-6` / `gpt-4o`)
- `QUANTA_MAX_TURNS` (기본 `40`), `QUANTA_PERMISSION` (`default`|`acceptEdits`|`bypass`|`auto`)
- `QUANTA_MEMORY` (`sqlite`|`memory`, 미설정 시 OFF) — 메모리 표는 아래 참조
- `QUANTA_PLAN=1` / `--plan` (plan mode), `QUANTA_METRICS=1` (메트릭)
- `QUANTA_STATE_PATH` / `--state`, `QUANTA_RESUME` / `--resume` (state 영속·resume, 기본 OFF)
- `QUANTA_MCP_CONFIG` — MCP 서버 설정 JSON 파일 경로 (미설정 시 OFF)
- `QUANTA_LSP=1` — LSP diagnostics(`diagnostics` 도구) 실제 provider 스왑(ADR-0009)
- `QUANTA_LSP_TOOLS=full` — LSP nav 8 도구(`lsp_definition`/`_references`/`_hover`/`_type_definition`/`_implementation`/`_document_symbol`/`_workspace_symbol`/`_rename_preview`) 등록(ADR-0024). 기본 OFF, registry byte-identical
- `QUANTA_GIT_TOOLS=1` — git 1급 도구 4종(`git_diff`/`git_status`/`git_log`/`git_blame`) 등록(ADR-0025). 기본 OFF
- `QUANTA_SUBAGENT` / `QUANTA_SKILLS_DIR` / `QUANTA_MODEL_FALLBACK` / `QUANTA_COMPACT_BREAKER` — SOTA++ 표는 아래 참조

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
| `QUANTA_MEMORY_RECALL_TIERS` | `episodic,semantic` 부분집합 (미설정 시 전 tier) | 루프 회상을 해당 tier로 제한 |

회상 랭킹은 tier 가중(durable `semantic` > raw `episodic`)을 포함하며,
`memory_search` 도구는 `tier`/`kind`/`minImportance` 필터를 받는다.
`QUANTA_METRICS=1`이면 메모리 파이프라인 카운터(`memory.recall.*`,
`memory.persist.*`, `memory.distilled`, `memory.consolidate.*`,
`memory.evict.*`)가 기록된다.

## SOTA++ 흡수 (subagent · skills · fallback · breaker)

서브에이전트/스킬/프로바이더 폴백/컴팩션 서킷브레이커 (설계: RFC, ADR-0011).
**전부 기본 OFF** — 아래 knob을 미설정 시 `AgentConfig`는 byte-for-byte 불변
(키 자체가 생략되며 llm 스택도 오늘과 동일). 신규 npm 의존성 0.

| 환경변수 | 값 / 기본 | 효과 |
|---|---|---|
| `QUANTA_SUBAGENT` | 설정 시 ON / 미설정(OFF) | `config.subagent` 추가 → `Agent`/`Task`/`TaskOutput`/`TaskStop` 도구 등록. 미설정 시 키 생략(도구 미등록, 루프 불변) |
| `QUANTA_SUBAGENT_MAX_DEPTH` | 정수 (미설정 시 러너 기본) | `subagent.maxDepth` 재귀 깊이 cap. `QUANTA_SUBAGENT` 설정 시에만 적용 |
| `QUANTA_SKILLS_DIR` | 디렉터리 경로 / 미설정(OFF) | `config.skills={dir}` → 세션 시작 시 스킬 디스커버리 + `Skill`/`ToolSearch` 도구 등록. 미설정 시 키 생략 |
| `QUANTA_PERMISSION=auto` | `auto` (그 외: `default`\|`acceptEdits`\|`bypass`) | LLM 분류기(`createAutoClassifierPort`)를 **최종 합성 llm**으로 빌드해 `PermissionContext.classify`에 주입. 분류기 부재 시 "auto"는 "ask"로 안전 degrade |
| `QUANTA_MODEL_FALLBACK` | 콤마 구분 모델 id 목록 / 미설정(OFF) | 각 id마다 동일 어댑터·retry 스택을 만들어 `FallbackLLM`으로 합성. 순서: **프로바이더별 retry 안쪽, fallback 바깥쪽**. 미설정 시 llm 스택 오늘과 byte-identical(미래핑) |
| `QUANTA_COMPACT_BREAKER=off` | `off` (기본: 키 생략 ⇒ 브레이커 ON) | `compactionBreaker={disabled:true}`. 기본은 안전 caps로 ON이며 병적 컴팩션 thrash에서만 트립 |
| `QUANTA_COMPACT_BREAKER_REACTIVE_MAX` / `_PROACTIVE_MAX` | 정수 (미설정 시 기본 caps) | `caps.maxConsecutiveReactive` / `maxNoProgressProactive` override |

llm 합성 순서는 `FallbackLLM([retry(primary), retry(fallback…)])` — provider별
retry가 최내곽, fallback이 최외곽이며 `QUANTA_PERMISSION=auto` 분류기는 이
최종 합성 포트를 사용한다.

## 스크립트

| 명령 | 설명 |
|---|---|
| `bun run dev` | 핫리로드 CLI |
| `bun test` | 단위+통합 (결정론 게이트). 머지 기준 |
| `bun run test:contract` | 실 Docker·언어서버 (환경게이트, `REQUIRE_CONTRACT`로 하드화) |
| `bun run test:eval` | 실 LLM SWE-bench (비차단, 점수) |
| `bun run smoke` / `:live` / `:report` / `:record` | 스모크 배터리(실 loop + 도구/LLM replay + LLM-judge). `:live`=실 LLM, `:record`=cassette 녹화 |
| `bun run e2e:pty` | raw-mode 인터랙티브 CLI e2e (FFI openpty; 입력층 LLM0 결정론) |
| `bun run bench …` | 통합 SWE-bench CLI (`quanta-bench`; `grade`/`run`/`evaluate-repro`/`pool`/`auth`). §벤치 참조 |
| `bun fc list` | 기능 카탈로그 (AGENTS.md 워크플로우) |
| `bun run test:cov` | 커버리지 측정 (게이트 아님) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | Biome 검사 (슬라이스 격리 강제 포함) |
| `bun run probe` | trajectory 비권위 inspector (RFC-0002 §7, ADR-0010) |
| `bun run build` | `dist/agent` 단일 바이너리 컴파일 |
| `bun run install:cli` | 빌드 후 `~/.local/bin/quanta`에 전역 설치 (PATH 확인 포함) |
| `bun run baseline:silent-catch` | silent-catch ratchet의 `BASELINES` 표를 실제 관찰값으로 자동 tighten (감소 시에만 갱신·idempotent·target test 부재 시 no-op) |

silent-catch 사이트를 줄였을 때 `bun run baseline:silent-catch`를 실행하고 커밋한다.

테스트 4티어(unit/integration/contract/eval) 설계·관리: ADR-0003 (`docs/decisions/0003-test-pyramid.md`), RFC §10. CI: `.github/workflows/ci.yml`.

## Phase 1 범위

`shared · llm · tool · runtime · storage · stream · permission · agent · apps/cli`
— 단일 trajectory ReAct 루프 + in-loop 실패 복구, proactive·reactive compaction,
per-input concurrency 배칭, hook, 프롬프트 캐시 프리픽스 고정(ADR-0004).

이후 Phase 1.5/2/3 구현 반영: memory · lsp · observability · mcp 슬라이스,
SWE-bench 하니스 + Best-of-N 샘플러. MCP·Best-of-N 구현됨. subagent/skills는
SOTA++ 흡수로 wired(ADR-0011, `buildSessionFeatures` — env knob 설정 시 ON,
미설정 시 도구 미등록·루프 불변).

## 벤치 (SWE-bench)

진입점은 통합 CLI `bun run bench <sub>` (= `src/apps/bench/cli.ts`, ADR-0536):
`run`(로컬 patch-gen) · `grade --mode full`(EC2 spot/on-demand patch-gen + 채점) ·
`evaluate-repro`(오프라인 repro-오라클 rescore) · `pool` · `auth` · `presets`.

### 돌리는 법 (복붙 가능)

```bash
# 0) 프리셋 목록 (기본: agentless-v3-thin-strict)
bun run bench presets

# 1) 인증 — 단일 chatgpt.json 또는 풀(chatgpt-acct-*.json + bench-pool.yaml).
#    토큰 만료(401 token exchange failed) 시 재발급:
bun run bench auth login --auth-label a --auth-file ~/.quanta/auth/chatgpt-acct-a.json
bun run bench auth status

# 2) 데이터셋 — SWE-bench Verified jsonl. 서브셋은 instance_id로 grep:
grep -E '"(astropy__astropy-13033|django__django-11138)"' \
  docs/analysis/swe-bench-verified-analysis/_data/verified-full.jsonl > /tmp/subset.jsonl

# 3) DRY-RUN — LLM 없이 플랜만 확인 (먼저 이걸로 검증)
bun run bench run --swebench /tmp/subset.jsonl --dry-run

# 4) FULL-REMOTE grade (정본 경로) — EC2서 patch-gen + 공식 harness 채점.
#    on-demand=reclaim 면역(~3× 비용), spot 용량 크런치 때. 결과는 resolved/unresolved.
QUANTA_BENCH_PRESET=agentless-v3-thin-strict \
QUANTA_FULL_REMOTE_ONDEMAND=1 QUANTA_FULL_REMOTE_CONCURRENCY=3 \
  bun run bench grade --mode full --allow-remote-secrets --allow-extra-boxes \
  --auth-file ~/.quanta/auth/chatgpt-acct-a.json \
  --dataset /tmp/subset.jsonl \
  --instance astropy__astropy-13033,django__django-11138 \
  --preset agentless-v3-thin-strict --model gpt-5.4

# (옵션) +녹화: 위 명령 앞에 QUANTA_BENCH_RECORD_TRAJECTORY=1 → cassette 캡처(이후 무료 재생)

# 5) 로컬 patch-gen (채점 없이 예측만; 채점은 remote가 정본)
bun run bench run --swebench /tmp/subset.jsonl --predictions /tmp/preds.jsonl --n 1
```

산출물(full-remote)은 `~/Library/quanta-codeagent-v3/bench/full-remote/`에
`report-<suffix>.json`(verdict + reproTest + selection) · `closure-<suffix>.json`
(오라클/localize 지표) · `preds-<suffix>.jsonl` · `runlog-<suffix>.log` ·
`trajectory-<suffix>.jsonl`(녹화 시) 로 떨어진다(런 종료 로그에 경로 출력).

주요 env: `QUANTA_BENCH_PRESET`(값 셀렉터) · `QUANTA_FULL_REMOTE_ONDEMAND=1`(spot
대신 on-demand) · `QUANTA_FULL_REMOTE_CONCURRENCY`(박스당 patch-gen 동시성, **채점은
항상 serial**) · `QUANTA_BENCH_RECORD_TRAJECTORY` / `QUANTA_BENCH_REPLAY_TRAJECTORY`.
개별 `QUANTA_BENCH_*` 노브는 프리셋 값을 override.

**2대 하드룰 (어기면 측정이 거짓말):**
- **채점은 SERIAL** — 동시 채점은 false-negative를 만든다. verdict만 믿지 말고 패치를 까서(gold-identical / apply-check) 검증.
- **채점은 remote가 정본** — 로컬 docker 쓰지 말 것; `grade --mode full --allow-remote-secrets`가 EC2서 공식 swebench harness로 채점.

문서: 측정 인프라·EC2 런북([docs/swebench-ec2-runbook.md](docs/swebench-ec2-runbook.md)) ·
실패 디버깅([docs/swebench-agent-troubleshooting.md](docs/swebench-agent-troubleshooting.md)) ·
스모크 기준선(`tests/smoke/swebench/`).

### 실패 디버깅 — 토큰 안 태우고 반복

매번 풀 파이프라인(LLM patch-gen + repro-gen + EC2)을 재실행하지 말 것. 비싼 건
stochastic LLM rollout뿐이고 결정론부(repro실행/빌드env/grade/selection)는 공짜
재구동된다. 두 경로:
- **Trajectory cassette (녹화→재생)**: `QUANTA_BENCH_RECORD_TRAJECTORY=1`로 LLM
  스트림 전체를 1회 녹화 → `QUANTA_BENCH_REPLAY_TRAJECTORY=<file>`(⚠️generic
  `QUANTA_LLM_REPLAY` 아님)로 토큰 0에 재생(결정론 코드 수정 반복용).
- **`bun run bench evaluate-repro --corpus <dir> {--probe | --repro-scripts <f>}`**:
  repro 스크립트/빌드env import probe를 fresh base에 LLM 0으로 재실행 → 오라클
  `exec_failed → reproduced` flip 관찰.

진단 시작점: `closure-*.json` → `synth_repro_base_red_rate`(0 = repro 오라클 미수립 =
통상 병목; localize 아님). 전체 워크플로우 + 실패 taxonomy는
**[docs/swebench-agent-troubleshooting.md](docs/swebench-agent-troubleshooting.md)**.

## 개발/디버깅 흔한 함정 (자주 헛삽질)

- **stale 컴파일 바이너리** — `~/.local/bin/quanta`는 컴파일된 스냅샷이다. 소스를
  고쳐도 `bun run install:cli` 재빌드 전엔 반영 안 됨. "CLI가 내 수정대로 안 돌아"
  #1 원인.
- **knob/config는 병렬 3시스템** — 설정 추가 전 `grep` 필수(`@/runner/knobs`
  프레임워크 + runtime-config + src/config). 안 하면 같은 노브 재발명.
- **`bun run lint:fix`은 repo-wide** — 무관 파일 대량 churn. 내 파일만 고치려면
  `node_modules/.bin/biome check --write <paths>`.
- **`git add -u` 금지** — 사용자가 백그라운드 sweep 중일 수 있음(의도 안 한 스테이징
  사고). 내가 만진 경로만 명시적으로 add.
