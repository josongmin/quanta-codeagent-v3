# T-04 — Tier-2 언어 (C++ / Java / C#)

- **상태**: OPEN. 우선순위 4 (점진, 언어당 독립).
- **충돌주의**: 없음(OCP 증분 — 어댑터/프리셋/파서/마커 추가).

## 기능 / 왜 / ROI
- **(기능)** Tier-2 언어 키스톤 칸 채우기. 언어당 LSP 어댑터 + DAP 프리셋 + 러너 파서 + detect 마커.
  - **C++**: clangd(LSP) + **lldb-dap(이미 있음, 프리셋만)** + ctest/gtest 파서 + sanitizer 트레이스 evidence.
  - **Java**: jdtls(LSP) + java-debug(DAP/TCP, **D01 TCP 재사용**) + Gradle/Maven 파서.
  - **C#**: Roslyn(LSP) + netcoredbg(DAP) + `dotnet test` 파서.
- **(왜)** §1 16칸은 Tier-1 완료. Tier-2는 비전의 점진 확장. C++는 lldb-dap이 이미 동작이라 **최저비용**(LSP+파서만).
- **(ROI)** 저-중(수요 의존). 언어당 §1 비용표(어댑터1+엔트리1줄+프리셋+파서)대로.

## 접근 (grounded — 언어당 동일 패턴)
1. LSP: `src/lsp/adapters/<lang>.ts`(rust-analyzer.ts/gopls.ts 패턴) + `lsp-bridge.ts` SERVERS 1줄 + ext→server. (drift 가드 1줄.)
2. DAP: stdio면 `ADAPTER_PRESETS` 1줄([debug/tool.ts](../../../src/tool/debug/tool.ts)); TCP면 D01 `spawnTcpDebugAdapter` 재사용. runtime.ts dispatch 1분기.
3. 러너: `parse<Runner>`([testrun/parse.ts](../../../src/tool/testrun/parse.ts)) + detect 마커(CMakeLists/pom.xml/*.csproj) + tool.ts switch.
4. 언어당 독립 PR — 한 칸씩 16칸 패턴 복제.

## 컴포넌트 DoD (§2, 언어당)
- 파서 verbatim 핀, LSP/DAP 실 e2e(toolchain 있을 때), auto-skip.
- 신규 도구 없음(기존 3도구가 자동 커버) → 풀배선 부담 적음.

## repo-green DoD (§4)
- 언어당: src tsc 0 / 건든 테스트 0 신규 / 스위트 0 fail / detect·probe drift 가드 갱신.
