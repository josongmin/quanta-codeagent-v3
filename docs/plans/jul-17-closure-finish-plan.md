# default-OFF SOTA++ 마무리 계획 (FINAL — 적대어딧 3R 수렴)

입력: SOTA++ 보드 in_progress 4개(DOF-20/21/22/40) + DOF-90. 4-way recon + 직접검증 + 적대어딧 3R(claim/gaming · 배선/충돌 · 커버리지/스코프). 원칙: 자율 안전한 것만 실행, gaming 금지, dead-wire 금지, 정직 blocked 명시.

## 적대어딧이 뒤집은 것 (v1 대비 수정)

| v1 주장 | 어딧 결과 | 최종 반영 |
|---|---|---|
| E1: 5게이트 runtimeConfig-seam으로 sweep | ❌ **CRITICAL**: cap-enforcer(dispatch-time)·adaptive-thinking(thinking field)·edit-repair(tool-output wrap) 3개는 harness 8축에 안 보임 → false NO-REGRESSION. delegation-suppress/prompt-directive(systemBytes)만 보임 | E1 재설계: gate별 전용 관측 추가 or UNMEASURABLE 정직 보고 |
| F1/F2: sink 배선 | ❌ **CRITICAL**: onUnattributed/onAttributionFailure를 배선해도 **받을 실 consumer 없음**(observability-wire.ts:162가 안 넘기고, 대상 stream도 미확인) | F0 선행: sink-target 존재 확인. 없으면 배선 안 하고 defer |
| approval-gate-wire = seam-only | ❌ 실제 **consumer-only**(ledger) | ground-truth 정정 |
| fast-apply decision→enable-now = 진보 | ⚠️ risk=behavioral-cost라 policy_gated_live 아님 + 이미 wired라 **closure % 0 영향**. cosmetic | cosmetic 명시 |
| shell-snapshot proof→wire | ⚠️ wire-tier 테스트 실행 receipt 있어야(파일 존재만으론 DOF-00 위반) | 테스트 실행 후에만 flip |
| measure-first 53 전부 operator A/B | ⚠️ 그중 **11 bench-knob + 6 observability = 17개는 behavior-change 아닌 오라벨** → enable-now(unit-sufficient) 정정이 정당·진짜 closure 기여 | E3에 17개 정정 추가 |
| DOF-21 5개 | under-deliver. untrusted-source-envelope(security, wired, measure-first) 누락 | E2에 추가 |
| CLEAN 확인 | 중복구현 0(recovery-router 단일·per-tool 단일·A/B harness 유일), hold→policy_gated_live 정당, guardian fail-open 반증 | 유지 |

## 확정 ground truth (직접검증)
- DOF-22 5게이트 전부 `runtimeConfig()` 읽음(file:line 확인). `__resetRuntimeConfig()`(runtime-config.ts:737) 존재.
- fast-apply-wire·shell-snapshot **이미 reachability=wired**(Wave D). decision/proof만 잔여.
- guardian-assessor **fail-open 아님**(reviewer.ts:255 knob AND port 둘 다 요구, off=legacy safe).
- Wave F 타겟(compaction-wire.ts·observability-wire.ts·loop.ts) 현재 clean.

---

## 실행 계획

### Wave E — tests-only + ledger 정정 (충돌 0, 지금)

**E1. DOF-22 runtimeConfig-seam sweep — 관측축 정직 (tests-only)**
- 신규 `tests/integration/_ab-runtime-config-seam.ts`: env 스냅샷→gate set→`__resetRuntimeConfig()`→scenario→finally 복원+reset. ⚠️병렬 오염 방지: harness의 explicit env-dict 경로 유지, process.env mutation은 factory 내부 try/finally로 국소화, __resetRuntimeConfig로 격리.
- **각 게이트별로 델타가 어느 축에 보이는지 먼저 검증**:
  - delegation-suppress·prompt-directive → systemBytes 축 ⇒ 기존 harness로 PASS.
  - cap-enforcer·adaptive-thinking·edit-repair → harness 8축 불가시 ⇒ **gate별 전용 관측 assertion 추가**(adaptive=stream input thinking field, cap=reminder 주입 카운트, edit-repair=tool output wrap 관측). 관측 못 하면 **UNMEASURABLE 정직 보고**(false NO-REGRESSION 절대 금지).
