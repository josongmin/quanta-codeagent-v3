# jul-12 OmO 흡수 — Track 2: UX / MCP / 세션-연속성

- **상태**: audit complete / implementation not started
- **날짜**: 2026-07-12
- **권위**: 이 문서는 **Track 2(UX·MCP·세션 연속성)** 후보군의 조사·판정 SSOT다.
  `00`–`03`은 **Track 1(Agent Runtime Correctness Primitives)**이며 두 트랙은
  disjoint하다(§0 참조). hashline만 겹치고 거기서도 결론이 동일하다(전체 에디터 흡수
  금지, remap 힌트만 — `03`과 이 문서가 일치).
- **North-star**: agent-state observability(뭘 하고 / 왜 멈췄고 / 다음 무엇). 이 축이
  Track 2 우선순위를 가른다.
- **Hard constraints**: 중복구현 금지 · 싸구려 휴리스틱 금지 · hellgate(RED→green→
  적대어딧 ≥3R) · measure-first / default 무해(byte-identical) — 단 leak/orphan류
  correctness class는 red-on-injection 증명이면 A/B 없이 착지 자격(Track 1과 동일 규율).

---

## 0. 배경 — 이 문서가 왜 생겼나 (two-track 재조정)

이 디렉터리는 원래 OmO senpi-task lifecycle / chaos-bench / hashline을 조사해 **3개
correctness primitive**(ResourceScope · SimulationKernel · VersionedWorkspace)로 재설계한
Track 1이었다(`00`–`03`, 이미 SOTA++ 어딧 완료, `00 §0`).

그 뒤 별도 세션에서 OmO **전 표면(45 패키지)**을 다시 훑었다 — 이번엔 correctness가 아니라
**엔드유저 UX·MCP 연결·세션 워크플로** 각도로. 그 결과 나온 후보군(durable resume ·
built-in MCP · OS 알림 · skill_mcp · goal-continuation · init-deep)은 Track 1의 3
primitive와 **디스크상 대응 슬라이스가 없었다**. 완결성 크리틱이 이 프레이밍 충돌을 잡았고,
확인 결과 **충돌이 아니라 두 개의 독립 흡수 트랙**임이 드러났다:

| | Track 1 (`00`–`03`) | Track 2 (이 문서) |
|---|---|---|
| 도메인 | process lifecycle · async 상태머신 · stale-edit 복구 | 세션 연속성 · MCP 연결 UX · 알림/관측 표면 |
| 흡수원 | senpi-task `lifecycle/` · `chaos-bench` · hashline | omo-opencode hooks/features · pi-goal · boulder-state · mcp/ |
| 성격 | correctness primitive | product/UX surface |
| 겹침 | hashline(전체 에디터) → **cheap-hint만**(RFC `03`) | hashline(줄단위) → **DROP**(§3.5). 결론 일치 |

두 트랙은 파일 경합이 거의 없다(Track 2 착지 순서는 §5). 이 문서는 Track 2를 Track 1과
**같은 SOTA++ 렌즈**(north-star 정렬 · scope cut · measure-first · seam-완성 축)로 판정한다.

---

## 1. 감사 방법론 (왜 이 판정을 신뢰하나)

Track 2 판정은 단발 리뷰가 아니라 **다단계 적대 감사**의 산물이다. 판정 신뢰의 근거로 방법을
남긴다:

1. **전수 기능 인벤토리** — 45 패키지 × (기능 + quanta 대응 + 흡수 ROI) 병렬 스캔.
2. **9-차원 적대 감사(85 에이전트)** — 각 발견을 독립 스켑틱이 **반증 시도**. 75건 중
   confirmed 65 / overstated 6 / refuted 4. 반증 4건이 1차 리뷰의 실제 오류를 잡음
   (예: "hashline core/omo 이중구현" → 실제론 재export 배럴, 로직 복제 0).
3. **decision-ready 후보 감사(7 병렬)** — 각 후보를 [이식대상 / seam / knob / 공수 /
   함정 / GO·HOLD]로.
