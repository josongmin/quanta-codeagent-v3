---
instance_id: astropy__astropy-14365
repo: astropy/astropy
base_commit: 7269fa3e33e8d02485a647da91a5a2a60a06af61
version: "5.1"
difficulty: "15 min - 1 hour"
created_at: 2023-02-06T19:20:34Z
fail_to_pass: 1
pass_to_pass: 8
gold_files: [astropy/io/ascii/qdp.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S2)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`ascii.qdp` 포맷 리더는 QDP 명령어(`READ SERR 1 2` 등)가 대문자라고 가정한다. 그러나 QDP 자체는 대소문자를 구분하지 않아 손으로 작성한 파일에는 `read serr 1 2`처럼 소문자 명령이 흔하다. 이 경우 리더는 라인을 인식하지 못하고 `ValueError: Unrecognized QDP line: read serr 1 2`로 크래시한다. 대소문자 무관하게 명령·`NO` 토큰을 인식해야 한다.

## 유형 (정형화)

- **L0 (Pinpointed)**: 이슈 본문이 "the regex that searches for QDP commands is not case insensitive"라고 근본 원인과 위치를 사실상 지목한다. 스택트레이스의 `raise ValueError(f'Unrecognized QDP line: ...')`도 단일 함수 `_line_type`로 직행시킨다. grep 한 방.
- **S1 (+S2)**: dominant은 기계적 Direct-Map — 정규식 컴파일에 `re.IGNORECASE` 플래그를 추가하는 정형 픽스. 보조로 S2(Constraint-Reasoning)가 약하게 끼는데, regex만 고치면 데이터 파싱 경로의 리터럴 `v == "NO"` 비교가 소문자 `no`를 놓치는 두 번째 결함을 추론으로 동반 발견해야 완전해지기 때문이다.
- **K-Domain**: QDP 포맷의 토큰 의미(`READ [TS]ERR`, `NO`=마스킹 값)와 "qdp 도구는 case-insensitive"라는 포맷 계약을 알아야 올바른 범위를 잡는다. 일반 파이썬 추론만으론 두 번째 사이트를 놓치기 쉽다.
- **primary = T-DirectMap**: 위치가 명확하고 픽스가 "대소문자 무시 추가"라는 정형 결함클래스에 템플릿 매칭된다. APR 관점에서 PAR/TBar식 패턴(flag/normalize 삽입)으로 바로 도출되는 형태라 G&V 반복이 필요 없다.

## 난이도 티어

**T2 (쉬움)**. 구조적 피처: 단일 파일(`qdp.py`) 1개, 2 헌크 총 2줄 변경, localize 직접성 최상(L0, 이슈가 원인을 적어줌), `has-repro`(네이티브 스택트레이스+재현 입력 존재 — 가장 강한 easiness 신호). 다만 T1이 아닌 이유는 픽스가 두 사이트에 걸쳐 있고(regex + 데이터루프), 한 사이트만 고치면 round-trip이 부분 실패하므로 가벼운 도메인 추론(S2)이 끼기 때문. 공식 라벨 "15분-1시간"과 정합(T2 상한). P2P 8개 round-trip 테스트가 인접 동작을 묶어 약한 regression-trap 존재.

## 골드패치 분석

- **파일/함수**: `astropy/io/ascii/qdp.py`의 두 지점.
  1. `_line_type(line, delimiter=None)`: 라인 타입 분류용 정규식 `_line_type_re = re.compile(_type_re)` → `re.compile(_type_re, re.IGNORECASE)`. 이 regex는 `_command_re = r"READ [TS]ERR(\s+[0-9]+)+"`와 `_new_re`(NO 반복)를 포함하므로, IGNORECASE 한 줄로 `read serr`, `no` 모두 매칭된다.
  2. `_get_tables_from_qdp_file(...)`: 데이터 값 파싱 루프의 `if v == "NO":` → `if v.upper() == "NO":`. 마스킹 토큰 `NO`를 대소문자 무관하게 `np.ma.masked`로 변환.
