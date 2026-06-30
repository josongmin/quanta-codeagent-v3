# SWE-bench Pro — 횡단 종합 (731 전수 분석)

731개 공개 인스턴스를 **골드패치 기반으로 전수 분석**한 결과의 cross-cutting 결론. 근거는 per-instance md(`<repo>/<id>.md`) 731개 + frontmatter 집계.

> 분석 상태: Phase A(전수 분석) 731/731 완료. **Phase B 어딧 731/731 완료(2026-06-30)** — 객관 어딧(gold 재도출: f2p/gold_file_count/primary_type 전수 대조) **팩트 에러 0건**(불일치는 의도적·주석된 의미 선택), vocab 77개 정규화; 적대 어딧(false-green refute) 731 전수(~474 per-instance 에이전트 벡터경화 + 257 메인스레드 결정적 검증), **확정 날조 0건**. 거시 결론 불변(기계 proxy 4회 다 틀리고 md가 정답 → 코퍼스 견고).

---

## 🔴 헤드라인: Pro의 권위 채점이 부분패치를 systematically false-green한다

731개 거의 전부에서 동일한 구조가 나왔다 — **gold patch는 멀티파일/멀티사이트인데 `fail_to_pass`는 그중 한 조각만 검증한다.** 그래서 **gold의 의도를 절반도 구현 안 한 부분패치가 권위 채점(Scale 도커)을 통과한다.** 이건 우리 스캐폴드의 문제가 아니라 **벤치마크 자체의 품질 특성**이다.

함의 3가지:
1. **Pro는 overfit/gameable** — 테스트된 슬라이스만 맞추면 green. "resolved"가 "문제 해결"을 의미하지 않는다.
2. **"resolved"도 의심해야** — Pro에서 통과한 인스턴스도 gold가 요구한 multi-site 조율/표현계층/마이그레이션을 빠뜨렸을 수 있다.
3. **우리 repro/verify-select 오라클은 신호가 빈약** — Pro `fail_to_pass`의 유효 두께가 ≈1이라(아래), 오라클이 일반화를 강제할 재료가 거의 없다.

### 정량 근거 (frontmatter 집계, 731 전수 파싱)
- **thin-oracle 플래그 458/731 (63%)**, **overfit-risk 517 (71%)**, **underspecified 308 (42%)**.
- **gold-patch-latent-bug 80 (11%)** — gold 패치 9개 중 1개가 자기 spec조차 미충족(얇은 오라클이 안 잡아서). 예: qutebrowser ReadError를 WriteError 키로 매핑(dict 키 충돌), openlibrary import_job 이터레이터 이중소비로 실배치 0건, flipt cookie 키 오타 `grcpgateway-cookie`.
- **유효 오라클 두께 ≈ 1**: `fail_to_pass` 카운트가 커도(8·17·33·84) 대부분 **같은 테스트블록 복붙**이거나 **한 파일/한 함수만** 운동. 예: openlibrary 25858f9f(f2p 6=동일블록→두께1), qutebrowser f0f184(f2p 33→전부 configfiles.py 1파일), vuls 196a6ea8(f2p 84→패키지 컴파일 게이트일 뿐).

---

## 분포 (Verified와 차원이 다른 난이도)

| 축 | Pro (731) | Verified (500) 대비 |
|---|---|---|
| **loc** | **L3(멀티사이트) 527 (72%)** · L2 96 · L1 99 · L0 9 | Verified는 L0/L1 다수 |
| **tier** | **T4 392 (modal, 54%)** · T5 159 · T3 142 · T6 25 · T2 13 | Verified는 T2/T3 modal |
| **primary_type** (파일-레벨 정규화 SSOT) | **T-DesignRefactor 430 (59%)** · T-SpecInference 161 (22%) · DiffuseLoc 47 · ConstraintReason 39 · DomainBound 29 · DirectMap 24 | Verified는 ConstraintReason/DirectMap 최다 |
| gold 파일수 | mean 5.0 / median 4 | Verified 대부분 1-2 |
| 패치크기 | median 7.8KB / mean 13KB | Verified ~1줄~수KB |
| fail_to_pass | median 1 | Verified 두꺼움(데이터드리븐) |

**읽는 법:** Verified는 "어디"보다 "정확히 무엇"(ConstraintReason)이 난점인 1파일 문제. **Pro는 "여러 파일을 어떻게 함께 재배치/조율하느냐"(DesignRefactor 59%)가 본질인 멀티사이트 문제.** 단일점 픽스(DirectMap)는 3%뿐.

---

## 언어별 대조 (Go가 가장 어렵고 우리 약점과 겹침)

| 언어 | n | L3 비율 | T5+T6 비율 | 우리 스택 |
|---|--:|--:|--:|---|
| **go** | 280 | **79% (221)** | **32% (90)** | repro rail 없음 + semantica DfgReady만(taint/PTA 없음) |
| python | 265 | 59% | 18% | repro/pytest 오라클 그대로(즉시 공략) + semantica Golden |
| js | 119 | 82% | 30% | jest/vitest 일반화 필요 + semantica Golden |
| ts | 66 | 79% | 17% | vitest 필요 + semantica Golden |

