/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    // 딥슬레이트 회로 테마: 블록 세계라 둥근 모서리를 쓰지 않는다 (full 은 남겨 둠)
    borderRadius: {
      none: "0",
      sm: "0",
      DEFAULT: "0",
      md: "0",
      lg: "0",
      xl: "0",
      "2xl": "0",
      "3xl": "0",
      full: "9999px",
    },
    extend: {
      fontFamily: {
        sans: ["IBM Plex Sans KR", "Noto Sans KR", "Apple SD Gothic Neo", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "SFMono-Regular", "Menlo", "Consolas", "ui-monospace", "monospace"],
        // 로고 전용 (라틴 대문자만 있음)
        pixel: ["Silkscreen", "Galmuri11", "ui-monospace", "monospace"],
        // 제목·메뉴·라벨용 한글 픽셀 서체
        block: ["Galmuri11", "IBM Plex Sans KR", "ui-monospace", "monospace"],
      },
      colors: {
        // 딥슬레이트 레이어: 0(가장 깊음) → 4(가장 튀어나옴)
        ink: {
          0: "#111113",
          1: "#18181c",
          2: "#222228",
          3: "#2d2d35",
          4: "#3a3a43",
        },
        line: {
          DEFAULT: "rgba(160, 160, 176, 0.14)",
          strong: "rgba(160, 160, 176, 0.26)",
        },
        bevel: {
          hi: "#4a4a55",
          lo: "#08080a",
        },
        redstone: {
          DEFAULT: "#ff3b2f",
          dim: "#6b1a14",
          off: "#34110e",
        },
        lamp: {
          DEFAULT: "#ffb347",
          hi: "#ffe2a8",
          off: "#3a2a1c",
        },
        // 강조색 = 레드스톤
        brand: {
          50: "#fff1f0",
          100: "#ffdfdc",
          300: "#ff9b93",
          400: "#ff6b5f",
          500: "#ff3b2f",
          600: "#e0291e",
          700: "#b31d14",
        },
      },
      boxShadow: {
        // 돌판처럼 볼록 (빛 받는 위·왼쪽 밝게, 아래·오른쪽 어둡게)
        slab: "inset 2px 2px 0 #4a4a55, inset -2px -2px 0 #08080a",
        // 움푹 파인 홈 (입력칸, 콘솔)
        well: "inset 2px 2px 0 #08080a, inset -2px -2px 0 #2c2c33",
        pressed: "inset 2px 2px 0 #08080a, inset -2px -2px 0 #4a4a55",
        pop: "inset 2px 2px 0 #4a4a55, inset -2px -2px 0 #08080a, 0 12px 32px -8px rgba(0,0,0,0.8)",
      },
      keyframes: {
        "fade-in": { from: { opacity: 0 }, to: { opacity: 1 } },
        "slide-up": { from: { opacity: 0, transform: "translateY(8px)" }, to: { opacity: 1, transform: "translateY(0)" } },
        "slide-in-right": { from: { opacity: 0, transform: "translateX(16px)" }, to: { opacity: 1, transform: "translateX(0)" } },
      },
      animation: {
        "fade-in": "fade-in .2s steps(4) both",
        "slide-up": "slide-up .25s steps(5) both",
        "slide-in-right": "slide-in-right .2s steps(4) both",
      },
    },
  },
  plugins: [],
};
