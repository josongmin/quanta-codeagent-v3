# SWE-bench Pro (ScaleAI) — 문제별 분석

SWE-bench Pro **공개 731문제**(ScaleAI/SWE-bench_Pro, test split)를 **문제별로 까볼 수 있게** 정리한 레퍼런스.
[swe-bench-verified-analysis](../swe-bench-verified-analysis/)와 동일 포맷 — 골드패치 기반 유형 분류 + "뭘 조져야 하는지" 공략 포인트. Pro 고유의 **멀티언어 · 멀티파일 · 프로덕션앱** 특성을 반영해 확장.

> ⚠️ 분석 md는 **골드패치 스포일러 포함** — 사람이 문제 유형을 빠르게 파악하는 레퍼런스지 에이전트 블라인드 학습셋 아님.

## 핵심: Pro는 Verified와 차원이 다른 난이도다 (전수 731 실측)

| 축 | Verified | **Pro (731 실측)** | 함의 |
|---|---|---|---|
| 언어 | Python 100% | **go 280 (38%) · python 266 (36%) · js 165 (23%) · ts 20 (3%)** | 비-Python **64%**. 우리 repro rail·pytest 오라클은 Python 전용 → 64%가 즉시 안 먹음 |
| repo | 12 과학 라이브러리 | **11 프로덕션 앱** | 도메인지식이 ORM/compiler가 아니라 **운영 시스템**(infra/auth/UI) |
| gold 파일수 | 대부분 1-2 | **mean 5.0 / median 4** (1파일 14% · 2-3 31% · 4-7 36% · 8+ 19%, max 106) | Verified 실증: ≥3파일 solve<10%, ≥7파일 0%. **Pro median이 그 존** |
| 패치크기 | ~1줄~수KB | **median 7.8KB / mean 13KB** (max 180KB) | 한 줄 합성이 아니라 다중지점 조율 |
| fail_to_pass | 많음(데이터드리븐 부풀려짐) | **median 1** (max 6) | 4파일 패치를 테스트 **1개**로 검증 = 극단 overfit + underspecified 오라클 |
| 카테고리 | 과학 도메인 | back_end 560 · api 238 · devops 156 · ui_ux 137 · security 127 · front_end 123 · infra 122 · auth 76 · perf 67 | 일반 SE 전 분야 |

**한 줄:** Verified는 "1파일·Python·테스트 풍부", Pro는 "**4파일·멀티언어·테스트 1개**". 거의 모든 구조적 난이도 축에서 Pro가 Verified의 최상위 티어 이상. 우리 스택의 두 전제(Python-only 실행, repro 오라클)가 Pro 다수에서 깨짐 — 그게 이 분석으로 파악할 핵심.

## 언어 × repo 분포

| repo | 언어 | n |
|---|---|--:|
| ansible/ansible | python | 96 |
| internetarchive/openlibrary | python | 91 |
| flipt-io/flipt | go | 85 |
| qutebrowser/qutebrowser | python | 79 |
| gravitational/teleport | go | 76 |
| protonmail/webclients | js | 65 |
| future-architect/vuls | go | 62 |
| navidrome/navidrome | go | 57 |
| element-hq/element-web | js | 56 |
| NodeBB/NodeBB | js | 44 |
| tutao/tutanota | ts | 20 |
| **합** | | **731** |

> python 266 (ansible+openlibrary+qutebrowser), go 280 (flipt+teleport+vuls+navidrome), js 165 (webclients+element-web+NodeBB), ts 20 (tutanota).

## 우리 작업 관점 함의 (문제 파악 → 전략)

1. **Python-Pro 서브셋(266, 36%)이 즉시 공략 가능 표면.** Verified의 repro/regression 오라클·pytest 실행이 거의 그대로 먹는 유일한 부분. **여기부터 분석·측정.**
2. **Go(280, 38%)가 최대 레인이자 최대 갭** — 우리 repro rail(pytest) 없음 + semantica-codegraph도 Go는 DfgReady만(taint/PTA 없음). Pro 점수의 38%가 여기 걸림.
3. **멀티파일(median 4)** = localization이 L3 Multi-site 지배적 → semantica의 def-use/call-graph가 가장 값나가는 지점(단 Python/JS/TS만; Go 약함).
4. **fail_to_pass median 1** = 오라클 신호가 극도로 얇음 → repro-oracle/verify-and-select의 overfit·underspecified 위험이 Verified보다 훨씬 큼. best-of-N 선택이 1개 테스트에 과적합될 위험.
5. **채점은 Scale 도커가 권위** (우리 측정 불필요) — 우리 오라클은 선택 신호로만.

