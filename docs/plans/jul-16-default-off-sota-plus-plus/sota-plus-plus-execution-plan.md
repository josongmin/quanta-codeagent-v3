# SOTA++ 실행 계획 (2026-07-18) — 3라운드 중복·배선 어딧 후

> 관통 결론: **"SOTA++ = 다 배선"은 함정.** 3라운드 적대 어딧(C1~C6 + 체계적 드리프트 + 충돌 결착)이 밝힌 것 — 큰 항목(durable session registry, semantic index, codex-r2 dormant)은 **전부 이미 빌드+배선돼 있고 env-gated default-OFF**일 뿐. 순진하게 배선하면 **죽은 중복 seam만 늘린다**. 진짜 SOTA++ 작업은 훨씬 작고 외과적이며 5개 트랙으로 분해된다.
>
> **어딧 핵심 수치**: unwired/seam-only 라벨 41행 중 **18행이 실은 ENV-GATED-LIVE**(라벨만 stale), 진짜 dormant는 **21행**. repair-first 17 중 **11행은 blocker가 STALE**(이미 고쳐짐/배선됨). 진짜 신규 코드 갭은 **6건**, 통합대상 중복은 **5건**.

---

## 어딧이 뒤집은 전제 (증거)

| 전제(계획 초안) | 어딧 판정 | 증거 |
|---|---|---|
| durable session registry 배선 필요 | **이미 live** — sqlite/disk/flock 3중 백엔드 다 구현+gated. 단 대화 *메시지* resume은 아님(메타/seq만) | `session-resource-registry/global.ts:85`, `host/runtime/persistence.ts:25`; 메시지 rehydrate는 KILL된 설계(ticket-05, `sdk/connect.ts:194`) |
| semantic index 임베딩 provider 배선 필요 | **이미 live** — OpenAI/Voyage/Cohere+sqlite/lance/qdrant+델타인덱서+key-detection auto-promote 다 빌드. `[]`는 override되는 fallback | `search-index-backend.ts`, 활성=`QUANTA_INDEX=on`+preset+key |
| codex-r2 dormant 활성화 필요 | **context-change·mention 이미 live**; system-prompt-cache·.codex-plugin은 **중복 재흡수** | `installCodexR2Wires`가 4곳서 live 호출(`agent-config-assembler.ts:829`) |
| repair-first 17개 다 수리 필요 | **11개 STALE** — structured-output Anthropic parity 랜딩됨·syntax-chunking ABI 고쳐짐·shadow-verify 실어댑터 존재·command-hooks fail-closed 랜딩 | Round2/3 소스대조 |

---

## Track 1 — 레저·문서 진실보정 (correctness, 최대 볼륨·무위험) 【SP-1x】

체계적 감사가 확증한 SSOT 부패(jul-13 패턴 재발). **코드 배선이 아니라 라벨 정정**이 대부분. 커밋 전 각 행 소스 재검(no-optimism).

- **SP-11 activation/reachability 정정 (18행)**: `unwired`/`seam-only`→`env/config|port-present` + `reachability→wired`. 대상: effort-classifier, fast-apply-fallback, fast-apply-wire, conflict-parser-lib, subagent-resume-replay, per-tool-checkpoint-granularity, ratelimit-dual-window-snapshot, codex-r2-{compaction-event-emit, context-change-injection-wire, system-prompt-cache-and-audit, typed-event-store, mention-injection-pipeline, plugin-system}, run-ledger-attribution, search-pipeline-composer, semantic-search-port(⚠️Track2와 상충 — 아래 참조), shell-snapshot-runshell-wire, embed-cache. 각 gate+callsite 주석.
- **SP-12 gate_owner 정정**: DI-slot로 적힌 걸 실제 `QUANTA_*` env로 (예: effort-classifier=`QUANTA_EFFORT_AUTO`, not `AgentConfig.effortClassifier`).
- **SP-13 owner_seam 경로 drift**: voice-input-stt-slice(`src/voice/`→실제 `src/media/voice/`), model-tag-auto-hook/versioning(`retrieval/model-tag/`→`auto-hook/`+`versioning/`).
- **SP-14 stale 노트 정정**: `syntax-aware-chunking.yaml:58-67,102`(tree-sitter-wasms@0.1.13 → 실제 `@vscode/tree-sitter-wasm@0.3.1` 마이그레이션 완료, 런타임 5문법 로드 확인) + structured-output-mode(Anthropic parity 랜딩) + MEMORY `syntax-chunk` 노트.
- **SP-15 드리프트 라쳇 신설**: activation 라벨 재부패 방지 — "owner_seam이 `QUANTA_*` gate로 읽히면 activation≠unwired" 정적 검사(체계 driver=`installCodexR2Wires` slot-fill이라 유닛으로 핀 가능). [[exhaustive-record-classification-drift-guard]] 패턴.