- **근본 원인**: 명령·토큰 인식이 대문자 리터럴/대소문자 민감 regex에 하드코딩되어 QDP의 case-insensitive 계약을 위반.
- **수정 요지**: 분류 regex에 `re.IGNORECASE` 부여 + 데이터 경로의 `NO` 비교를 `v.upper()`로 정규화. 두 사이트 모두 고쳐야 헤더+데이터 전체가 소문자인 파일이 깨지지 않는다.

## 검증 (test_patch)

- **FAIL_TO_PASS (1개)**: `test_roundtrip[True]`. 기존 `test_roundtrip`을 `@pytest.mark.parametrize("lowercase", [False, True])`로 확장하고, 헬퍼 `lowercase_header(value)`가 주석(`!`로 시작) 외 모든 라인을 `.lower()`로 변환한다. `lowercase=True` 분기는 명령(`read serr`)과 데이터 토큰(`no`)을 전부 소문자화한 QDP를 write→read 라운드트립한다.
- **픽스 증명**: regex IGNORECASE가 없으면 `_line_type`이 소문자 명령 라인에서 `ValueError`를 던지고, `v.upper()`가 없으면 소문자 `no` 데이터 셀이 마스킹되지 않아 round-trip 동치 비교가 실패한다. 두 픽스가 함께 있어야 `[True]`가 통과.
- **overfit 관점**: `lowercase_header`가 비주석 라인 전체를 소문자화하므로 명령·`NO` 양 사이트를 동시에 압박 — 한쪽만 고친 special-case 패치는 통과 못 한다. overfit 위험 낮음.
- **regression 관점**: `test_roundtrip[False]`(원본 대문자 경로)와 `test_get_tables_from_qdp_file`, `test_read_example` 등 P2P 7개가 대문자 동작을 그대로 보존하는지 가드. IGNORECASE/`upper()`는 대문자 입력에 무해해 P2P 불변.

## 모범답안 (오라클 기반)

1. **localize**: 이슈의 "regex ... not case insensitive" + 스택트레이스 `Unrecognized QDP line`을 따라 `qdp.py::_line_type`의 `_line_type_re = re.compile(_type_re)`로 직행. L0이라 탐색 비용 거의 0.
2. **픽스**: `re.compile(_type_re, re.IGNORECASE)`로 명령/`NO` regex를 대소문자 무관화. 이게 토큰별 리터럴 변형(`Read|READ|read`...)을 나열하는 것보다 일반적이고 QDP 계약("아무 케이스나 허용")을 정확히 표현하는 올바른 일반화. 이어 데이터 경로 `_get_tables_from_qdp_file`의 `v == "NO"`를 `v.upper() == "NO"`로 정규화 — regex만 고치면 라인은 인식되나 소문자 `no` 셀이 마스킹 안 되는 잠복 버그가 남기 때문.
3. **regression 안전**: P2P의 `test_roundtrip[False]`·`test_read_write_simple`·`test_read_example`가 기존 대문자 입력 동작을 잠근다. IGNORECASE와 `upper()`는 대문자 슈퍼셋 동작이라 이들을 깨지 않음을 확인.
4. **함정 회피**: 오라클 없는 에이전트가 흔히 regex 한 줄(`_line_type`)만 고치고 종료 → `test_roundtrip[True]`의 데이터 셀 라운드트립에서 조용히 실패. 두 번째 사이트(`v == "NO"` 데이터 비교)는 스택트레이스에 안 나오므로, "헤더 인식만 고치면 끝"이라는 가정을 버리고 소문자 `no` 데이터 값까지 추적해야 한다. 또한 명령 토큰만 개별 lower-casing하는 좁은 패치는 regex 전반(`NO` new-row 등)을 놓쳐 일부 라인에서 재크래시.
