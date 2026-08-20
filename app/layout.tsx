import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") || "localhost:3000";
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  const siteUrl = `${protocol}://${host}`;
  return {
    metadataBase: new URL(siteUrl),
    title: "FreeCap 免費字幕｜本機 AI 字幕工作台",
    description: "在你的裝置上免費辨識、編輯與燒錄影片字幕。支援 Claude、Cursor、Codex 的本機 MCP。",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "FreeCap 免費字幕｜字幕，留在你的電腦裡。",
      description: "無 API key、無雲端上傳的本機 AI 字幕工作台。",
      type: "website",
      images: [{ url: `${siteUrl}/og.png`, width: 1731, height: 909, alt: "FreeCap 免費字幕" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "FreeCap 免費字幕",
      description: "本機辨識、編輯、燒錄影片字幕。",
      images: [`${siteUrl}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
