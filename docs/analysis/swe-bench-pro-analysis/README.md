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
  PYTHON-FIRST-STRUCTURAL-RCA.md
                            ← current-head 기준 Python-first bottleneck + 확장 가능한 polyglot 축 분리
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

| 언어 | 인스턴스 | 분석(Phase A) | 객관 어딧 (gold 재도출) | 적대 어딧 (false-green refute) |
|---|--:|--:|--:|--:|
| python | 266 | ✅ 266 | ✅ 266 | ✅ 266 |
| go | 280 | ✅ 280 | ✅ 280 | ✅ 280 |
| js | 165 | ✅ 165 | ✅ 165 | ✅ 165 |
| ts | 20 | ✅ 20 | ✅ 20 | ✅ 20 |
| **전체** | **731** | **✅ 731 / 731** | **✅ 731 / 731 (clean)** | **✅ 731 / 731** |

> 횡단 종합 결론은 [SYNTHESIS.md](SYNTHESIS.md). **Phase B 어딧 731 전수 완료(2026-06-30).** 두 차원:
> - **객관 어딧(gold 재도출):** f2p(중첩 stringified-list 언팩)·gold_file_count(`diff --git` 헤더, 바이너리/빈파일/삭제 포함)·primary_type(controlled vocab 8종) 전부 gold서 재도출·대조. **팩트 카운트 에러 0건** — raw-parse와의 모든 불일치는 의도적·주석된 의미 선택(whole-suite vs 오라클 두께, substantive-file vs noise). vocab 드리프트 77개만 8종 정규화.
> - **적대 어딧(false-green refute):** ~474건은 per-instance 에이전트가 벡터 경화(P2P 카운트 slip·날조 test-id 인용·off-vocab body 라벨 정정 다수 적발) + 나머지는 메인스레드 결정적 검증(vocab·gold_files·citation 실재 전수 대조). **257 전수서 확정 날조 0건**(유일 의심 1건=`selected_test_files_to_run`의 pre-existing 스위트 인용으로 defensible).
> **어딧 marginal-value 측정:** 기계 재도출 proxy가 4회 다 틀리고(audited-regex/f2p-len/gfc-`+++b`/citation-`test_patch`산문) Phase-A md가 매번 정답 → 코퍼스 견고성의 직접 증거. 거시 결론(멀티사이트·thin-oracle·DesignRefactor 지배) 불변.
> **정규화 분포(731, 파일-레벨 SSOT):** loc L3 **527(72%)** · tier T4 modal **392(54%)**/T5 159 · primary_type **T-DesignRefactor 430(59%) · T-SpecInference 161(22%)** · DiffuseLoc 47 · ConstraintReason 39 · DomainBound 29 · DirectMap 24 · flags overfit **517(71%)**/thin-oracle **458(63%)**/gold-latent-bug **80(11%)**. 언어별 난이도 go > js/ts > python (go L3 79%, T5+T6 32%).

> 권장 순서: **Python-Pro(266) 먼저** — 우리 스택이 즉시 닿는 표면이라 분석↔측정 루프가 가장 빠름. 그담 js/ts(165+20, semantica 강), 마지막 go(280, 최대지만 우리 약점 레인).
> 분석은 Verified와 동일하게 **per-instance 분석 에이전트**(gold patch + problem + Pro 고유필드 입력)로 스케일.
>
> 현재 헤드 기준 구조 RCA와 언어별 확장축 정리는 [PYTHON-FIRST-STRUCTURAL-RCA.md](PYTHON-FIRST-STRUCTURAL-RCA.md). 핵심은 "Python만 하자"가 아니라, `LanguageAdapter × ExecBackend × OracleSource` 축을 유지한 채 Python에서 먼저 실증하자는 것이다.

## 우리 실측 (live runs · 2026-06-29)

Pro를 **실제로 채점 가능하게** 만든 플랫폼 작업 + 첫 5-pick 실측. 플랫폼 설계·구현은
[jun-29 SWE-benchmark platform RFC](../../plans/jun-29-swe-benchmark-platform/README.md),
런 결과는 대시보드 **🛠관리 / 우리 런** 탭(`datasetFamily:"pro"` partition)에서 라이브로 본다.

