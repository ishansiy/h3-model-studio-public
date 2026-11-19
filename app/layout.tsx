import type { Metadata } from "next";
import "./globals.css";
import "./model-studio.css";

export const metadata: Metadata = {
  title: "模型工作室",
  description: "连接计算资源，使用开源模型生成、管理与下载图片和视频。",
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
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
