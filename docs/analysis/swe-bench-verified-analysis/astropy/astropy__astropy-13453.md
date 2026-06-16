---
instance_id: astropy__astropy-13453
repo: astropy/astropy
base_commit: 19cc80471739bcb67b7e8099246b391c355023ee
version: "5.0"
difficulty: "15 min - 1 hour"
created_at: 2022-07-14T10:04:40Z
fail_to_pass: 1
pass_to_pass: 9
gold_files: [astropy/io/ascii/html.py]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
astropy 테이블을 HTML로 출력할 때 `write(..., format="html", formats=...)`로 전달한 컬럼별 포맷터가 무시된다. CSV/rst/MRT 등 다른 ASCII 라이터는 동일한 `formats`를 정상 반영한다. 즉 HTML 라이터만 `formats` 명세를 포맷팅 파이프라인에 연결하지 못해, 숫자가 포맷되지 않은 원본 표현으로 출력된다.

## 유형 (정형화)
- **L (Localization) = L1**: 이슈 본문에 직접 심볼은 없으나, 이슈 코멘트(hints)가 `astropy/io/ascii/html.py`의 `HTML.write()`와 `core.py`의 `str_vals`/`_set_col_formats`를 정확히 지목한다. 키워드("html", "formats")로 단일 파일에 수렴 — 약간의 탐색이면 충분.
- **S (Repair Strategy) = S2 (+S5)**: 고칠 위치는 좁혀지나, "왜 HTML만 누락되는가"의 불변식을 추론해야 한다. 베이스 `BaseData.str_vals()`는 `_set_fill_values(self.cols)` 다음에 `_set_col_formats()`를 호출하지만, `HTML.write()`는 이 베이스 데이터 경로를 우회(override)하므로 두 단계가 빠진다. 올바른 식은 "베이스가 하던 두 동작을 HTML 경로에 복원" — 정형 결함클래스(가드/상수)가 아니라 누락된 계약 단계를 추론 합성하는 S2. 의도된 동작이 다른 라이터의 관례에서 재구성된다는 점에서 S5 보조.
- **K (Knowledge) = K-Domain**: astropy ascii I/O 내부 구조(`HTMLData` vs `BaseData`, `col.info.format`/`iter_str_vals`, `_set_col_formats`가 `self.cols`에 의존) 지식이 병목. 일반 파이썬 추론만으로는 누락 지점을 못 짚는다.
- **primary = T-DomainBound**: 진짜 난점이 프레임워크 내부 계약(데이터 클래스가 포맷을 어디서 주입하는지)을 아는 데 있다. localize는 hints로 쉬워졌지만 픽스의 정당성은 도메인 지식에서 나온다.
- repair strategy 근거(APR): 후보를 무작위로 던지는 G&V가 아니라, 베이스 경로와 HTML 경로를 대조해 "빠진 두 호출"을 의미론적으로 합성하는 SemFix류 S2가 정확히 들어맞는다.

## 난이도 티어
**T3 (중간)**. 구조적 피처:
- 파일수 1개, 골드 패치 +2줄 — scope는 T1~T2급으로 작다.
- has-repro: 이슈에 실행 가능한 재현 코드 + 기대 출력이 있어 easiness 신호가 강하다.
- 그러나 localize 직접성은 L1이고, **픽스의 정당성**(왜 `self.data.cols = cols`와 `_set_col_formats()` 둘 다 필요한지)이 도메인 추론을 요구한다. `_set_col_formats()`만 추가하면 `self.cols`가 비어 있어 동작하지 않는다 — 순서·의존 추론 함정.
- regression-trap: PASS_TO_PASS 9개가 모두 동일 HTML 라이터의 fill_values/multicolumn/masked 경로라, 추가 호출이 기존 출력을 깨면 안 된다.

공식 라벨 "15 min - 1 hour"와 정합. 코드량은 작지만 cols 주입 누락이라는 비자명한 의존 때문에 T2가 아닌 T3.

