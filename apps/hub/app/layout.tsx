import { SpeedInsights } from "@vercel/speed-insights/next";
import type { Metadata } from "next";
import { Geist_Mono, Geist_Pixel } from "next/font/google";
import "streamdown/styles.css";
import { rumEnabled } from "@/lib/rum/client";
import "./globals.css";

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

// The Busy wordmark and display moments, as on busybot.dev.
const geistPixel = Geist_Pixel({
  subsets: ["latin"],
  variable: "--font-geist-pixel",
});

export const metadata: Metadata = {
  description:
    "Your own team of AI bots, each with memory, tools, and its own computer.",
  metadataBase: new URL(process.env.HUB_URL ?? "https://app.busybot.dev"),
  openGraph: {
    description:
      "Your own team of AI bots, each with memory, tools, and its own computer.",
    locale: "en_US",
    siteName: "Busy",
    title: "Busy",
    type: "website",
  },
  title: "Busy",
  twitter: {
    card: "summary_large_image",
    description:
      "Your own team of AI bots, each with memory, tools, and its own computer.",
    images: [
      new URL(
        "/opengraph-image.png",
        process.env.HUB_URL ?? "https://app.busybot.dev"
      ),
    ],
    title: "Busy",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      className={`${geistMono.variable} ${geistPixel.variable} dark h-full antialiased`}
      lang="en"
    >
      <body className="flex min-h-full flex-col">
        {children}
        {rumEnabled() ? <SpeedInsights /> : null}
      </body>
    </html>
  );
}
