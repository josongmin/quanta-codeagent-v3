# 00 — MASTER PLAN: quanta SDK embed DX

## A. 최종 어딧 (실물 검증 확정치)

모두 `src/**` 실독으로 확정. 근거 파일 경로 병기.

| # | 심각도 | 발견 | 근거 |
|---|---|---|---|
| A | 정정·HIGH | `assembleAgentConfig`는 wire-slot을 **안** 채운다. `MODE_PRESETS[mode]`로 `modePolicy` + `budgetMeter` 2개만 얹음. 나머지(llm·registry·stream·permission·메모리·서브에이전트)는 전부 `base`가 소유. → optional wire-slot은 base에서 안 주면 OFF(최소 embed=이미 minimal). full(memory/subagent/MCP)은 bootstrapSession급 조립 필요. | `agent-config-assembler.ts:832,862` / `sdk/runtime/base.ts:54` |
| B | BLOCKER·HIGH | `package.json`에 `exports`/`main`/`types` 전무. `name="quanta-codeagent"`, `private` 아님. → 외부 레포 import 물리적으로 불가. | `package.json` |
| C | MED | `base: RuntimeAgentConfigBase = Omit<AgentConfig,2> & Augments(27 optional slot)`. 큐레이션 없이 노출하면 133필드+40슬롯이 소비자 타입에 샌다. | `sdk/runtime/base.ts:1-57` |
| D | MED | AgentEvent는 40+ variant push-only(`emit`). async-iterable/축약 콜백 없음 → 소비자가 큐+switch 직접 구현. | `stream/types.ts:168` / `stream/ports.ts:3` |
| E | 해소 | 모드 프리셋 실독 완료(§B). `headless`=single-turn(메인루프 부적합), `batch`=multi-turn이나 net denied. | `run-mode/presets.ts:34-61` |
| F | LOW | 세션 끝 memory consolidator가 defer 안 되면 rollout distill LLM 콜이 `runAgent` 리턴을 붙잡음. embed 기본 OFF 필요. | `loop/entry.ts:48` |
| G | RISK·회피됨 | slice fence: façade는 `@/host/runtime/agent-config-assembler`에서 직접 끌어야(=env-pure). `apps/agent/assemble`(process.env 바인딩 shim)에서 끌면 fence 위반 + env 오염. | `apps/agent/assemble.ts` / `apps/headless/index.ts:9` |

## B. 모드 프리셋 baseline (Phase 0.1 실독, `run-mode/presets.ts`)

| mode | termination | permission | network | gitWrite | sandbox | toolSurface |
|---|---|---|---|---|---|---|
| interactive | user-stop | reviewer-backed | open | free | user-cwd | (full) |
| headless | **single-turn** | auto/acceptEdits | open | free | user-cwd | headless-safe |
| batch | verdict(멀티턴) | auto/acceptEdits | **denied** | snapshot-only | per-instance | (full) |
| ci-bot | diff-ready | auto/acceptEdits | allowlist | branch-only | branch-only | — |
| daemon | diff-ready | auto/acceptEdits | allowlist | branch-only | per-instance | headless-safe |

→ repo-분석 메인루프(멀티턴·read-heavy·net 가변)엔 기성 mode가 정확히 안 맞음 → `analysis` 커스텀 레버(Phase 4).

## C. RuntimeAgentConfigBase 필드 분류 (Phase 0.2)

- **required core (façade가 강제):** `llm, registry, stream, permission, messages, system, cwd, maxTurns, signal`
  (근거: `apps/agent/mode-presets/interactive.ts:41-52` buildInteractiveBase 최소 셋)
- **assembler가 얹음:** `modePolicy, budgetMeter` (`MODE_PRESETS[mode]`)
- **optional wire-slot (27, 기본 OFF):** `memoryConsolidator, subagentBackground, autoBackground, delegation, fork, forkSession, conversationCheckpoint, planStore, retrievalStack, searchPipeline, focusChain, admissibility, decisionEmitter, artifactRegistry, …` (`sdk/runtime/base.ts` RuntimeAgentConfigAugments) — 프로파일이 on/off 결정.

## D. 계획 (ROI 무관, exhaustive)

경계 → façade → 이벤트 → 프로파일 → 툴 → 테스트 → 계약. 상세는 각 phase 티켓.

- **Phase 1** 공개 경계: 배럴 + package.exports + slice-fence 테스트. **토대·BLOCKER(어딧 B·C·G).**
- **Phase 2** façade `createAnalysisAgent`: base 최소 조립 + runAgent, 옵션 큐레이션, LLM 주입, 기본값.
- **Phase 3** 이벤트: push→async-iterable, 축약 콜백, narrowing, backpressure. **체감 DX 본체(어딧 D).**
- **Phase 4** 프로파일: read-only/analysis/full → 레버+wire-slot on/off. **비용·결정론 안전판(어딧 A·F).**
- **Phase 5** 툴 authoring 재수출 + 레퍼런스 툴.
- **Phase 6** 결정론 테스트 하네스(FakeLlm/RecordingStream).
- **Phase 7** 에러 taxonomy + outcome 재수출.
- **Phase 8** API snapshot 게이트 + version + README + hellgate e2e.

## E. 의존 그래프

```
Phase 0 (실독 완료)
   └─> Phase 1 (경계) ──┬─> Phase 2 (façade) ──┬─> Phase 3 (이벤트)
                        │                       ├─> Phase 4 (프로파일)
                        │                       ├─> Phase 5 (툴)
                        │                       ├─> Phase 6 (테스트)
                        │                       └─> Phase 7 (에러)
                        └─────────────────────────> Phase 8 (게이트·문서) ← 전부 소비
```
Phase 1이 전부의 토대. 3·4가 "오지게"의 본체. 5·6·7은 façade에 얹는 병렬.

## F. 검증 프로토콜 (hellgate-implementation-protocol)

각 phase 구현은 5단계:
1. **RED e2e 셋업** — 공개 문만 쓰는 실패 테스트 먼저 (Phase 8.4가 최상위 RED).
2. **TDD + 구조 구현** — leaf(`src/sdk/*`) 단위로.
3. **적대 어딧 ≥3R** — 특히 타입 누수(C)·이벤트 유실(D)·fence(G).
4. **셀프 어딧** — 스펙 대비 drift.
5. **구조적 TDD 보완.**

천공카드 원칙: build 비싸니 정적 우선(tsc/biome) + leaf 유닛만. full-suite 지양.

## G. 브랜치·위생

- 신규 브랜치 `feat/sdk-embed-dx` (현재 `feat/model-driven-plan-entry` in-flight 24파일과 분리).
- `git add -u` 금지(유저 in-flight sweep 사고 방지) — 내 파일만 명시적 add.
- lint: `node_modules/.bin/biome check --write <paths>` (repo-wide `lint:fix` 금지).
