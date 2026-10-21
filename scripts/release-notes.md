## BlockPilot v{VERSION}

마인크래프트 서버를 브라우저에서 관리하는 로컬 대시보드예요. **Node.js 를 설치하지 않아도** 아래 파일 하나만 받아서 실행하면 돼요.

### 내 컴퓨터에 맞는 파일

| 컴퓨터 | 받을 파일 |
|---|---|
| Mac (Apple 실리콘 M1·M2·M3·M4) | `blockpilot-v{VERSION}-macos-arm64.zip` |
| Mac (인텔) | `blockpilot-v{VERSION}-macos-x64.zip` |
| Windows (대부분의 PC) | `blockpilot-v{VERSION}-windows-x64.zip` |
| Windows (ARM, 예: Snapdragon 노트북) | `blockpilot-v{VERSION}-windows-arm64.zip` |
| Linux (대부분의 PC·서버) | `blockpilot-v{VERSION}-linux-x64.tar.gz` |
| Linux (ARM, 예: 라즈베리 파이 4·5) | `blockpilot-v{VERSION}-linux-arm64.tar.gz` |

Mac 이 어느 쪽인지 모르겠다면 화면 왼쪽 위 애플 메뉴 → 이 Mac에 관하여 → "칩"이 Apple M… 이면 Apple 실리콘이에요.

### 실행하기

압축을 풀고 `blockpilot`(Windows 는 `blockpilot.exe`)을 실행하면 브라우저에 대시보드가 열려요. 함께 뜨는 창을 닫으면 BlockPilot 과 켜 둔 마인크래프트 서버가 함께 꺼져요.

개발자 인증서로 서명하지 않은 앱이라 **처음 한 번 경고**가 떠요.

- **macOS**: 경고 창을 닫고 시스템 설정 → 개인정보 보호 및 보안 → 맨 아래 **그래도 열기** → 다시 실행
- **Windows**: "Windows의 PC 보호" 창에서 **추가 정보 → 실행**. 서버를 처음 켤 때 방화벽 창이 뜨면 **액세스 허용**
- **Linux**: `chmod +x ./blockpilot && ./blockpilot`

### 받은 파일 확인

`SHA256SUMS.txt` 에 파일마다 sha256 해시가 있어요.

```bash
shasum -a 256 blockpilot-v{VERSION}-macos-arm64.zip    # macOS
sha256sum blockpilot-v{VERSION}-linux-x64.tar.gz       # Linux
certutil -hashfile blockpilot-v{VERSION}-windows-x64.zip SHA256   # Windows
```

### 이 버전에 들어 있는 것

- 기존 서버 폴더 등록, 빈 폴더에서 Fabric 서버 새로 만들기 (필요한 Java 를 앱 폴더에 받아서, 모든 다운로드 해시 검증)
- 레버로 켜고 끄기, 서버 설정·플레이어·모드·설정 파일·콘솔·로그·백업
- 디스코드 알림, 크래시 원인 요약과 자동 재시작, 예약 재시작
- 친구 접속 도우미, 성능 모니터, 플레이어 통계, Modrinth 모드 검색·설치·업데이트
- macOS · Windows · Linux, 휴대폰 화면

설정은 `~/.blockpilot` 에 저장돼서 새 버전으로 바꿔도 그대로 남아요. 앱 아래쪽 **업데이트 확인**을 누르면 새 버전이 있는지 알려 줘요.

자세한 사용법: https://github.com/sjc4197/BlockPilot#readme