4. **3-라운드 hellaudit(21 에이전트)** — 적대(R1) → 객관(R2) → 수렴(R3) 2시선 루프를
   3축(중복/배선-only · 있는데 발전 · 아키텍처 퀄)으로. **이 라운드가 1차 판정을 크게
   뒤집음**(§3).
5. **load-bearing 사실 직접 검증** — 아래 판정의 근거 파일:라인을 이 세션에서 직접 grep/read로
   확인(§2).

핵심 교훈: **"dangling seam이라 배선만 하면 됨" 서사가 전 후보에서 과낙관이었다.** 3-라운드가
파일을 직접 까서 "port는 있는데 producer가 없다 = 배선 이상의 작업"임을 반복 확인했다.

---

## 2. quanta가 이미 증명하는 것 (직접 검증된 dangling seam)

Track 2의 근본 발견 = quanta의 병증은 **typed default-OFF seam을 producer보다 먼저 깖**.
이 세션에서 파일로 확인한 미완 seam 목록(이게 흡수보다 우선하는 실작업):

- **stop-category consumer 미배선**: `src/agent/stop-category.ts:36-39,204` — `needs_user_approval`
  arm이 존재하나 주석이 *"NOT wired by default; reserved for the admissibility-gate seam"*.
  → OS 알림(§3.1)이 이 consumer를 공급 = seam 완성.
- **planSnapshotStore impl 없음**: `src/agent/loop/session-snapshots.ts`의 save/restore 가드는
  루프에 배선됐으나, `planSnapshotStore` 할당은 **테스트에만 존재**
  (`src/agent/loop/__tests__/session-start-abort-cause.test.ts:116`), 프로덕션 composition-root
  할당 0. → durable-resume(§3.2)이 fs impl을 공급 = seam 완성.
- **continuation.ts caller 없음**: `src/agent/objective/continuation.ts` = **Codex `core/src/goals.rs`
  흡수본(H17)**. `QUANTA_GOAL_ENFORCE` → `goalContinuationEnforce` knob은
  `src/shared/runtime-config.ts:212`에 있으나 `runIdleContinuation`을 부르는 idle-monitor/reactor
  seam이 없어 **프로덕션 caller 0 = DEAD**. → goal-continuation(§3.3)의 진짜 작업은 omo 흡수가
  아니라 **이 기존 코드 배선**.
- **ResourceScope owner 계약 없음**(Track 1): `src/host/runtime/side-agent-fork-port.ts:75-82`
  `kill()`가 reap/descendant containment 없이 SIGTERM만.

