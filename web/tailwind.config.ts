import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        ide: {
          dark: "#0b0f19",
          panel: "#111827",
          border: "#1f2937",
          accent: "#6366f1",
          success: "#10b981",
          warning: "#f59e0b",
        },
      },
    },
  },
  plugins: [],
};
export default config;
