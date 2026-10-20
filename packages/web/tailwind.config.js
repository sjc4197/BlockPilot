/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "Pretendard", "Noto Sans KR", "Apple SD Gothic Neo", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "SFMono-Regular", "Menlo", "Consolas", "ui-monospace", "monospace"],
        pixel: ["Silkscreen", "ui-monospace", "monospace"],
      },
      colors: {
        // 배경 레이어: 0(가장 깊음) → 3(떠 있는 요소)
        ink: {
          0: "#070a12",
          1: "#0b0f1a",
          2: "#111827",
          3: "#182033",
          4: "#1f2a40",
        },
        line: {
          DEFAULT: "rgba(148, 163, 184, 0.12)",
          strong: "rgba(148, 163, 184, 0.24)",
        },
        redstone: {
          DEFAULT: "#ff3b2f",
          dim: "#6b1a14",
        },
        brand: {
          50: "#ecfdf5",
          100: "#d1fae5",
          300: "#6ee7b7",
          400: "#34d399",
          500: "#10b981",
          600: "#059669",
          700: "#047857",
        },
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.6)",
        pop: "0 12px 40px -12px rgba(0,0,0,0.7), 0 0 0 1px rgba(148,163,184,0.12)",
        glow: "0 0 0 1px rgba(16,185,129,0.35), 0 8px 24px -8px rgba(16,185,129,0.45)",
      },
      keyframes: {
        "fade-in": { from: { opacity: 0 }, to: { opacity: 1 } },
        "slide-up": { from: { opacity: 0, transform: "translateY(8px)" }, to: { opacity: 1, transform: "translateY(0)" } },
        "slide-in-right": { from: { opacity: 0, transform: "translateX(16px)" }, to: { opacity: 1, transform: "translateX(0)" } },
        "pulse-dot": { "0%, 100%": { opacity: 1 }, "50%": { opacity: 0.35 } },
      },
      animation: {
        "fade-in": "fade-in .25s ease-out both",
        "slide-up": "slide-up .3s cubic-bezier(.2,.8,.2,1) both",
        "slide-in-right": "slide-in-right .25s cubic-bezier(.2,.8,.2,1) both",
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