## 구성

```
swe-bench-pro-analysis/
  README.md                  ← 이 파일 (분포 + 함의)
  TAXONOMY.md                ← 분류 루브릭 (Verified 3축 L/S/K + 6tier 계승 + Pro 멀티언어 확장)
  _data/
    pro-full.jsonl           ← 원시 731 rows (HF ScaleAI/SWE-bench_Pro, test split)
    fetch.py                 ← 데이터 재수집 (datasets-server rows API, paginated)
    by-instance/<id>.json    ← 인스턴스별 분리 레코드 (분석 에이전트 입력)
  <repo-basename>/<instance_id>.md   ← 문제별 분석 (레포 basename별 디렉토리)
```

소스 레포는 **이 리포 밖**에 클론 (컨텍스트 오염 방지): `~/swe-bench-pro-repos/<repo-basename>/`.

## 각 md 구조 (Verified 포맷 계승 + Pro 확장)

frontmatter: `primary_type` / `tier` / `loc_axis` / `repair_strategy` / `knowledge` / **`language`** / `flags` + gold_files · F2P · P2P + **`issue_categories`** · **`gold_file_count`** (Pro 멀티파일 신호).

본문:
- **문제 요약**
- **유형 (정형화)** — 3축(Localization/Repair-Strategy/Knowledge) + **언어** + primary type + APR 근거
- **난이도 티어** — 6티어 + 구조적 피처(특히 gold 파일수 · 패치크기 · fail_to_pass 얇음)
- **골드패치 분석** — 건드린 파일들(멀티파일 조율) / 근본 원인 / 수정 요지
- **검증 (test_patch)** — fail_to_pass 동작(언어별 러너) / overfit·regression 관점 (Pro는 F2P 얇아 overfit 항시 고위험)
- **모범답안 (오라클 기반)** — localize(멀티사이트 경로) → 픽스(다중지점 조율) → regression 안전 → 함정 회피

## 분석 진행 상태

| 언어 | 인스턴스 | 분석(Phase A) | 적대+객관 어딧(Phase B) |
|---|--:|--:|--:|
| python | 266 | ✅ 266 | 🟡 incremental |
| go | 280 | ✅ 280 | 🟡 incremental |
| js | 165 | ✅ 165 | 🟡 incremental |
| ts | 20 | ✅ 20 | 🟡 incremental |
| **전체** | **731** | **✅ 731 / 731** | **🟡 ~64+ / 731 (throttle-paced)** |

> 횡단 종합 결론은 [SYNTHESIS.md](SYNTHESIS.md). Phase A 전수 완료. Phase B 어딧은 분류 재검증·강화 패스로 throttle에 맞춰 incremental 진행(거시 결론 불변).
> **정규화 분포(731):** loc L3 **72%** · tier T4 modal(54%)/T5 · primary_type **T-DesignRefactor 53% · T-SpecInference 27%** · flags thin-oracle **70%**/overfit **69%**/latent-gold-bug **13%**. 언어별 난이도 go > js/ts > python (go L3 79%, T5+T6 32%).

> 권장 순서: **Python-Pro(266) 먼저** — 우리 스택이 즉시 닿는 표면이라 분석↔측정 루프가 가장 빠름. 그담 js/ts(165+20, semantica 강), 마지막 go(280, 최대지만 우리 약점 레인).
> 분석은 Verified와 동일하게 **per-instance 분석 에이전트**(gold patch + problem + Pro 고유필드 입력)로 스케일.

## 재현 / 사용법

```bash
# 데이터 재수집 (datasets-server rows API, paginated 731)
python3 docs/analysis/swe-bench-pro-analysis/_data/fetch.py
```
