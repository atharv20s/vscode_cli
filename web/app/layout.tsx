import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ATH IDE — Autonomous AI Studio & Distributed Workspace",
  description: "Next.js Powered High-Performance Autonomous AI Developer Environment",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="bg-ide-dark text-slate-100 antialiased h-screen overflow-hidden">
        {children}
      </body>
    </html>
  );
}
