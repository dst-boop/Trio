import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trio — Collective intelligence",
  description: "One workspace for ChatGPT, Claude, and Gemini. Independent perspectives, peer review, and a stronger combined answer.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