**검증**: ledger-hellgate 4/0 유지, closure 재계산(18행 중 reachability 이미 wired인 것 다수라 metric 이동은 seam-only→wired인 search-pipeline/semantic/embed만 = +N, 정직 상승). fc validate/diff green.

## Track 2 — 중복 seam 통합/삭제 (objective "proven duplicate" 규칙 적용) 【SP-2x】

3라운드서 **검증된 중복**(objective가 삭제 허용: proven duplicate/supersession). 각 delete-or-merge disposition + duplicate_of 근거.

- **SP-21 retrieval/semantic ADR-0254 포트**: `src/retrieval/semantic/{port,in-memory-index,index}.ts`의 text-in `SemanticIndex`는 live wire가 안 씀(live는 `@/retrieval/pipeline` vector-in). concrete impl `createInMemoryIndex` consumer 0. → 통합(pipeline 타입으로) 또는 삭제, `duplicate_of: search-pipeline`.
- **SP-22 recovery-router-codex-spec**: `codexSpecRoute` 테이블이 SSOT(decorator-policy/retry/fallback 소비), `RecoveryRouter.route()`는 `recovery.ts:253` 한 곳만 — **router가 redundant path**. DI-slot 배선 대신 router를 policy로 흡수하거나 단일권위 명시.
- **SP-23 .codex-plugin 2차 discovery**: live는 `.quanta/plugins`(`plugin-loader.ts`), `.codex-plugin` 스캐너(`plugin-discovery/discovery.ts`)는 mention `plugin://`에도 안 붙는 2차 구현 → 통합(하나의 discovery로).
- **SP-24 stage1-phase2 orphan store**: live 파이프라인은 `@/memory/consolidate` store 사용, 레저가 가리키는 `@/agent/memory/stage1-store`+vendor-glob consume는 caller 0 → consolidate/delete 결정.
- **SP-25 ratelimit DualWindowStore 죽은 half**: `parseDualWindowSnapshot`는 live(`stream-consume.ts:199`), per-account `DualWindowStore.observe/current`는 caller 0 → `.observe()`를 같은 헤더경로서 호출하거나 삭제.

**검증**: god-code green, 삭제행은 `decision: delete-proven-duplicate`+duplicate_of/lifecycle_evidence, 삭제 후 typecheck+테스트 green, red-on-injection(삭제 seam import 복원→컴파일 실패로 dead 확증).

## Track 3 — 진짜 신규 배선 (작은 실 갭, SOTA++ additive) 【SP-3x】

어딧이 확증한 **진짜 코드 갭 6건**. 각 헬게이트(RED-first e2e)+헬어딧≥3R.

- **SP-31 typed-event-store durable reader / resume** ★핵심: 지금 store는 dead write-sink(append만, `.since()/.snapshot()` 실소비 0). C1이 밝힌 진짜 "durable resume" 갭이 여기. reader를 (a)observability sink 또는 (b)세션 resume 경로에 배선 → typed-event-store+compaction-event-emit+context-change store-side가 살아남. 소비자: `createContextEventsProducer`(factory.ts:171, 현재 caller 0)를 live로 승격하거나 resume rehydrate에 연결.
- **SP-32 conversation message rehydrate RFC** ★최대 gap: restart 넘어 *대화 메시지* 복원(현재 seq만, ticket-05서 KILL됨). SOTA++/ROI무관 방향이면 재개 — RFC로 설계결정 재litigate(Codex는 state_5.sqlite로 default-ON). `sdk/runtime/session.ts:54`(durableTip seq-only)+`connect.ts:194`(resumeFromSeq 부재).
- **SP-33 model-preset `/presets` 슬래시커맨드**: `model-preset.ts`(resolveModelPreset/BUILTIN_MODEL_PRESETS/createStickyPresetResolver) 완전 빌드, caller 0 → CLI 슬래시커맨드 신설(opusplan식 role→model). 가장 깨끗한 저위험 갭.
- **SP-34 @@app / plugin:// mention resolver 배선**: 파서는 7-sigil 분류 live지만 `buildDefaultMentionResolver`(default-resolver.ts:167)가 plugins/apps deps 안 넘김 → `@@app`/`plugin://`는 항상 null. apps 카탈로그+plugin 레지스트리 주입(default-OFF knob).
- **SP-35 web-surface @-mention 배선**: mention 파이프라인은 `installCliMentionInjector`로 CLI-only, `web-daemon`에 바인딩 0 → web 주입기 신설.
- **SP-36 effort-ladder 상시화(interactive)**: 현재 `effortLadderLimits`는 batch/eval만 소비, agent loop은 별개 effort-classifier 사용 → Codex식 per-turn 상시 effort를 loop에 배선(신규).

