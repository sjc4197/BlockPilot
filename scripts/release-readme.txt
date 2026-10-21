BlockPilot v{VERSION}
마인크래프트 서버를 브라우저에서 관리하는 로컬 대시보드

[실행]
  {EXE} 을(를) 실행하면 브라우저에 대시보드(http://127.0.0.1:4800)가 열려요.
  함께 뜨는 창을 닫거나 Ctrl+C 를 누르면 BlockPilot 과 켜 둔 마인크래프트 서버가 함께 꺼져요.

[처음 실행할 때 뜨는 경고]
  개발자 인증서로 서명하지 않은 앱이라 처음 한 번 경고가 떠요.

  macOS
    1) 압축을 푼 폴더에서 blockpilot 을 더블클릭 → "확인되지 않은 개발자" 경고가 뜨면 닫기
    2) 시스템 설정 → 개인정보 보호 및 보안 → 맨 아래 "그래도 열기" → 다시 실행
    (터미널을 쓴다면: xattr -d com.apple.quarantine ./blockpilot)

  Windows
    "Windows의 PC 보호" 창이 뜨면 "추가 정보" → "실행"
    서버를 처음 켤 때 방화벽 창이 뜨면 "액세스 허용" (친구들이 접속할 수 있게)

  Linux
    터미널에서: chmod +x ./blockpilot && ./blockpilot

[설정과 데이터]
  등록한 서버 목록·설정은 ~/.blockpilot 에 저장돼요. 새 버전으로 바꿔도 그대로 남아요.
  마인크래프트 서버에는 Java 가 필요해요. 새 서버 만들기는 필요한 Java 를 앱 폴더에 받아서 써요.

[환경 변수 (선택)]
  BLOCKPILOT_PORT=4801       다른 포트로 켜기
  BLOCKPILOT_NO_BROWSER=1    브라우저를 자동으로 열지 않기
  BLOCKPILOT_HOST=0.0.0.0    다른 기기에서 접속 (접속 토큰이 자동으로 켜져요)

받은 파일이 맞는지는 릴리스 페이지의 SHA256SUMS.txt 와 비교해 보세요.
https://github.com/sjc4197/BlockPilot
