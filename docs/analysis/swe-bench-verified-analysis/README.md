# SWE-bench Verified — 문제별 분석

SWE-bench Verified 500문제 전체를 **문제별로 까볼 수 있게** 정리한 레퍼런스.
각 문제마다 골드패치(정답) 기반 분석 md를 둔다 — 유형 분류 + "뭘 조져야 하는지" 공략 포인트.

> ⚠️ 분석 md는 **골드패치 스포일러 포함**이다. 우리 에이전트가 블라인드로 푸는 학습셋이 아니라,
> 사람이 문제 유형을 빠르게 파악하고 리뷰하기 위한 레퍼런스다.

## 구성

```
swe-bench-verified-analysis/
  README.md                  ← 이 파일
  _data/
    verified-full.jsonl      ← 이전됨 → tools/leaderboard-dashboard/rawdata/verified-full.jsonl (원시 500 rows, HF princeton-nlp/SWE-bench_Verified)
    by-instance/<id>.json    ← 인스턴스별 분리 레코드 (분석 에이전트 입력)
    django-ids.json          ← django 인스턴스 id 목록
    fetch.ts                 ← 데이터 재수집 스크립트
    checkout.sh              ← instance_id → 레포 base_commit 체크아웃
  <repo>/<instance_id>.md    ← 문제별 분석 (레포 basename별 디렉토리)
```

소스 레포는 **이 리포 밖**에 클론한다 (컨텍스트 오염 방지):

```
~/swe-bench-repos/<repo-basename>/    # 풀클론 12개
```

## 분포 (레포 × 난이도)

| repo | <15m | 15m-1h | 1-4h | >4h | total |
|---|--:|--:|--:|--:|--:|
| django | 92 | 117 | 22 | 0 | 231 |
| sympy | 25 | 43 | 6 | 1 | 75 |
| sphinx | 22 | 17 | 4 | 1 | 44 |
| matplotlib | 15 | 19 | 0 | 0 | 34 |
| scikit-learn | 13 | 18 | 1 | 0 | 32 |
| astropy | 4 | 15 | 3 | 0 | 22 |
| xarray | 5 | 15 | 1 | 1 | 22 |
| pytest | 8 | 8 | 3 | 0 | 19 |
| pylint | 3 | 5 | 2 | 0 | 10 |
| requests | 6 | 2 | 0 | 0 | 8 |
| seaborn | 0 | 2 | 0 | 0 | 2 |
| flask | 1 | 0 | 0 | 0 | 1 |
| **total** | **194** | **261** | **42** | **3** | **500** |

## 분석 진행 상태

| repo | 정형화(type+tier+모범답안) |
|---|---|
| django | ✅ 231 / 231 |
| sympy | ✅ 75 / 75 |
| sphinx | ✅ 44 / 44 |
| matplotlib | ✅ 34 / 34 |
| scikit-learn | ✅ 32 / 32 |
| astropy | ✅ 22 / 22 |
| xarray | ✅ 22 / 22 |
| pytest | ✅ 19 / 19 |
| pylint | ✅ 10 / 10 |
| requests | ✅ 8 / 8 |
| seaborn | ✅ 2 / 2 |
| flask | ✅ 1 / 1 |
| **전체** | **✅ 500 / 500** |

하드 티어(T5 + 추론무거운 T4) 84개는 별도 **적대적 인과검증 패스** 완료 — inverted-causality·wrong-owner·off-by-one 등 인과오류 자동 정정. 상세 [_data/causal-audit-workflow.js](_data/causal-audit-workflow.js).

## 정형화 분포 (전체 500개)

분류 루브릭은 [TAXONOMY.md](TAXONOMY.md) (APR 문헌 + SWE-bench 난이도 실증연구 근거). 난이도는 에이전트 solve-rate가 아니라 **구조적 피처**로 매김(메모리제이션 confound 회피).

**레포 × 티어:**