- **north-star substrate LANDED**: `src/agent/run-ledger/`(north-star #2). lifecycle receipt와
  세션 상태는 새 event stream 만들지 말고 여기로 report(`00 §0.2`와 동일 규율).

**함의**: 최고ROI는 omo 설계 흡수가 아니라 **이 seam들을 닫는 것**. omo의 실제 기여는
(a) senpi lifecycle/chaos 패턴(Track 1), (b) ~40줄 toast 프리미티브 + placeholder-key 정규화 +
context7/grep_app URL(Track 2)로 쪼그라든다. 나머지는 "이미 소유·우월" 또는 "net-new를 흡수로
오분류".

---

## 3. 후보별 판정 (3-라운드 수렴, 파일 근거)

3축: **[중복/배선-only]** 진짜 배선만인가 숨은 중복/추가작업인가 · **[발전 vs 흡수]** quanta에
발전시킬 열등본이 있나 · **[아키 퀄]** 흡수가 slice-boundary/tool-surface-ssot/knob 규율에
깨끗이 맞나.

### 3.1 OS 데스크톱 알림 (2-way) — ✅ GO (Phase 0)

- **판정**: GO / 공수 M(크리틱은 S 가능성 제시) / R1·R2 수렴.
- **north-star**: 🎯 직격. 에이전트가 idle/permission으로 멈춘 것을 **터미널 밖(OS 배너+사운드)**으로
  밀어냄 = "왜 멈췄나"의 관측성. 동시에 stop-category의 미배선 consumer를 공급 = **seam 완성**.
- **[중복]** more-than-wiring. `src/apps/cli/notify/port.ts:54-69` `NotificationPort`는 4 멤버
  (onTurnComplete/onIdleAwaitingInput/markActive/dispose)뿐 — permission/question arm 없음.
  OS-native toast 코드는 repo 어디에도 없음(osascript/notify-send/powershell grep = clipboard·RCE분류기·
  shell-dialect 3건뿐, toast 0). 유일 어댑터는 `osc-adapter.ts`(OSC 타이틀+BEL, 터미널 전용).
- **[발전]** enhance-existing. quanta는 이미 **우월한** per-REPL anti-spam(slow-turn 게이트 + once-per-idle
  latch + `shouldPush` SSOT + measurable PushStats). omo `session-notification-scheduler.ts`(186줄,
  1500ms 디바운스 + 다중세션 Map + eviction)는 opencode 멀티세션 event-bus 모델이라 **충돌** → 흡수 X.
- **[아키]** minor-debt. hexagonal port에 native 어댑터 sibling drop-in(`resolveNotifyChannel`에 "native"
  값 추가). ⚠️ osascript가 `policy-rules.ts`의 RCE-bypass 분류기(SHELL_GROUP:26 / INTERP_GROUP:39)에
  걸리므로 **신뢰 내부 seam(node:child_process 직행, paste-cmd.ts 패턴)으로만 spawn**, 에이전트 도구
  표면 경유 금지.
- **스코프 컷**: **2-way(idle+permission)만**. question arm은 유령 — `src/tool/surface/manifest.ts`에
  ask-user 툴 자체가 없어 omo의 questionMessage 분기가 dead code. omo의 assistant-텍스트 배너 content
  빌더는 **프라이버시(OS 알림센터 유출)로 드롭**, 고정 문구만.
- **작업**: (1) `NotifyChannel`에 native 값 + `createNativeNotificationPort` sibling(~40줄/플랫폼
  toast만 lift, de-opencode'd) (2) port에 `onPermissionAwaitingInput` arm 추가 + `buildCliOnConfirm`
  (`runtime-context-compose.ts:418`) 단일 choke에서 호출, `CliHitlDeps`에 notify handle 스레딩
  (3) 기존 latch+shouldPush SSOT 유지. knob `QUANTA_NOTIFY` 계열 확장, default-OFF.

### 3.2 durable session resume — ✅ GO-scoped (Phase 1)

- **판정**: GO-scoped / 공수 M(1차 S~M은 과낙관) / 수렴.
- **north-star**: ○ 세션 연속성(N/M 완료, 어디부터 재개).
- **[중복]** more-than-wiring. port는 wired인데 impl 0 **+ DI 미관통**: `SessionDeps`/`config.ts`가
  planStore는 spread하나 planSnapshotStore는 안 함. 스코프 4~5 seam(store off PlanSnapshot ·
  SessionDeps 필드 · bootstrap 팩토리 · config spread · path 해석). mirror 템플릿
  `followUpQueueSnapshotStore`도 미구현이라 베낄 것도 없음. `writeSessionFile` atomic write는
  module-private(재구현 또는 export).
- **[발전]** enhance-existing. quanta plan 스냅샷 모듈이 이미 **우월**(plan-v1 스키마 · freeze-deep
  불변 · round-trip identity · phase membership 불변식) vs omo flat goals json. **omo 설계 수입 금지**,
  누락된 fs 어댑터 하나만.
- **[아키]** clean. sidecar 파일이 export된 `sessionFilePath`/`sanitizeId` 재사용 → RMW 락 회피.
  ⚠️ **repo 밖(`~/.quanta/sessions/`) 유지** — repo-local `.omo/`식 두면 concurrent-session이
  commit로 끌고 감(concurrent-session git hazard). ⚠️ crash-resume(`src/session/crash-resume.ts`,
  중단-턴 재개)와 **직교** — 경쟁 interrupted-marker 만들지 말 것. progress truth = **structured
  todo.status 하나**(omo식 .md 파싱 재발명 금지).
- **작업**: `defaultPlanSnapshotStore(sessionId)` fs impl + DI 스레딩 + resume 시 "N/M 완료,
  '<next>'부터" 주입 + **Run Ledger report**(`00 §0.2`). knob `QUANTA_PLAN_RESUME` default-OFF
  byte-identical.

### 3.3 goal continuation — 🔁 재정의 (Phase 2, 효능 게이트)

- **판정**: omo 흡수 **DROP**, 대신 **기존 continuation.ts 배선**으로 재정의 / 수렴.
- **north-star**: ◐ jun-29 oracle-loop 프론티어(우리 측정 최상위 갭 = single-pass). 단 **최고위험**.
- **[중복]** omo "clean-stop predicate"는 portable 코드가 아님 — `session.idle` auto-continue
  서브시스템(~2900줄) + `<promise>`/oracle-subagent sentinel(opencode plugin 런타임 결합) +
  ulw 331줄 시스템프롬프트. default 라벨이 literally "unbounded".
- **[발전]** already-sufficient(흡수 대상으로서). quanta는 goal-continuation을 **이미 3중**으로 소유:
  (1) converge 2-bound 루프(`converge/protocol.ts:54,66` maxRounds+watchdog) (2) `recovery.js`
  bounded caps (3) ADR-0242 StopReasonPolicy(Cursor 3.2.16 verbatim). 그리고 §2의 **continuation.ts
  H17(Codex 흡수, DEAD)**.
- **[아키]** significant-debt if absorbed. omo 수입 = reverted "keep going" 재범(`converge/loop.ts:11`
  "blanket keep-going 3×-over-persisted and was reverted"). "converge에 배선" 주장은 **plane 착오**
  (converge는 self-test receipt를 읽지 stopReason 아님).
- **재정의된 작업**: omo 짓지 말고 **continuation.ts를 idle-monitor/reactor seam에 bounded로 배선**.
  기존 2-bound 상속(unbounded 금지) + oracle-gated. **R2 revert 재범 방지가 최우선 제약** →
  default-OFF 랜딩 후 box A/B f2p net-positive 전엔 켜지 말 것(measure-first 하드룰).

### 3.4 built-in remote MCP (context7 / grep_app) — ⏳ GO-scoped (Phase 2)

- **판정**: GO-scoped / 공수 S~M / 수렴. **north-star ✗**(capability only) → 우선순위 낮음.
- **[중복]** more-than-wiring. "0 built-in" 확인(`src` grep context7|grep_app|exa|tavily = 0;
  `BUNDLED_MCP_CONNECTORS` = stdio 4개뿐). quanta 커넥터는 **install-on-demand**(LLM이
  `mcp_connector_install` 호출). omo 가치 = quanta에 없는 **always-on/zero-config posture**.
- **[발전]** enhance-existing. `McpConnectorEntry`가 이미 transport:http+url+requiresOAuth 모델링 →
  URL만 추가. **omo createBuiltinMcps 통째수입 = 카탈로그/거버넌스 재발명**.
- **[아키]** minor-debt. ⚠️ **거버넌스 우회 위험**: `filterMcpServersByPolicy`가 `readMcpConfig`
  **내부**에서 돌므로(`mcp-composition.ts:351-357`), naive하게 readMcpConfig **후** append하면 E2
  denylist를 조용히 건너뜀. built-in은 반드시 governed choke **위로** splice(`internal.ts:621`
  OAuth resolve 전). ⚠️ **headers 필드 신설**: `McpConnectorEntry`엔 per-server http header 필드가
  없음(env는 stdio 전용) → context7 Authorization:Bearer를 위해 **스키마+transform 변경** 필요
  (2행 데이터 편집 아님). placeholder-key 정규화(omo `context7.ts:21-29`, "your api key"/빈값 거부)만
  이식 가치.
- **주의**: context7 default-ON은 quanta default-OFF 규율의 **measure-first 예외** → opt-in +
  off-switch 문서화.

### 3.5 skill_mcp — 🔁 재정의 (Phase 2)

- **판정**: omo gateway 흡수 **금지**, 대신 **quanta path-B 완성** / 공수 M~L / 수렴.
  **north-star ✗**.
- **[중복]** more-than-wiring. path-B(ADR-0476 attach 엔진, `skill-mcp-attach-adapter.ts`)는 서버를
  붙이나 툴 통로 없음 — `McpServerHandle`이 shutdown()만 노출(ADR-0338 teardown-only by design),
  chain 전체에 listTools/callTool grep = 0. `IsolatedMcpClient`는 listTools()/callTool()을 갖는데
  shutdown 클로저 안에 갇혀 버려짐. **참고**: 1·2차가 인용한 `startMcpServersAndBridge`는 **환각**
  (심볼 부재); 실제 path-A 통로는 `mcp-bridge.ts:944 loadMcpTools`.
- **[발전]** enhance, do NOT absorb. omo gateway(N개 툴/리소스/프롬프트를 free-form `arguments`
  단일 툴로 붕괴)는 quanta의 per-tool 스키마·권한·§19 미디어안전·F1 disambiguation을 **퇴행**시킴.
- **[아키]** significant-debt if absorbed / clean if enhanced. tool-surface-ssot는 per-tool 거버넌스
  카탈로그 → N→1 붕괴가 SSOT 모델을 구조적으로 무력화. **올바른 수**: path-B의 이미 뜬
  IsolatedMcpClient를 **기존 loadMcpTools/mcpToolToTool 통로로** 흘려 per-tool 스키마/권한/미디어/F1을
  공짜로 획득. 공수 M~L(새 client-노출 port + gated 툴 + drift-guard row + HITL) — "배선"이 아님.

### 3.6 init-deep — ⏳ 기회시 (Phase 2)

- **판정**: GO / 공수 S / **north-star ✗**. (3-라운드에서 structured-output 실패로 미수렴 →
  **재검증 필요**, 아래는 decision-audit 결과.)
- **[중복/발전]** quanta에 이미 write-mode `/init` skill 존재 → **계층 생성으로 확장**(onboard는
  read-only 유지). explore fan-out + codegraph(semantica) grounding 인프라 보유.
- **[아키]** skill-only, 코드 위험 0. ⚠️ **스코어링 weight(3x/2x/>15)는 검증 안 된 매직넘버** →
  코드 hard-gate 금지, **프롬프트 가이던스로만**(no-heuristics-only-validated 준수). write-safety
  `<critical>`(exists→Edit/else→Write) 이식 필수, `--create-new` delete-all은 default 금지.

### 3.7 DROP (흡수 안 함)

- **hashline 전체 에디터**: net-new ~1400줄 병렬 라인-주소 에디터. quanta가 anti-clobber를 **이미
  3중**(line_ranges 스코프 · expected_hash sha256 precondition · default-ON mtime stale-guard)으로
  커버. 1차 "~400 tok/read"는 **팩트 오류**(실제 ~3byte/줄). 유일 잔여가치=줄단위 drift UX →
  원하면 기존 실패 메시지에 drifted line-span만 추가(= RFC `03` cheap-hint, Track 1 소유).
- **omo continuation 서브시스템 / omo skill_mcp gateway / omo notify 스케줄러 / category-model
  매핑 / tmux 라이브페인 / discipline agents**: 중복 또는 아키텍처 선결조건 부재 또는 net-new 오분류.

---

## 4. 통합 phasing (양 트랙)

north-star × measure-first × correctness-class 게이트.

**Phase 0 — correctness + north-star (지금, <3일). red-on-injection 또는 byte-identical 착지.**
- Track 1: R0 + R1-stopgap(`side-agent-fork-port.ts:78` owner 계약) + R2 chaos reducer
  (`00 §0.1`; leak-fix=correctness class, A/B 불요).
- Track 2 §3.1: **OS 알림 2-way** — stop-category seam 완성, north-star 직격.

**Phase 1 — dangling-seam 완성 (default-OFF byte-identical, 저위험).**
- Track 2 §3.2 durable-resume(planSnapshotStore + Run Ledger report).
- Track 1: histogram diff(`00 §0.5`, V-lane 독립 slice, 가장 값싼 확실한 SOTA 상승) + hashline cheap-hint.
- Track 2 §3.6 init-deep(기회시, 재검증 후).

**Phase 2 — 효능 게이트 뒤 (`00 §0.6`/§11.1 baseline 측정 먼저, 무의미하면 CUT).**
- Track 2 §3.3 continuation.ts 배선(bounded+oracle-gated, jun-29 프론티어지만 최고위험 → A/B 필수).
- Track 2 §3.4 built-in MCP + §3.5 skill_mcp-conduit(engagement 측정).
- Track 1: R1-full / S2-full / V-lane three-way(`00 §0.1` defer).

---

## 5. 착지 순서 (파일 경합 기준)

```text
durable-resume ──(격리, 언제나 병렬안전)
OS-notify ──────(stop-category+notify port)
skill_mcp-conduit ─┐
built-in MCP ──────┘ (둘 다 mcp-composition.ts; gateway 먼저,
                       built-in은 applyPolicy 위로 splice)
```

- durable-resume: `src/session/` sidecar 격리, 경합 0 → 아무때나.
- OS-notify: `src/apps/cli/notify/` + `stop-category.ts` + `extra.ts` knob 이웃. MCP 클러스터와 무관.
- skill_mcp-conduit **먼저**, built-in MCP **나중**: 같은 `mcp-composition.ts`. built-in은 gateway
  라우팅 테이블이 존재한 뒤 슬롯되고, `applyPolicy` **위로** splice해야 denylist 우회 안 남.

---

## 6. 최종 근거 요약 (why this shape)

1. **흡수라 부를 진짜 코드는 작다** — senpi lifecycle/chaos 패턴(Track 1) + ~40줄 toast +
   context7/grep_app URL(Track 2). 나머지 가치는 전부 **quanta 자신의 미완 seam을 닫는 것**.
2. **판별축 하나** — *"이 후보가 기존 dangling seam을 닫나, 새 seam을 여나?"* GO(resume=snapshot
   producer, notify=stop-category consumer)와 DROP(hashline·continuation=새 seam)이 이걸로 갈린다.
3. **north-star를 실제로 움직이는 건 소수** — Phase 0의 두 항목(ResourceScope owner 계약 +
   OS 알림 2-way)만이 correctness와 north-star를 즉시 움직이고 착지 자격이 있다(전자 red-on-injection,
   후자 stop-category consumer 공급). 그 외는 measure-first 뒤로.
4. **1차 "배선만" 서사는 과낙관이었다** — 3-라운드 hellaudit가 전 후보에서 "port 있는데 producer
   없음 = 배선 이상"을 파일로 확인. 이 문서의 공수 상향(S→M, M→M~L)은 그 산물.

---

## 7. 상태 보드 (Track 2)

| Slice | 판정 | 상태 | 코드 기반 | 차단/게이트 |
|---|---|---|---|---|
| OS 알림 2-way | GO (P0) | TODO | NotificationPort · stop-category(미배선) · osc-adapter | RCE분류기 회피 seam |
| durable resume | GO-scoped (P1) | TODO | planSnapshotStore port(impl 0) · plan-v1 스냅샷 | crash-resume 직교 확인 |
| init-deep | GO (P2) | TODO(재검증) | write-mode /init skill · explore fan-out | scoring=prompt-only |
| built-in MCP | GO-scoped (P2) | TODO | BUNDLED_MCP_CONNECTORS · McpConnectorEntry | headers 스키마 · governance 순서 · 효능 |
| skill_mcp conduit | 재정의 (P2) | TODO | path-B attach(orphan) · loadMcpTools 통로 | drift-guard row · HITL · 효능 |
| continuation 배선 | 재정의 (P2) | DEAD 코드 존재 | continuation.ts H17(caller 0) | R2-revert 재범 방지 · A/B 필수 |
| hashline 전체에디터 | DROP | — | 3중 커버 존재 | — |

final design이라는 것이 구현 완료를 뜻하지 않는다. `TODO`를 문서 점수로 승격하지 않는다.

---

## 8. 조사 계보

- 이 문서 판정은 §1 5단계 감사(전수 인벤토리 → 9-dim 85-agent 적대 → 7-후보 decision → 3-라운드
  hellaudit 21-agent → load-bearing 직접검증)의 수렴.
- Track 1(`00`–`03`)과 disjoint. 점수·순서·강도가 `00`(Track 1 SSOT)과 충돌하면 각 트랙 SSOT를
  따른다(이 문서 = Track 2 SSOT, `00` = Track 1 SSOT).
