---
instance_id: matplotlib__matplotlib-26113
repo: matplotlib/matplotlib
base_commit: 5ca694b38d861c0e24cd8743753427dda839b90b
version: "3.7"
difficulty: "<15 min fix"
created_at: 2023-06-12T18:56:33Z
fail_to_pass: 1
pass_to_pass: 812
gold_files: [lib/matplotlib/axes/_axes.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

## 문제 요약
`Axes.hexbin`의 `mincnt` 파라미터가 `C` 파라미터 유무에 따라 의미가 1만큼 어긋난다. `C=None`일 때는 `mincnt=1`이면 "데이터 ≥1개인 셀"을 그리는데, `C`가 주어지면 같은 `mincnt=1`이 "데이터 ≥2개인 셀"만 그린다. 이슈는 원인 라인(C 분기의 `len(vals) > mincnt`)과 기대 동작(`>=`로 통일)까지 직접 명시하며, breaking change를 감수하고 `C is None` 분기와 일관되게 맞추자고 제안한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: 이슈가 파일·라인(`_axes.py` L4625 근처)과 정확한 표현식 `len(vals) > mincnt`를 직접 지목한다. grep 한 방. localize 노력 사실상 0.
- **S2 (Constraint-Reasoning)**: 고칠 지점은 자명하나, 올바른 비교 연산자(`>` vs `>=`)를 두 분기의 불변식 정합으로 추론해야 한다. `C is None` 경로의 count-임계 의미(`len >= mincnt`)와 동일 의미로 합성해야 맞다. 단순 가드/기본값 추가(S1)가 아니라 "두 코드패스의 의미적 동치"를 따져야 하므로 S2.
- **K-Domain (Domain-bound)**: hexbin의 binning 내부구조(`Cs_at_i1`/`Cs_at_i2` accumulator, `[1:]`가 out-of-range 점을 drop하는 관례, `reduce_C_function`이 빈 배열에서 정의 안 됨)를 이해해야 수정이 안전함을 확신할 수 있다.
- **primary = T-ConstraintReason**: 위치는 명확(L0)하나 본질은 "어떤 연산자가 올바른 일반화인가"라는 제약 추론이다. APR 관점에서 이상적 패치는 두 분기 간 불변식을 일치시키는 한 글자 변경이며, GenProg식 다후보 탐색이 아니라 SemFix식 조건 합성으로 1발에 도출된다.

## 난이도 티어
**T3 (중간).** 구조적 피처:
- 파일 1개, 헌크 1개, 실변경 1줄(`>` → `>=`) → scope는 T1~T2급.
- localize 직접성 최상(L0), `has-repro`(완전 재현 스니펫 + 기대/실제 출력 명시).
- 그러나 **단순 텍스트 매핑이 아니라 두 코드패스의 의미적 정합 추론**이 필요(S2)하고, `K-Domain`(빈 셀에서 `reduce_C_function` 미정의라는 도메인 제약 때문에 `>=0`이 아니라 `>=mincnt`로 둬야 함)이 끼어 T2가 아닌 T3로 민다.
- 공식 라벨은 `<15 min fix`(T1~T2 prior). 개발자 구현시간 기준으로는 맞지만, 에이전트 관점에선 "왜 `>=`가 옳고 off-by-one인지"를 두 분기 비교로 논증해야 하고 P2P가 812개(`regression-trap`)라 미세 의미변경이 인접 hexbin 동작을 깰 위험이 있어 한 단계 올린다.

## 골드패치 분석
- **파일·함수**: `lib/matplotlib/axes/_axes.py`, `Axes.hexbin` 내부 `C is not None` 분기의 accumulator 집계 comprehension.
- **근본원인**: `C is None` 경로는 count 마스크를 `counts >= mincnt`(= `mincnt`개 이상)로 적용하는데, `C is not None` 경로는 셀별 누적 리스트 길이에 `len(acc) > mincnt`(= `mincnt` **초과**)를 써서 임계가 off-by-one만큼 어긋났다. 그래서 `mincnt=1`이 C 분기에서는 "≥2개"를 의미하게 됨.
- **수정요지**: `reduce_C_function(acc) if len(acc) > mincnt else np.nan` 에서 `>`를 `>=`로 한 글자 변경하여 두 분기의 임계 의미를 통일. `mincnt is None → 0` 기본화 로직은 그대로 두므로, 기본(미지정) 동작은 `len(acc) >= 0`이 아니라 직전 `[1:]` slicing이 이미 빈/out-of-range 점을 제거하기에 사실상 "≥1개 데이터"가 유지된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_hexbin_mincnt_behavior_upon_C_parameter[png]`. `@check_figures_equal`로 `C` 없이 `mincnt=1`로 그린 ref와 `C=[1]*n, reduce_C_function=sum, mincnt=1`로 그린 test 그림이 **픽셀 동일**해야 한다. 정확히 한 데이터점만 있는 셀(`(6,0)`,`(0,6)`)이 C 경로에서 누락되던 버그를 잡는다 — patch 전엔 `len==1 > 1` 거짓이라 그 셀이 `np.nan`(미표시)이 되어 두 그림이 달라 fail.
- **픽스 증명**: `>=`로 바꾸면 `len==1 >= 1` 참이라 단일점 셀이 ref와 동일하게 그려져 figure equality 통과.
- **overfit/regression**: 테스트가 `check_figures_equal`로 "C 유무 동치"라는 일반 불변식을 직접 검증하므로 special-case 통과가 어렵다(overfit-risk 낮음, 그래서 플래그 제외). 반면 P2P 812개에 hexbin 관련 케이스가 다수라 `regression-trap` — 특히 `mincnt`/`marginals`/log-norm 기존 hexbin 테스트가 의미변경에 민감.

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `_axes.py`의 두 hexbin 분기 라인과 `len(vals) > mincnt` 표현식을 직접 링크. grep `mincnt` → `Axes.hexbin`의 `C is not None` 가지에서 `len(acc) > mincnt` 한 곳으로 즉시 수렴.
2. **픽스**: `C is None` 경로의 임계가 `counts >= mincnt`임을 읽고, C 경로도 `>=`여야 의미가 동치임을 추론. 이는 테스트 한 개에 맞춘 hack이 아니라 "두 코드패스가 같은 `mincnt` 계약을 따른다"는 일반화라 올바르다. `mincnt=0` 시 빈 셀이 들어와 `reduce_C_function([])`가 호출되지 않게 하는 건 `[1:]` slicing이 보장하므로 추가 가드 불필요.
3. **regression 안전**: P2P 812개 중 hexbin 이미지 비교(`test_hexbin`*) 및 `mincnt`/`marginals` 케이스를 안 깨야 한다. `>=` 변경은 임계를 1만큼 낮추므로 `mincnt`를 명시한 기존 테스트만 영향을 받는데, 기존 이미지 baseline은 `mincnt` 미지정(기본 분기)이라 안전.
4. **함정 회피**: 오라클 없는 에이전트의 실수 후보 — (a) `>`를 `>=`가 아니라 `mincnt`를 `mincnt-1`로 깎는 식으로 고쳐 기본분기(`None→0`) 의미를 망가뜨림, (b) C 경로 대신 엉뚱하게 `C is None` 경로를 건드려 두 분기를 반대로 어긋나게 함, (c) 빈 셀 `reduce_C_function` 호출 공포로 불필요한 try/except 가드를 덧대 결과가 달라짐. 정답은 단 하나의 연산자 변경이며, "두 분기 불변식 일치"라는 기준이 이 모든 오답을 배제한다.
