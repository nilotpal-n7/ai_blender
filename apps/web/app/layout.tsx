import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Blender — 3D AI Co-pilot",
  description:
    "Convert text prompts into fully editable 3D scenes. A human-in-the-loop AI platform powered by OpenUSD, headless Blender, and open-weight generative models.",
  keywords: [
    "3D AI",
    "text to 3D",
    "OpenUSD",
    "Blender",
    "generative AI",
    "3D scene editor",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
