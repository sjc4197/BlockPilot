# Windows 실제 PC 점검 체크리스트

자동 테스트(GitHub Actions `windows-latest`)는 서버 만들기 → 켜기 → 끄기 → 삭제와 `pause` 가 있는 `start.bat` 까지 확인해요.
아래는 실제 Windows PC 에서만 볼 수 있는 것들이에요. 한 번 직접 확인하고 결과를 이슈로 남겨 주세요.

## 준비

- [ ] Windows 10 또는 11, [Node.js LTS](https://nodejs.org) 설치
- [ ] PowerShell 에서 `git clone` → `npm install` → `npm run build` → `npm start`
- [ ] 브라우저에서 http://127.0.0.1:4800 → 첫 화면 아래가 "이 컴퓨터: Windows 11 (빌드 …) · x64" 처럼 보이는지

## 새 서버 만들기

- [ ] 폴더 찾기 왼쪽에 C:·D: 드라이브와 바탕 화면이 보이는지 (OneDrive 로 바탕 화면을 옮긴 PC 면 "바탕 화면 (OneDrive)")
- [ ] 사용자 이름이 한글인 계정(예: `C:\Users\홍길동\…`)에서도 만들어지는지
- [ ] Java 21 을 설치한 PC(예: Eclipse Temurin 설치 파일) 에서 Java 준비가 "이 PC에 설치된 Java" 로 잡히는지 (CI 러너는 Java 를 특수 폴더에 둬서 자동 테스트로는 확인하지 못함)
- [ ] Java 가 없는 PC 에서 "앱 폴더에 받아요" 로 진행되고, `%USERPROFILE%\.blockpilot\runtimes\` 에만 생기는지 (설치 프로그램 목록에 Java 가 새로 생기지 않음)
- [ ] 최초 실행 때 "Windows 보안 경고(방화벽)" 창이 뜨는지 → **액세스 허용**
- [ ] 만든 폴더의 `start.bat` 을 더블클릭해도 서버가 켜지는지, 오류로 꺼지면 창이 바로 닫히지 않고 멈추는지

## 서버 운영

- [ ] 대시보드 레버로 켜고 끄기, 콘솔에 한글(플레이어 채팅 등)이 깨지지 않는지
- [ ] 같은 공유기의 다른 PC 에서 접속되는지 (Minecraft 에서 `이 PC 의 IP:25565`)
- [ ] 서버가 켜진 상태에서 백업 만들기 → 성공, 다운로드한 zip 이 열리는지
- [ ] 서버를 끈 뒤 모드 켜기/끄기, 설정 파일 저장
- [ ] PowerShell 창에서 `Ctrl+C` 로 BlockPilot 을 끄면 켜져 있던 서버도 정상 종료(월드 저장)되는지
- [ ] 서버 설정 → 서버 삭제로 폴더가 지워지는지

## 원래 있던 서버 연결

- [ ] 끝에 `pause` 가 있는 기존 `start.bat` 서버를 등록 → 레버로 켜고 끄기 (꺼진 뒤 "켜짐" 으로 남아 있지 않은지)
