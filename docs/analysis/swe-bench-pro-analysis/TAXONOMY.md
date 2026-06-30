# SWE-bench Pro 문제 정형화 루브릭 (분석 SSOT)

Verified 루브릭([../swe-bench-verified-analysis/TAXONOMY.md](../swe-bench-verified-analysis/TAXONOMY.md))의 **3축(Localization L0-L3 / Repair-Strategy S1-S6 / Knowledge K-*) + 6-tier를 계승**하고, Pro 고유 특성(멀티언어·멀티파일·얇은 오라클·프로덕션앱)을 위한 **델타**만 여기 정의한다. 축 정의 자체는 Verified 문서를 SSOT로 참조.

> 핵심 원칙은 동일: 난이도는 **구조적·인과적 피처**로 매긴다(solve-rate 아님). Pro는 contamination-resistant라 memorization confound는 덜하지만, 그래도 구조피처 기반이 정본.

---

## 델타 1 — 언어 축 (Pro 신규, Verified엔 없음)

각 인스턴스에 `language ∈ {python, go, js, ts}` 표기. 우리 스택 가용성이 언어로 갈리므로 1급 축.

| 언어 | n(731) | 우리 repro 실행 | semantica nav | 비고 |
|---|--:|---|---|---|
| python | 266 | ✅ pytest/uv (Verified 그대로) | Golden | 즉시 공략 표면 |
| js | 165 | ⬜ jest/vitest 일반화 필요 | Golden | semantica 강 |
| ts | 20 | ⬜ vitest/tsc 필요 | Golden | semantica 강 |
| go | 280 | ⬜ go test 필요 | **DfgReady만(약)** | 최대 레인·최대 갭 |

- **K-Domain의 의미가 언어로 바뀜**: Verified는 "프레임워크 내부지식(ORM/compiler)". Pro는 "**운영 시스템 도메인**(infra/auth/UI/devops)" — `issue_categories` 필드가 이걸 직접 라벨링하므로 K 판정에 그대로 활용.
- fail_to_pass 포맷이 언어별로 다름(python=pytest node-id, js=`"file.js | describe::it"`, go=`Test*`). loc/repair 분석엔 영향 없으나 **로컬 실행 러너 선택의 신호**.

## 델타 2 — Localization은 L3 Multi-site가 기본값 (median 4 파일)

Verified는 L0/L1이 다수. **Pro는 gold median 4파일·55%가 ≥4파일**이라 **L3(multi-site)가 modal**. 판정 시:
- gold_file_count 1 → L0/L1 가능 (Pro의 14%만)
- 2-3 → L2/L3
- ≥4 → **거의 L3** (다중지점 조율 필수). ≥7(19%)은 Verified 실증상 "solve 0%" 구조존 — tier 자동 상향.
- `gold_file_count`를 frontmatter 필수 필드로 기록(멀티파일이 Pro 난이도의 1차 동인).

## 델타 3 — 오라클이 얇다: overfit/underspecified가 기본 플래그 (fail_to_pass median 1)

Verified는 F2P가 데이터드리븐으로 부풀려져 두꺼운 경우 많음. **Pro는 F2P median 1**(4파일·13KB 패치를 테스트 1개로 검증). 따라서:
- `overfit-risk` 플래그는 **Pro에서 거의 보편** — 단일 테스트로는 다중지점 변경을 과소명세. 명시적으로 *없다*고 판단될 때만 빼라.
- `underspecified`도 마찬가지 — 이슈 본문 + `interface` 필드(Pro가 구현할 API 표면을 명시)를 같이 봐야 스펙 복원.
- **S4(Counterexample-Guided)/S5(Spec-Inference) 비중이 Verified보다 높음** — 얇은 테스트 너머 일반화 + interface로부터 스펙 재구성.

## 델타 4 — Pro 고유 필드 활용 (분석 입력)

Verified엔 없는 Pro 필드를 분석에 반드시 반영:
- `issue_categories` (back_end/api/security/devops/...) → **K(knowledge) 도메인 라벨 직접 제공**. 멀티라벨.
- `issue_specificity` → 이슈 명세도 → `underspecified` 플래그 판정 보조.
- `interface` → 구현해야 할 API/시그니처 표면 → **S5 Spec-Inference 판정 + localize 힌트**.
- `selected_test_files_to_run` → 채점이 도는 테스트 파일 → 오라클 범위 + regression 표면.
- `before_repo_set_cmd` → 인스턴스 빌드/셋업 (Scale 도커 내). 로컬 repro 시 필요(우리 워크).

## 델타 5 — 6-tier 칼리브레이션 (Pro 상향 편향)

Verified 6-tier 정의 동일. 단 Pro의 구조피처가 전반적으로 높아 분포가 T4-T6로 쏠림:
- T1/T2(존나쉬움/쉬움): gold 1파일 + L0/L1 + 두꺼운 신호 — Pro의 ~14%(1파일군) 중 일부만.
- T3(중간): 2-3파일 + 단일 도메인.
- **T4(약간어려움): ≥4파일 다중지점 조율 — Pro modal tier로 예상.**
- T5(어려움): ≥4파일 + 크로스-언어/크로스-서비스 + 얇은 오라클 overfit.
- T6(매우어려움): ≥7파일(19%) 또는 deep 운영도메인(auth/infra) 다중지점. Verified엔 1건뿐이었으나 **Pro엔 상당수 예상**.

> 즉 Verified의 tier 분포(T2/T3 다수)를 Pro에 그대로 들이대지 말 것. gold_file_count + 언어 + 오라클 두께가 Pro tier의 3대 동인.

---

## Primary Type (Verified controlled vocabulary 그대로 + Pro 빈도 예상)

Verified와 동일 어휘(T-ConstraintReason/T-DirectMap/T-DomainBound/T-DesignRefactor/T-SpecInference/T-DiffuseLoc/T-LocTrivial/T-GenValidate). Pro 예상 편향:
- **T-DesignRefactor / T-DiffuseLoc 비중↑** (멀티파일 구조변경·확산 localize가 Pro 본질).
- **T-SpecInference↑** (interface로부터 스펙 복원).
- T-LocTrivial↓ (1파일 trivial은 14%뿐).

분석 에이전트는 이 루브릭 + Verified TAXONOMY를 둘 다 입력으로 받아, gold patch·problem·Pro필드 기반으로 frontmatter + 본문 5섹션을 채운다.