**Go = 최대 레인(38%) × 최고 난이도(L3 79%, T5+T6 32%) × 우리 최약 지원.** Pro 점수의 1/3이 여기 묶여있고 정확히 우리가 못 닿는 곳. Python(36%)이 유일하게 우리 오라클·semantica가 즉시 닿는 표면.

> 언어 카운트 기준: 위 표는 **파일-레벨 분류**(frontmatter `language`, 실제 .ts/.tsx 반영 → js 119·ts 66). README 상단 표는 **데이터셋 repo-레벨 라벨**(tutanota=ts 20·나머지=js 165)이라 js/ts 분할이 다르다 — 둘 다 정의가 다를 뿐 동일 185개(go 280·python 265 불변). 스택 적용(vitest/semantica TS)엔 파일-레벨이 더 적절.

---

## 대표 false-green 벡터 (per-instance 분석서 발췌)

- **ansible 5d2f02f** (5파일): `prepare_multipart` helper + 3개 call-site 마이그레이션. f2p 5개가 전부 helper만 → **단일파일 helper 패치가 full gold 점수**, 정작 uri/action multipart는 미해결.
- **qutebrowser f0f184** (5파일, f2p 33): Bool→enum 멀티사이트. 33개가 전부 configfiles.py만 → **1파일만 고쳐도 33/33 green인데 이슈 버그는 살아있음**(설정 여전히 Bool).
- **teleport 58667910**: 오라클이 **사용자 버그와 정반대로 가중** — gold의 ForwarderConfig 5필드 개명만 검증하고 problem이 호소한 uploader init 누락은 0 검증. 버그만 고치면 오히려 컴파일 실패로 전멸.
- **ansible 935528e2** (8파일): SSH옵션 SSOT 단일계약. 부분패치=`AttributeError`인데 f2p 8개가 cross-cutting 계약(base.yml 삭제·cli precedence)을 0 검증.
- **navidrome b65e76** (10파일, cross-lang): SSE 발신자 정체성 종단연결. f2p 2개가 순수함수 `shouldSend`만 → **배선·UI 통째 빼먹어도 통과**(실버그 미수정).
- **element-web b7fea97b**: snapshot-only 오라클이 DOM class 문자열만 비교 → **3개 CSS 파일 + 공유 컴포넌트 전부 스킵하고 inline literal만 박아도 통과**.
- **vuls 196a6ea8** (9파일, f2p 84): Trivy dep-migration. 84개가 패키지 컴파일 게이트일 뿐 → scanner만 컴파일되면 detector/models/contrib 깨진 채 `go build ./...` 실패해도 오라클 green.

---

## 우리 작업에의 함의

1. **오라클 전략(원래 질문 "Pro도 오라클 가능?"의 최종 답):** transfer는 되지만 **신호가 Verified보다 훨씬 약하다.** Pro 유효 테스트≈1 → repro-oracle/verify-select가 일반화를 강제할 재료 부족 + Scale 권위채점조차 overfit. → Pro에선 **오라클보다 멀티사이트 localization + 구조 리팩터 능력**이 1차 레버.
2. **Python-Pro(265, 36%)부터** — 우리 pytest 오라클·semantica Golden이 즉시 닿는 유일 표면. 분석↔측정 루프 최단.
3. **Go(280, 38%)는 최대 ROI이자 최대 투자** — repro rail 언어 일반화(go test) + semantica Go 레인 강화(DfgReady→taint) 둘 다 필요. 안 하면 Pro 1/3 영구 미달.
4. **멀티사이트(L3 72%)** → semantica def-use/call-graph가 가장 값나가는 지점(py/js/ts), Go는 약함.
5. **"resolved" 신뢰 주의** — Pro 점수를 SOTA 비교에 쓸 때 부분패치 false-green 때문에 상향편향. 우리 채점 리포트에 multi-site coverage 신호를 별도 트래킹하면 진짜-해결 vs 슬라이스-통과 구분 가능.

---

## 방법론 메모

- Phase A 731 분석은 병렬 분석 에이전트 fleet(골드패치+problem+Pro필드 입력)로 생성. ground-truth=md 파일수(워크플로 "analyzed" 카운트는 return-no-write로 과대계상되어 missing-set diff로 수렴).
- primary_type은 에이전트 어휘 드리프트(T-Cross* 50여종 발명)를 controlled vocab 8종으로 정규화 집계.
- 객관 어딧은 gold 기준 전수 결정적 재도출(f2p 중첩 언팩·gold_file_count `diff --git`·vocab 8종) — 731 clean, 팩트 에러 0, vocab 77개만 정규화. 적대 어딧(false-green refute)도 **731 전수 완료**(~474 per-instance 에이전트 벡터경화 + 257 메인스레드 결정적 검증, 확정 날조 0건). 본 종합의 분포/벡터 결론은 Phase A 전수 + 객관·적대 어딧 731 전수에 근거하며 **멀티사이트·thin-oracle·DesignRefactor 지배**라는 거시 결론은 불변(압도적 다수라 노이즈 내성). frontmatter `audited:` 값은 731 전부 `true`(적대+객관 양 차원 완료).
