---
instance_id: astropy__astropy-14539
repo: astropy/astropy
base_commit: c0a24c1dc957a3b565294213f435fefb2ec99714
version: "5.1"
difficulty: "15 min - 1 hour"
created_at: 2023-03-16T18:45:19Z
fail_to_pass: 2
pass_to_pass: 46
gold_files: [astropy/io/fits/diff.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약
`io.fits.FITSDiff`가 동일한 파일을 자기 자신과 비교해도 차이가 있다고 잘못 보고한다. 재현 코드는 `format='QD'`(또는 `QJ`) 같은 VLA(variable-length array) 컬럼에서만 버그가 나며, 동일 파일 비교가 `identical=False`를 반환하고 "50.00% different" 같은 허위 차이를 출력한다. 즉 가변길이 배열 컬럼의 diff 처리가 잘못되어 있다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈 본문은 "VLA 처리가 culprit"라고만 하지만, hints_text가 정확한 파일·라인(`astropy/io/fits/diff.py` `_diff`의 `"P" in col.format` 분기)과 픽스 diff까지 그대로 제시한다. grep `"P" in col.format` 한 방이면 끝. localize 비용 사실상 0.
- **S1 (Direct-Map)**: 픽스가 기계적이다. VLA를 나타내는 FITS 포맷 코드는 `P`(32-bit descriptor)와 `Q`(64-bit descriptor) 두 가지인데, 코드가 `P`만 검사하고 `Q`를 누락했다. 누락된 OR 조건 하나를 추가하는 것 — 정형 "missing-case" 결함클래스에 템플릿 매칭.
- **K-Domain**: 왜 `Q`를 추가해야 하는지는 FITS 바이너리 테이블 규격(`P` vs `Q` = 32/64-bit 가변길이 디스크립터)을 알아야 한다. 일반 파이썬 추론만으로는 "Q도 VLA"라는 사실을 못 끌어낸다. 단 hints가 이를 떠먹여줘서 실제 지식 병목은 약하다.
- **primary = T-DirectMap**: 위치 명확(L0) + 픽스가 단일 분기조건에 케이스 추가(S1). S2(식 합성) 아님 — 올바른 동작 로직은 이미 `P` 분기에 존재하고 그 분기에 `Q`를 합류시키기만 하면 된다. APR 관점에서 PAR/TBar류 "조건 확장(expand-conditional)" 템플릿의 교과서적 인스턴스.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 1파일·1라인(`diff.py` `@@ -1449`)·헌크 1개, has-repro(완전한 재현 스니펫 + fitsdiff 출력), localize 직접성 최상(L0). 픽스 자체는 자명(`or "Q" in col.format`). 공식 라벨은 "15분-1시간"인데, 이는 코드 변경(분초)이 아니라 **테스트 작성** 때문이다 — `Q` 컬럼을 기존 `test_identical_tables`/`test_different_table_data`에 추가하고 `diff_total`/`diff_ratio`/리포트 문자열 기대값을 전부 재계산해야 한다(0.65→0.682, 13→15). 그래서 T1(존나쉬움)이 아니라 T2: regression-trap이 약하게 있고(46개 P2P, diff_ratio 산술이 인접 테스트와 얽힘), `Q`가 VLA라는 도메인 사실 1개가 K-Gen을 K-Domain으로 끌어올린다.

## 골드패치 분석
- **파일·함수**: `astropy/io/fits/diff.py`, `TableDataDiff._diff` (라인 1449 근방).
- **근본원인**: 컬럼 데이터 diff를 계산할 때, 부동소수 배열은 `where_not_allclose`로, 그리고 VLA 컬럼은 별도 element-wise 비교 분기로 처리한다. 이 VLA 분기 진입 조건이 `elif "P" in col.format:` 뿐이라, 64-bit 디스크립터를 쓰는 `Q` 포맷 VLA가 이 분기를 타지 못하고 일반(배열) 비교 경로로 떨어진다. 가변길이 row를 ragged하게 비교하면서 동일 데이터인데도 차이로 오판된다.
- **수정요지**: 분기 조건을 `elif "P" in col.format or "Q" in col.format:`로 확장. `Q` 컬럼도 `P`와 동일한 per-index VLA 비교 로직(`[idx for idx in range(len(arra)) if not np.allclose(...)]`)을 타게 만든다. 비교 알고리즘 자체는 그대로, 진입 게이트만 넓힌 것.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**: `test_identical_tables`, `test_different_table_data`. 둘 다 기존 테스트에 `Column("K", format="QJ(2)", ...)`(`Q` 포맷 VLA)를 추가.
  - `test_identical_tables`: 동일 테이블 비교 시 `diff.identical`이 참이고 `common_columns`가 11개여야 함 — 패치 전에는 `K` 컬럼이 허위 차이를 내 `identical=False`로 실패.
  - `test_different_table_data`: `K`의 row 0/1 차이가 `diff_values[13]`/`[14]`에 정확히 잡히고, `diff_total==15`, `diff_ratio≈0.682`, 리포트 문자열 "15 different ... (68.18% different)"까지 검증.
- **픽스 증명**: 패치 전 `Q` 컬럼은 분기를 못 타 동일 데이터도 다르다고 나오므로 `test_identical_tables`의 `identical` 단언에서 즉시 실패. 패치 후 `P`와 같은 정밀 비교를 타 식별·diff 모두 정확.
- **overfit·regression 관점**: overfit-risk 낮음. 테스트가 identical(허위차이 없음)과 different(정확한 차이 인덱싱+비율 산술) 양쪽을 다 덮어, "Q를 무조건 같다고 처리" 같은 special-case 꼼수는 different 테스트에서 깨진다. regression: 46개 P2P가 `P` VLA(`PI(2)`)·일반 컬럼 비교를 그대로 유지하는지 보장 — OR 추가는 기존 `P`/non-VLA 경로를 건드리지 않으므로 안전.

## 모범답안 (오라클 기반)
1. **localize**: 재현 스니펫의 `format='QD'`와 이슈의 "VLA handling" 단서 → `diff.py`에서 컬럼 포맷 분기를 찾는다. VLA 처리는 FITS에서 디스크립터 포맷(`P`/`Q`)으로 식별되므로 `col.format` 분기를 grep → `TableDataDiff._diff`의 `elif "P" in col.format:` 도달. (hints 없이도 "VLA = P 또는 Q"라는 규격 지식이면 `P`만 검사하는 게 즉시 의심됨.)
2. **픽스**: `Q`를 동일 VLA 분기에 합류(`or "Q" in col.format`). 올바른 일반화인 이유 — `Q`는 `P`와 의미가 같은(64-bit) 가변길이 디스크립터라 비교 알고리즘이 동일해야 한다. 새 로직을 짜는 게 아니라 검증된 `P` 경로를 재사용하는 것이므로 과소·과대 명세 위험이 없다.
3. **regression 안전**: `P` VLA·non-VLA·float 비교 경로(`where_not_allclose`, `PI(2)` 테스트)를 건드리지 않는다. OR 분기는 순수 확장이라 기존 46 P2P가 그대로 통과. diff_ratio 산술이 컬럼 수에 의존하므로, 테스트를 고칠 때 `Q` 컬럼 추가에 맞춰 분모/비율 기대값을 일관되게 재계산해야 한다.
4. **함정 회피**: (a) "Q를 같다고 skip"하면 different 테스트 실패 — 반드시 `P`와 동일한 element-wise 비교를 타게 해야 함. (b) 코드 변경만 하고 테스트의 `diff_total`/`diff_ratio`/리포트 문자열 기대값 재계산을 빠뜨리면 FAIL_TO_PASS의 산술 단언에서 실패. (c) `"Q" in col.format`을 `startswith` 등으로 과하게 좁히면 `QJ(2)`/`QD` 같은 실제 포맷 표기를 놓침 — 골드처럼 `in` 부분일치가 정답.