**Pro 채점 배선(full-remote)** — 박스가 `scaleapi/SWE-bench_Pro-os`를 clone + 전용 venv(pandas/datasets/docker/…)로 `swe_bench_pro_eval.py` 실행, 이미지는 `jefzda/sweap-images:<dockerhub_tag>` pull. 3개 함정을 잡고서야 measurable:
1. **preset LSP-gate** — `agentless-v3-thin-strict`가 task-언어 live-LSP 강제 → JS/TS(NodeBB)는 박스에 ts-language-server 없어 하드-refuse. `--preset agentless-v1`(LSP-optional)로 우회.
2. 🔴 **CWD 버그** — `swe_bench_pro_eval.py`는 per-instance env Dockerfile을 `dockerfiles/{base,instance}_dockerfile/<id>/Dockerfile` **상대경로**로 읽음(clone에 731개 다 있음). 우리 verifier가 temp dir에서 spawn → FileNotFound → **모든 인스턴스(gold 포함) False** = systematic gold-fail. spawn cwd를 harness dir로 고쳐 해결(첫 spot 런 5/5 gold-fail → 수정 후 measurable).
3. **spot reclaim** — spot 박스가 채점 중 reclaim되며 결과 LOST 반복 → `QUANTA_FULL_REMOTE_ONDEMAND=1`(안정 박스)로 완주.

**첫 5-pick 결과** (gpt-5.5 · agentless-v1 · Scale 도커 권위 채점):

| instance | 결과 | 비고 |
|---|---|---|
| [ansible-f327e65d](ansible/instance_ansible__ansible-f327e65d11bb905ed9f15996024f857a95592629-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5.md) | ✅ PASS | python |
| [qutebrowser-f91ace96](qutebrowser/instance_qutebrowser__qutebrowser-f91ace96223cac8161c16dd061907e138fe85111-v059c6fdc75567943479b23ebca7c07b5e9a7f34c.md) | ✅ PASS | python |
| [qutebrowser-c580ebf0](qutebrowser/instance_qutebrowser__qutebrowser-c580ebf0801e5a3ecabc54f327498bb753c6d5f2-v2ef375ac784985212b1805e1d0431dc8f1b3c171.md) | ❌ FAIL | python · 진짜 miss(채점됨) |
| [NodeBB-04998908](NodeBB/instance_NodeBB__NodeBB-04998908ba6721d64eba79ae3b65a351dcfbc5b5-vnan.md) | ❌ FAIL | js · 진짜 miss(59턴, 채점됨) |
| [NodeBB-51d8f3b1](NodeBB/instance_NodeBB__NodeBB-51d8f3b195bddb13a13ddc0de110722774d9bb1b-vf2cf3cbd463b7ad942381f1c6d077626485a1e9e.md) | ❌ FAIL | js · 진짜 miss(59턴, 채점됨) |

**최종: 2 resolved / 5 = 40%** (report-i-07d0dadbde6ea9617.json). 전부 measurable — breakdown `completed_unresolved:3`, **grader_invalid 0 · harness_error 0** = CWD fix로 5/5 진짜 채점(첫 spot 런 5/5 gold-fail였던 게 완전 정상화). python 2/3 PASS, js(NodeBB) 0/2 — README 상단 "js는 우리 약점 레인" 예측과 일치.

> Pro는 공개 **per-instance solve matrix가 없어**(aggregate %만) — 위는 우리 자체 측정. 상단 "fail_to_pass median 1 → overfit 고위험" 경고대로 F2P 1개 통과가 정답 보장은 아님(Scale 도커 채점이 권위지만 thin-oracle 한계는 데이터셋 고유).

## 재현 / 사용법

```bash
# 데이터 재수집 (datasets-server rows API, paginated 731)
python3 docs/analysis/swe-bench-pro-analysis/_data/fetch.py
```