| repo | T1 존나쉬움 | T2 쉬움 | T3 중간 | T4 약간어려움 | T5 어려움 | T6 매우어려움 | 합 |
|---|--:|--:|--:|--:|--:|--:|--:|
| django | 15 | 69 | 56 | 74 | 17 | 0 | 231 |
| sympy | 5 | 20 | 31 | 17 | 2 | 0 | 75 |
| sphinx | 1 | 11 | 18 | 10 | 4 | 0 | 44 |
| matplotlib | 0 | 9 | 16 | 9 | 0 | 0 | 34 |
| scikit-learn | 1 | 17 | 12 | 1 | 1 | 0 | 32 |
| astropy | 0 | 6 | 10 | 5 | 0 | 1 | 22 |
| xarray | 1 | 7 | 11 | 2 | 1 | 0 | 22 |
| pytest | 2 | 5 | 8 | 4 | 0 | 0 | 19 |
| pylint | 0 | 3 | 4 | 2 | 1 | 0 | 10 |
| requests | 0 | 6 | 2 | 0 | 0 | 0 | 8 |
| seaborn | 0 | 0 | 0 | 2 | 0 | 0 | 2 |
| flask | 0 | 1 | 0 | 0 | 0 | 0 | 1 |
| **합** | **25** | **154** | **168** | **126** | **26** | **1** | **500** |

**유형(primary_type) 분포:** ConstraintReason 201 / DirectMap 172 / DomainBound 75 / DesignRefactor 27 / SpecInference 13 / LocTrivial 7 / DiffuseLoc 4 / GenValidate 1.

**Knowledge 의존:** K-Domain **412 / 500 (82%)** / K-Gen 62 / K-API 26 — SWE-bench Verified의 본질은 일반 코딩이 아니라 **프레임워크 내부지식**(ORM/compiler/autodoc/assumptions). 우리 에이전트 grounding의 핵심 타깃.

> 읽는 법: ConstraintReason(올바른 식·조건을 추론 합성)이 최다 유형(40%) — "어디"보다 "정확히 무엇"이 난점. T6(매우어려움)은 astropy 1건뿐 — 공식 >4시간 라벨 3건 중 나머지는 구조적 피처상 T5 이하로 재배정됨(시간≠에이전트 난이도).

## 각 md 구조 (정형화 후)

frontmatter: `primary_type` / `tier` / `loc_axis` / `repair_strategy` / `knowledge` / `flags` (머신리더블) + gold_files·F2P·P2P.

본문:
- **문제 요약**
- **유형 (정형화)** — 3축(Localization/Repair-Strategy/Knowledge) 점수 + primary type + APR 관점 근거
- **난이도 티어** — 6티어 + 구조적 피처 근거 (공식 라벨과 다르면 왜)
- **골드패치 분석** — 건드린 파일·함수 / 근본 원인 / 수정 요지
- **검증 (test_patch)** — FAIL_TO_PASS 동작 / 픽스 증명 / overfit·regression 관점
- **모범답안 (오라클 기반)** — 이상적 풀이 궤적 4단계: localize 경로 → 픽스(왜 올바른 일반화) → regression 안전 → 함정 회피

## 재현 / 사용법

```bash
# 데이터 재수집 (HF rows API, tests/smoke/swebench/select.ts와 동일 소스)
bun run docs/analysis/swe-bench-verified-analysis/_data/fetch.ts

# 특정 문제를 코드로 까기 (레포가 ~/swe-bench-repos에 클론돼 있어야 함)
docs/analysis/swe-bench-verified-analysis/_data/checkout.sh django__django-11099
# → ~/swe-bench-repos/django 가 base_commit으로 체크아웃됨
```

레포 클론 (1회):
```bash
mkdir -p ~/swe-bench-repos && cd ~/swe-bench-repos
for r in django/django sympy/sympy sphinx-doc/sphinx matplotlib/matplotlib \
         scikit-learn/scikit-learn astropy/astropy pydata/xarray pytest-dev/pytest \
         pylint-dev/pylint psf/requests mwaskom/seaborn pallets/flask; do
  git clone "https://github.com/$r.git" "$(basename $r)"
done
```