- DoD: 7 behavioral 게이트 각각 {rail-1 PASS | UNMEASURABLE + follow-up} 명확. efficacy rail-2는 operator.

**E2. DOF-21 security real-loop 승급 (tests-only, real consumer)**
- guardian-per-action-assessment(reviewer 실경로, fail-open 아님·단순 proof)·mcp-tool-annotations-content·circumvention-detector·n6-pty-attach·pre-compact-hitl·**untrusted-source-envelope(추가)**.
- 각: 실 gate+consumer 구동 + paired control + red-on-injection.

**E3. ledger 정정 (코드 0, 정직 라벨)**
- fast-apply-wire: decision repair-first→enable-now **# cosmetic, closure % 영향 0 (이미 wired, risk=behavioral-cost)**.
- shell-snapshot: **wire-tier 테스트 실행해서 green 확인 후** proof on unit→wire + decision→enable-now. 미실행이면 proof 유지.
- approval-gate-wire: ground-truth를 consumer-only로 (내 오류 정정).
- **17개 measure-first→enable-now** (behavior-change 아님 각각 재확인 후): bench-knob 11(adversarial-repro/bench-find-refs/bench-trajectory/fault-evidence/localize-phase/no-patch-breaker/patch-hygiene/primary-rail/repro-doubt/retry-transient/verification-plan) + observability 6(flock-telemetry/observability-live-wire/observability-wire/observability-ws-sink/prompt-cache-observability/proof-driven-bench-closure). → measure-first 53→36, **이게 진짜 closure 기여**.
- auto-mode-rule-overlay·mcp-launch-governance: decision=enable-now vs proof=unit 라벨 충돌 확인·정정.
- fc rails + ledger hellgate 재확인.

### Wave F — clean-seam src, sink-target-first (조건부)

**F0 (선행, read-only)**: approval gap / compaction attribution-failure를 받을 **실 observability consumer가 존재하는지** 확인(observability-wire degraded 채널·event stream·log port). 
- 존재 ⇒ F1/F2 배선(실 sink로 라우팅).
- 부재 ⇒ **배선 안 함**. "sink 대상 없음, dead-wire 회피, promotion owner 기록" 정직 선언. (dead seam 만들기 금지 — 어딧 CRITICAL.)

**F1. compaction onAttributionFailure** — F0 통과 + compaction-wire.ts clean이면 배선.
**F2. approval onUnattributed** — F0 통과 + observability-wire.ts clean이면 배선.
**F3. stage1-phase2 Stage1StorePort** — clean owned seam 없으면(loop.ts hot) **defer**(강행 금지).
착수 전 `git status --short <file>` dirty-guard, dirty면 STOP.

### DOF-90 — closure-state 매핑 + 정직 완료 기준

- ledger 파생 규칙 명시: `default_on`(effective on & host-seeded/always) · `resource_on`(resource/command|port-present) · `policy_gated_live`(wired & 고위험 & decision≠hold, **+ wired & decision=hold=고유 dormant opt-in authority**) · dormant(seam/producer/consumer/forward-contract only).
- 재계산 → objective의 진짜 3-상태 비율 산출. host-seeded 인위 재라벨 **금지**(gaming).
- **정직 완료 기준**: (a) 5 seam-only 중 F0 통과분 wire + (b) 17 오라벨 정정 + (c) measure-first efficacy는 operator SWE(deferred). holds는 실패 아님(objective가 보존 명시). 90% 순수 reachability 미달 시 policy_gated_live 매핑으로 objective-정렬 지표 보고 — 단 매핑 정의를 투명하게.

## 명시적 blocked (정직)
- measure-first behavioral 30행 default-ON: SWE efficacy A/B(EC2/비용/preflight) = operator.
- loop.ts/surface-compose/server.ts 배선: 동시세션 hot 해소 시.
- DOF-50 tauri: cargo.

## 순서
Wave E(E1∥E2∥E3, tests+ledger, 지금 안전) → Wave F(F0 선행 → 통과분만 배선) → DOF-90 재계산.