## Track 4 — 진짜 dormant 21 seam (forward-contract) 【SP-4x】

라이브 소비자 없는 진짜 seam. SOTA++/ROI무관 = **내부 소비자를 만들 수 있는 것은 만들고, 외부의존은 forward-contract로 보존**. 각각 RFC+consumer 설계.

- **내부 소비자 배선 가능(신규 작업 후보)**: streaming-boomerang/streaming-cancellation-primitive(loop이 AbortSignal 채택), template-literal-windsurf(barrel 노출+skill/playbook 소비), multi-source-rules-vendor-detector(rule-load서 detectAll), node-repl-persistent-kernel(도구 등록), budget-probe-ledger-wire(pipeline budget-gate 스테이지 구성), model-tag-auto-hook/versioning(retrieval 캐시 무효화 배선), codex-r2-observability-decorators(MetricsRegistry 스레드), compaction-visibility(post_compact 훅 구독자).
- **외부의존 = forward-contract 보존(건드리면 손해)**: bridge-attestation(서명 시크릿), jwks-agent-identity(외부 IdP), message-batches-client-core(폴링 인프라), codex-r2-{sqlite-session-registry, multi-process-flock}(disk 레지스트리 selector), voice(mic 바이너리+STT), realtime-ws(유료 소켓), github-*(gh auth), dockersandbox(Docker 데몬).
- **model-preset-sticky-resolver**: SP-33이 소비자 신설로 해소(dormant→wired).

## Track 5 — efficacy A/B (operator, 코드갭 아님) 【SP-5x】

- **SP-51**: 행동 게이트 5종(adaptive-thinking/edit-repair-loop/reasoning-carryover/closeout-critic/subagent-read-inbox) — rail-1(behavior-regression)은 per-gate real-loop e2e로 이미 커버, rail-2(SWE f2p)는 벤치박스서 ON/OFF 돌리면 됨(신규 코드 0). f2p 오르면 default-ON flip.
- **SP-52**: 벤치 knob 14종 knob-sweep A/B.
- **SP-53(minor)**: `runtimeConfig`-seam paired factory로 `runPairedAB`가 4개 게이트 로컬 커버(현재 per-gate e2e와 중복이라 nice-to-have). `dof22-behavioral-gate-sweep.test.ts:293`.

---

## 시퀀싱 (de-risk 순 — correctness→consolidation→wiring→dormant→AB)

1. **Track 1 먼저** (SP-11~15) — 진실보정+라쳇. 이후 모든 판단의 토대(뭐가 이미 wired인지 확정). 무위험, 빠름.
2. **Track 2** (SP-21~25) — 중복 삭제/통합. Track 3 배선이 죽은 seam을 안 건드리게 선행.
3. **Track 3** (SP-31,33,34,35,36) 병렬 — 파일-disjoint 웨이브. SP-32(rehydrate)는 RFC 먼저.
4. **Track 4** — 내부소비자 배선을 병렬 웨이브(각 seam disjoint), 외부의존은 forward-contract 문서화.
5. **Track 5** — operator 벤치(코드 완료 무관 언제든).

**병렬 안전 레시피**([[parallel-wave-landing-coupled-hotpath]]): 각 에이전트 자기 src+자기 feature yaml+새 test만, 공유파일(ledger/생성 md/컴포지션 루트) receipt 텍스트반환→부모 순차적용, dirty seam 스킵, worktree cp-land+MAIN tsc backstop.

## 중복구현·배선 리스크 요약 (유저 질문 직답)

- **중복구현 발견 5건**(Track 2): retrieval/semantic 포트, recovery-router, .codex-plugin discovery, stage1 orphan store, DualWindow store. 배선 대신 **삭제/통합**해야 — 안 그러면 dead code 2벌.
- **배선문제**: "held/dormant" 라벨의 44%가 실은 env-gated-live(배선 이미 됨). "배선 필요"로 착각해 재배선하면 중복. → Track 1 진실보정이 이걸 차단.
- **진짜 배선 갭**은 6건뿐(Track 3)이고, 그중 핵심은 typed-event durable reader(SP-31)+대화 rehydrate(SP-32).
- **OFF byte-identity / bench 재현성**: Track 3/4 배선은 전부 default-OFF+bench empty-deps 불변식 유지 필수(semantic 실임베딩·durable registry·context-change는 bench 재현성 깨므로 bench는 OFF 고정).
