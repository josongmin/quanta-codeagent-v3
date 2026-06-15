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
    verified-full.jsonl      ← 원시 500 rows (HF princeton-nlp/SWE-bench_Verified)
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

| repo | 기본 분석 | 정형화(type+tier+모범답안) |
|---|---|---|
| django | ✅ 231 / 231 | ✅ 231 / 231 |
| sympy | ⬜ 0 / 75 | ⬜ |
| sphinx | ⬜ 0 / 44 | ⬜ |
| matplotlib | ⬜ 0 / 34 | ⬜ |
| scikit-learn | ⬜ 0 / 32 | ⬜ |
| astropy | ⬜ 0 / 22 | ⬜ |
| xarray | ⬜ 0 / 22 | ⬜ |
| pytest | ⬜ 0 / 19 | ⬜ |
| pylint | ⬜ 0 / 10 | ⬜ |
| requests | ⬜ 0 / 8 | ⬜ |
| seaborn | ⬜ 0 / 2 | ⬜ |
| flask | ⬜ 0 / 1 | ⬜ |

## django 정형화 분포 (231개)

분류 루브릭은 [TAXONOMY.md](TAXONOMY.md) (APR 문헌 + SWE-bench 난이도 실증연구 근거). 난이도는 에이전트 solve-rate가 아니라 **구조적 피처**로 매김(메모리제이션 confound 회피).

**티어 × 유형 매트릭스:**

| tier | DirectMap | ConstrReason | DomainBound | DesignRefactor | LocTrivial | DiffuseLoc | SpecInfer | GenValidate | 합 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| T1 존나쉬움 | 12 | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 15 |
| T2 쉬움 | 62 | 4 | 0 | 2 | 1 | 0 | 0 | 0 | 69 |
| T3 중간 | 14 | 25 | 14 | 3 | 0 | 0 | 0 | 0 | 56 |
| T4 약간어려움 | 2 | 33 | 29 | 5 | 0 | 2 | 2 | 1 | 74 |
| T5 어려움 | 0 | 0 | 7 | 9 | 0 | 1 | 0 | 0 | 17 |
| T6 매우어려움 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **합** | **90** | **62** | **50** | **19** | **4** | **3** | **2** | **1** | **231** |

읽는 법: DirectMap은 T1-T2에, ConstraintReason은 T3-T4에, DomainBound·DesignRefactor는 T4-T5에 몰림 — 유형이 곧 난이도 예측자. T6 없음(django Verified는 >4시간 난이도 0).

**Localization 축**: L0 149 / L1 51 / L2 4 / L3 27 — 이슈가 위치를 직접 지목하는 경우(L0)가 대부분, 멀티사이트 조율(L3) 27개.
**Knowledge 의존**: K-Domain 188 / K-Gen 30 / K-API 13 — **81%가 django 내부지식 의존**(ORM/compiler/migrations/forms). django가 어려운 진짜 이유.

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
