---
instance_id: astropy__astropy-14369
repo: astropy/astropy
base_commit: fa4e8d1cd279acf9b24560813c8652494ccd5922
version: "5.1"
difficulty: 1-4 hours
created_at: 2023-02-06T21:56:51Z
fail_to_pass: 3
pass_to_pass: 732
gold_files: [astropy/units/format/cds.py, astropy/units/format/cds_parsetab.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약

`format='ascii.cds'`(또는 `u.Unit(..., format='cds')`)로 `10+3J/m/s/kpc2` 같은 다중 슬래시 복합단위를 파싱하면 나눗셈 결합 순서가 뒤섞여 `1000 J s / (kpc2 m)`처럼 잘못 나온다. CDS 표준은 `a/b/c`를 `((a/b)/c)`로 좌결합 읽어야 하는데, CDS 파서만 틀린다(일반 generic 파서는 정상). 힌트가 원인 파일을 `astropy/units/format/cds.py`로 직접 지목한다.

## 유형 (정형화)

- **L1 (Traceable)**: 이슈/힌트가 `astropy/units/format/cds.py`의 파서를 명시. 다만 "어느 grammar rule"인지는 파서 문법을 읽고 추론해야 함 → L0 아님.
- **S2 (Constraint-Reasoning)**: 후보를 마구 시도하는 게 아니라, YACC 문법의 결합성(associativity)을 따져 올바른 production을 합성해야 함. 픽스는 `division_of_units` 규칙 한 줄을 `unit_expression DIVISION combined_units`(우재귀=우결합)에서 `combined_units DIVISION unit_expression`(좌재귀=좌결합)으로 바꾸는 것. 식 자체를 "생각으로" 도출.
- **K-Domain**: PLY/YACC LALR 문법과 결합성 규칙, CDS 단위 표기 도메인 지식 필요.
- **primary = T-ConstraintReason**: 위치는 좁게 잡히지만, 진짜 난점은 "어떤 production이 좌결합을 만드는가"를 문법론적으로 추론하는 데 있음. S1 템플릿(가드/상수)으로 환원 불가.

APR 관점: 이건 SemFix/Angelix류 의미적 합성 — 잘못된 결합 production이라는 단일 결함을 올바른 불변식(좌결합)으로 교정. G&V로 무작위 후보를 던지면 LALR 충돌이나 다른 케이스 회귀를 부를 수 있어 추론 우위.

## 난이도 티어

**T4 (약간 어려움)**. 구조적 피처:
- 파일 수 2개지만 `cds_parsetab.py`는 PLY가 생성하는 **파생 캐시 테이블** — 사람이 손으로 쓰는 게 아니라 `cds.py` 문법 수정 후 재생성되는 산출물. 실질 의미 변경은 `cds.py` 1줄.
- localize 직접성: 힌트가 파일을 줘서 L1로 좁지만, "한 줄"을 짚으려면 LALR 문법 구조 이해 필요(반자명).
- has-repro: 재현 MRT/표현식 명확 → easiness 신호.
- P2P trap: PASS_TO_PASS 58353개로 매우 광범위 — 단위 포매팅/파싱 전반을 안 깨야 함(regression-trap). cross-file-dep: parsetab 미재생성 시 문법-테이블 불일치로 조용히 실패.
- 공식 라벨 `1-4 hours`와 일치(T4). 개발자 시간은 짧을 수 있으나, parsetab 재생성 함정 + 결합성 추론 + 광범위 P2P가 에이전트 난이도를 T4로 유지.

## 골드패치 분석

- **파일·함수**: `astropy/units/format/cds.py`의 `_make_parser` 내부 `p_division_of_units` docstring grammar; 부수적으로 `astropy/units/format/cds_parsetab.py`(PLY LALR 테이블 전체 재생성).
- **근본원인**: `division_of_units` production이 `unit_expression DIVISION combined_units`로 정의됨. `combined_units`가 우변이라 `a/b/c`가 `a / (b/c)` = `a*c/b`로 **우결합** 파싱됨. CDS는 `/`를 좌결합으로 봐야 하므로 `10+3J/m/s/kpc2`가 `J*s/(kpc2*m)`로 뒤섞임.
- **수정요지**: 한 줄을 `combined_units DIVISION unit_expression`으로 뒤집어 **좌결합**(좌재귀)으로 만든다. 이제 `a/b/c → (a/b)/c`. docstring URL도 죽은 bitbucket→purl로 정리(무관). `p_division_of_units` body의 `len(p)==3` 분기 로직은 그대로 — 결합 방향만 문법 레벨에서 교정.

## 검증 (test_patch)

- **FAIL_TO_PASS (217개)**: `test_format.py`의 `test_cds_grammar`/generic 파라미터화에 `"km/s/Mpc"→u.km/u.s/u.Mpc`, `"km/(s.Mpc)"`, `"10+3J/m/s/kpc2"→1e3*W/(m*kpc2)`, `"km/s.Mpc-1"`, `"/s.Mpc"`, `"1.5×10+11/m"→1.5e11/m`, `"/s"→s**-1` 추가. 좌결합이 되어야 통과.
- **픽스 증명**: 다중 `/` 케이스가 정확한 `km/s/Mpc` 결과를 내야만 F2P 통과 → 결합 방향 교정이 직접 원인-효과로 검증됨. `/s` 단독 division도 `DIVISION unit_expression` 규칙으로 여전히 통과(앞 분기 보존 확인).
- **overfit/regression**: F2P 217 + P2P 58353로 표면 매우 넓음 → 결합 한 케이스만 special-case하면 다른 단위 표기가 깨져 통과 불가. 즉 weak-test로 인한 overfit 위험은 낮음(테스트가 일반화 강제). regression-trap은 큼 — parsetab을 재생성 안 하면 LALR 테이블이 옛 문법이라 조용히 옛 결과를 내 P2P 일부가 깨질 수 있음.

## 모범답안 (오라클 기반)

1. **localize**: 이슈가 "generic은 정상, CDS만 jumbled" + 힌트가 `cds.py`를 지목 → `_make_parser`의 grammar productions로 직행. `/` 처리 규칙 `p_division_of_units` 식별. 증상(`a/b/c → a*c/b`)을 결합성 문제로 해석.
2. **픽스**: `division_of_units : unit_expression DIVISION combined_units`를 `combined_units DIVISION unit_expression`으로 변경. 우변에 재귀항(`combined_units`)을 두면 우결합, 좌변에 두면 좌결합 — CDS `/`의 좌결합 의미와 일치하므로 올바른 일반화(한 입력이 아닌 모든 다중 division에 작동).
3. **regression 안전**: `DIVISION unit_expression`(선행 `/x` = 역수) 분기를 보존해야 `/s`, `/s.Mpc`가 유지됨. PASS_TO_PASS 58353(단위 round-trip/포매팅 전반)을 안 깨려면 문법 변경 후 **반드시 PLY 캐시(`cds_parsetab.py`)를 재생성**해 테이블이 새 production을 반영하게 한다.
4. **함정 회피**: 오라클 없는 에이전트의 최빈 실패는 (a) `cds.py`만 고치고 `cds_parsetab.py` 미갱신 → 캐시된 옛 테이블로 동작해 "고쳤는데 그대로"; (b) parsetab을 손으로 편집하려다 LALR state 번호가 어긋남. 정답은 문법만 손보고 PLY가 테이블을 재생성하게 두는 것. 또 product_of_units의 우결합과 헷갈려 둘을 같이 뒤집으면 곱셈 결합/충돌 회귀 — division 규칙만 좌결합으로.
