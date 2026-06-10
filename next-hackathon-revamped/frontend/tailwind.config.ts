import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          base:    "#08090a",
          panel:   "#0f1011",
          surface: "#191a1b",
          hover:   "#28282c",
        },
        text: {
          primary:   "#f7f8f8",
          secondary: "#d0d6e0",
          muted:     "#8a8f98",
          subtle:    "#62666d",
        },
        border: {
          DEFAULT: "rgba(255,255,255,0.08)",
          subtle:  "rgba(255,255,255,0.05)",
          solid:   "#23252a",
        },
        accent: {
          DEFAULT: "#5e6ad2",
          bright:  "#7170ff",
          hover:   "#828fff",
        },
        success: "#10b981",
        warning: "#f59e0b",
        danger:  "#ef4444",
        info:    "#3b82f6",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        micro: "2px",
        sm:    "4px",
        DEFAULT:"6px",
        md:    "8px",
        lg:    "12px",
        xl:    "22px",
        full:  "9999px",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(20px)" },
          to:   { opacity: "1", transform: "translateX(0)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%":      { opacity: "0.4" },
        },
        shimmer: {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition:  "200% 0" },
        },
      },
      animation: {
        "fade-in":        "fade-in 0.3s ease forwards",
        "slide-in-right": "slide-in-right 0.3s ease forwards",
        "pulse-dot":      "pulse-dot 1.5s ease-in-out infinite",
        shimmer:          "shimmer 2s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
