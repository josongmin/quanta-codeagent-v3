# L5 — Rejected / Downgraded findings

R1 objective finder 또는 R2 adversarial pass가 보고했으나, R2 verifier 또는 Claude 본인 재확인에서 **기각(refuted)** 또는 **강등(overstated)** 된 항목. 재제기 방지용 기록. 각 항목: 주장 / file:line / 왜 버그가 아닌지(또는 보정된 severity).

---

## 기각 (Refuted) — verifier가 소스 재확인으로 무효 판정, 본 리포트에서 제외

### FP-1 · sdk-runtime · "side.start()가 signal을 무시"
- **위치:** `src/sdk/runtime/session.ts` side.start
- **판정:** invalid — 인터페이스 계약상 의도된 동작. `_options`는 의도적으로 무시되고 signal은 `sideArgs`에서 전달됨. 버그 아님.

### FP-2 · sdk-runtime · "publishPendingEvents가 snapshot await 누락"
- **판정:** invalid — `updateSnapshot`은 동기(void) 함수라 await 불필요. R1이 async로 오인.

### FP-3 · sdk-runtime · "history 초기화 implicit fallback"
- **판정:** invalid — `messages`는 `AgentConfig` 필수 필드. `[]` 폴백은 도달 불가 dead code이나 안전.

### FP-4 · kernel-session · "emitTurnStreamEvent 변형이 return type 누락"
- **판정:** invalid — 6개 변형 전부 명시 return + `noImplicitReturns`로 컴파일 타임 보장. discriminated union 전수 매칭.

### FP-5 · apps-cli-surfaces · "prompt-pipeline abort 리스너 race (2건)"
- **위치:** `src/apps/cli/repl/prompt-pipeline.ts:233-235`
- **판정:** invalid — 두 리스너가 동기 발화하고 finally(233-235)에서 무조건 `removeEventListener`. race 아님.

### FP-6 · apps-cli-surfaces · "surfaceState 동시 변이"
- **판정:** invalid — async 제어 흐름이 엄격 순차(turn 완료 → onAfterResult 동기 → next() await)라 실제 동시성 없음.

### FP-7 · apps-cli-surfaces · "transcript.replace 에러 전파 누락"
- **판정:** invalid — 콜백이 throw하고 surface-compose 래퍼(454-459)가 흡수·로깅. 누락 아님.

### FP-8 · apps-eval-bench · "buildPythonSwebench optional chaining leak"
- **판정:** invalid — 양 경로(feature-off, harness-unavailable) 모두 명시 로그 + undefined 반환. fail-open + 가시성 정상.

### FP-9 · apps-cli-surfaces · "surface-compose readSession catch가 삼킴"
- **판정:** invalid (moot) — 이미 `logger.warn`로 정상 로깅(no-throw 계약 부합).

---

## 강등 (Downgraded) — 실재하나 R1/R2 severity·framing이 과장 → 보정 후 02 문서로 이동하거나 제외

### FP-A · apps-agent · "runMode/loadDispatcher 에러 삼킴 (HIGH error-swallow)"
- **위치:** [index.ts:770, 778](../../../../src/apps/agent/index.ts#L770)
- **원 주장:** `dispatcher.runMode`/`loadDispatcher`가 try-catch 없어 에러 삼킴, HIGH.
- **Claude 재확인 (정정):** line 800 `runMain().catch`가 **`fatal: <msg>`를 stderr로 출력은 한다** — 완전 무음(error-swallow) 아님. 진짜 결함은 (a) 모든 실패가 `exit 1`로 평탄화(bad mode/missing prompt엔 EX_USAGE 64가 적절) + (b) 모드 컨텍스트 소실. HIGH가 아니라 **MEDIUM code-quality(generic fatal 평탄화)** → [02 M-7](02-medium-low.md#m-7--apps-agent--mode별-필수-필드-검증이-프리셋-런타임까지-지연)로 흡수.

### FP-B · runner-assemble · "search-pipeline reconcile가 직전 배치 rejection 무음 삼킴 (HIGH)"
- **위치:** [search-pipeline.ts:215-228](../../../../src/runner/assemble/search-pipeline.ts#L215)
- **원 주장:** line 219 `.catch(() => undefined)`가 이전 체인 모든 rejection을 무음 변환, HIGH.
- **Claude 재확인 (정정):** reconcile 본체(221-227)는 **이미 자체 try/catch + `logger.warn`(226)**으로 실패를 로깅한다. line 219의 `.catch(() => undefined)`는 본체가 throw하지 않으므로 사실상 dead 방어 코드(체인 시퀀싱 가드)일 뿐 — 실제로 삼켜지는 에러가 없다. **버그 아님에 가까운 LOW 방어-코드 스멜** → 리포트에서 제외(원하면 219를 `.catch((e) => { logger.warn(...); })`로 정리 가능하나 ROI 미미).

### FP-C · apps-agent · "ci-bot dryRun ghost field"
- **위치:** `src/apps/agent/mode-presets/ci-bot.ts`
- **판정:** invalid — 코드 정상(cli-args.ts:54 → index.ts:621 → assemble.ts:86 정상 스레드). 주석만 historical. 버그 아님.

### FP-D · runner-assemble · "buildVectorStoreRuntime rejection 미처리"
- **위치:** [search-index-backend.ts:692](../../../../src/runner/assemble/search-index-backend.ts#L692)
- **판정:** invalid — 모든 코드 경로(query/upsert/delete/reconcile)에서 lazy await됨. 설계상 correct.