## 골드패치 분석
- **파일·함수**: `astropy/io/ascii/html.py`의 `HTML.write(self, table)`.
- **근본원인**: `HTML.write()`는 베이스 `BaseData.str_vals()` 경로를 우회하는 자체 출력 로직을 가진다. 베이스 `str_vals()`는 `self._set_fill_values(self.cols)` → `self._set_col_formats()` 순으로 컬럼 포맷(`col.info.format`)을 `formats={}` 키워드에서 주입한다. HTML 경로는 `self.data.header.cols`만 세팅하고 `self.data.cols`를 세팅하지 않으며 `_set_col_formats()`도 호출하지 않는다. `_set_col_formats()`는 `self.cols`를 순회하므로, cols 미주입 시 호출해도 무효다 → 포맷이 영영 적용되지 않음.
- **수정요지**: 두 줄 추가. `self.data.header.cols = cols` 뒤에 `self.data.cols = cols`를 두어 데이터 객체에 컬럼을 주입하고, `self.data._set_fill_values(cols)` 뒤에 `self.data._set_col_formats()`를 호출해 `formats` 딕셔너리를 각 `col.info.format`에 반영한다. 이후 HTML이 컬럼을 `iter_str_vals()`로 직렬화할 때 주입된 포맷이 적용된다.

## 검증 (test_patch)
- **FAIL_TO_PASS** `test_write_table_formatted_columns`: 정수 컬럼 `C1`에 `"04d"`, 부동소수 `C2`에 `".2e"` 포맷을 주고 `table.write(sp, format="html", formats=formats)` 출력을 정확한 HTML 문자열과 비교한다. `0001`/`0002`, `1.23e-11`/`-9.88e+11`이 셀에 들어가야 통과. 패치 전에는 원본 숫자가 출력되어 실패, 패치 후 `_set_col_formats()`가 `col.info.format`을 세팅해 통과.
- **픽스 증명**: 테스트가 정수·과학표기 두 포맷을 동시에 검증해 "특정 포맷만 우연히 통과" 가능성을 줄인다. cols 주입과 포맷 적용이 둘 다 일어나야만 정확 문자열이 나온다.
- **overfit/regression**: PASS_TO_PASS 9개가 fill_values·multicolumn·masked 등 HTML 라이터 핵심 경로를 모두 커버. 추가된 `_set_col_formats()`는 `formats`에 등록된 컬럼만 건드리므로 포맷 미지정 케이스는 무변경 → regression 안전. overfit 위험은 낮으나 FAIL_TO_PASS가 1개뿐이라 overfit-risk 가능성은 존재(테스트가 함수형 포맷터 lambda 경로는 직접 검증 안 함).

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "formats가 HTML에서만 무시된다"와 hints의 직접 링크(`html.py` `write`, `core.py` `str_vals`/`_set_col_formats`)를 따라 `HTML.write()`로 진입. 다른 라이터는 베이스 `BaseData.str_vals()`를 타는데 HTML만 자체 경로라는 비대칭을 식별.
2. **픽스**: 베이스가 수행하는 두 동작(cols 주입 + `_set_col_formats()`)을 HTML 경로에 복원. `self.data.cols = cols`로 `_set_col_formats()`가 순회할 대상을 채우고, `_set_col_formats()` 호출로 `formats` 딕셔너리를 `col.info.format`에 매핑. 이는 "HTML 특수 케이스 하드코딩"이 아니라 기존 포맷 계약을 재사용하므로 올바른 일반화 — 모든 컬럼·모든 포맷 스펙(문자열 또는 callable)에 동작.
3. **regression 안전**: 추가 호출은 `formats`에 키가 있는 컬럼만 `col.info.format`을 덮어쓰므로, fill_values/multicolumn/masked 등 포맷 미지정 PASS_TO_PASS 경로의 출력은 바이트 동일. `_set_fill_values(cols)`는 이미 호출되던 것이라 순서 보존.
4. **함정 회피**: (a) `_set_col_formats()`만 추가하고 `self.data.cols = cols`를 빠뜨리면 `self.cols`가 비어 무효 — 두 줄이 짝이어야 함을 놓치기 쉽다. (b) hints 코멘트의 임시 우회안(`col.info.format`을 직접 루프로 세팅)을 그대로 베끼면 `self.data.formats` 캡슐화를 우회해 덜 일반적 — 베이스의 `_set_col_formats()` 재사용이 정도(正道). (c) `HTMLData.str_vals`를 HTML 경로가 안 탄다는 사실을 모르고 `core.py`를 고치면 다른 라이터를 깨뜨린다 — 수정은 반드시 HTML 경로 안에서.
