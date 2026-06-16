---
instance_id: sphinx-doc__sphinx-10466
repo: sphinx-doc/sphinx
base_commit: cab2d93076d0cca7c53fac885f927dde3e2a5fec
version: "5.0"
difficulty: "15 min - 1 hour"
created_at: 2022-05-22T16:46:53Z
fail_to_pass: 1
pass_to_pass: 6
gold_files: [sphinx/builders/gettext.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약

`make gettext`로 .pot 카탈로그를 생성할 때, 동일한 `(source, line)` 위치가 한 메시지(msgid)에 중복으로 들어가 `#: file.rst:0` 같은 location 주석이 여러 번 반복 출력된다. 이슈 제출자는 원인을 `sphinx/builders/gettext.py`로 정확히 지목하고, `set()`으로 중복 제거하는 해법까지 제안한다. 기대 동작은 한 메시지의 location 목록에 중복이 없어야 한다는 것이다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈가 파일명(`sphinx/builders/gettext.py`)과 메서드(`__init__`)를 직접 거명하고, 실제 픽스 지점인 `Catalog.__iter__`까지 한 클래스 안에 있다. grep 한 방은 아니지만 후보가 단일 파일·단일 클래스로 즉시 수렴. 제출자가 `__init__`이라 했으나 진짜 데이터 소스는 `__iter__`의 `positions` 리스트 컴프리헨션 — 약간의 추적이 필요해 L0가 아닌 L1.
- **S2 (Constraint-Reasoning)**: 단순 `list(set(...))`로는 부족하다. set은 순서를 깨뜨려 .pot diff 안정성(결정론적 출력)이라는 불변식을 위반한다. 골드는 `sorted(set(...))`로 **중복 제거 + 결정론적 정렬**이라는 두 제약을 동시에 만족시킨다. 올바른 식을 추론해 합성하는 S2.
- **K-Domain**: gettext/.pot 카탈로그 도메인 지식이 필요. location 중복이 왜 생기고(같은 msg가 여러 uuid로 metadata에 누적), .pot 출력에서 왜 정렬이 중요한지(VCS diff noise) 이해해야 set이 아닌 sorted(set)이 정답임을 안다.
- **primary = T-ConstraintReason**: 위치는 명확하나, 핵심 난점이 "중복 제거 + 순서 보존"이라는 결합 제약을 추론으로 푸는 데 있다. naive set 해법은 P2P를 깨뜨린다.

APR 관점: 결함 클래스는 "중복 누적"이지만 템플릿(S1) `list(set(x))`을 그대로 적용하면 회귀가 난다. 불변식(정렬 안정성)을 따져 식을 합성해야 하므로 S2가 dominant.

## 난이도 티어

**T3 (중간)**. 구조적 피처:
- 파일 1개, 헌크 1개, 실질 변경 2줄 — 매우 작다(T1~T2 신호).
- has-repro: 이슈에 재현 절차·실제 .pot 출력·제안 패치까지 있어 localize 비용 거의 0(easiness 신호).
- 그러나 **regression-trap**이 티어를 T2→T3로 민다: P2P 6개 중 `test_gettext_template_msgid_order_in_sphinxpot`, `test_build_single_pot`가 출력 순서·내용을 검증한다. `list(set())`처럼 순서를 깨는 naive 픽스는 이들을 깰 수 있다. 올바른 일반화(`sorted`)를 골라야 통과.
- 도메인 추론(왜 sorted가 필요한가)이 자명하지 않음.

공식 라벨 "15분-1시간"과 일치. 코드량은 T1급이나 정답 식 선택의 제약 때문에 T3가 타당.

## 골드패치 분석

- **파일/함수**: `sphinx/builders/gettext.py`의 `Catalog.__iter__`.
- **근본원인**: `Catalog.add`가 같은 msgid에 대해 매 등장마다 `(origin.source, origin.line, origin.uid)`를 `self.metadata[msg]`에 append한다. uid는 노드마다 유일하므로, 동일 `(source, line)`이라도 서로 다른 uid 때문에 별개 엔트리로 누적된다. `__iter__`가 `positions = [(source, line) for source, line, uuid in ...]`로 uuid를 떨궈 투영하는 순간, 구별을 만들던 uid가 사라져 `(source, line)` 중복이 그대로 노출된다.
- **수정요지**: 투영 결과에 `sorted(set(...))`를 적용 —
  ```python
  positions = sorted(set((source, line) for source, line, uuid
                         in self.metadata[message]))
  ```
  set으로 `(source, line)` 중복을 제거하고, sorted로 결정론적 출력 순서를 보장. `uuids` 리스트는 손대지 않아 uuid 기반 후속 로직(매핑)은 영향 없음.

## 검증 (test_patch)

- **FAIL_TO_PASS** `test_Catalog_duplicated_message`: `Catalog`에 `'hello'`를 `(/path/to/filename,1)`로 **두 번**, `(filename,2)`·`(yetanother,1)`로 추가하고 `'world'`를 한 번 추가. 기대:
  - `len(list(catalog)) == 2` (메시지 2개)
  - `msg1.locations == [('/path/to/filename',1), ('/path/to/filename',2), ('/path/to/yetanother',1)]` — 중복 (filename,1) 1회로 축약 + **정렬된** 순서.
- **픽스 증명**: base에서는 locations에 (filename,1)이 2번 → 단언 실패. `sorted(set(...))` 적용 후 중복 제거 + 정렬로 정확히 기대 리스트 산출.
- **overfit 관점**: 테스트가 정렬 순서까지 못박아 `list(set())`(순서 비결정)을 배제 → 골드의 sorted를 강제. 얇은 단일 테스트지만 정렬 단언이 overfit 방지 teeth 역할.
- **regression**: P2P의 `..._msgid_order_in_sphinxpot`, `test_build_single_pot`이 실제 빌드 출력을 검증 — sorted라 결정론 유지되어 안전. set 미적용/순서파괴 픽스라면 이쪽이 깨질 수 있다.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 `sphinx/builders/gettext.py`를 직접 지목 → `Catalog` 클래스를 읽는다. 제출자가 말한 `Message.__init__`는 단순 저장소일 뿐, 실제 location 리스트가 만들어지는 곳은 `__iter__`의 `positions` 컴프리헨션임을 확인. 데이터 흐름 `add`(uid 포함 append) → `__iter__`(uid 투영 제거 시 중복 표면화)를 추적해 수정 지점을 `__iter__`로 확정.
2. **픽스**: `positions` 컴프리헨션을 `sorted(set(...))`로 감싼다. set만으로는 부족 — gettext .pot은 VCS에 커밋되므로 비결정 순서는 무의미한 diff를 만든다. sorted가 결정론적 출력을 보장하는 올바른 일반화. uuids는 별개 의미(노드 식별)라 그대로 둔다.
3. **regression 안전**: `uuids` 리스트는 변경 금지 — uid는 i18n 후속 처리의 키. positions와 uuids의 길이가 더 이상 1:1이 아니게 되지만(중복 제거로 positions가 짧아짐), 골드는 이를 의도적으로 허용(positions=표시용, uuids=식별용 분리). `..._msgid_order_in_sphinxpot`·`single_pot` P2P가 안 깨지는지로 검증.
4. **함정 회피**: (a) 제출자 제안대로 `Message.__init__`에서 `list(set())`만 하면 **순서 비결정**으로 P2P diff 테스트 회귀 — sorted 필수. (b) 수정 위치를 `__init__`로 오인하면 근본 데이터 소스를 놓침. (c) hints에 babel·os.path.relpath·PYTHON_FORMAT 등 광범위한 곁가지 제안이 있으나 모두 scope 밖(babel은 외부 패키지) — 이슈 본문의 핵심 1줄(중복 제거)에 집중해 over-engineering을 피해야 한다.
