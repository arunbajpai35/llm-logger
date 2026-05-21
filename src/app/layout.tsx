import "./globals.css";
import { Inter } from "next/font/google";
import { NavLinks } from "./_components/nav-links";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata = { title: "LLM Logger", description: "Streaming chatbot with inference observability" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body style={{ fontFamily: "var(--font-inter), ui-sans-serif, system-ui, sans-serif" }}>
        <div className="min-h-screen flex flex-col">
          <header className="sticky top-0 z-30 backdrop-blur-xl bg-[rgba(10,10,11,0.7)] border-b border-[var(--border)]">
            <div className="mx-auto max-w-6xl px-6 h-14 flex items-center gap-8">
              <a href="/" className="flex items-center gap-2 group">
                <span className="w-6 h-6 rounded-md bg-gradient-to-br from-[#8b6dff] to-[#5b3df7] flex items-center justify-center text-[11px] font-bold text-white shadow-[0_4px_12px_-4px_var(--accent-glow)]">L</span>
                <span className="font-semibold tracking-tight">llm-logger</span>
              </a>
              <NavLinks />
              <div className="flex-1" />
              <a
                href="https://github.com"
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
              >
                v0.1
              </a>
            </div>
          </header>
          <main className="flex-1 mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
