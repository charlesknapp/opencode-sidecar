import type { Metadata, Viewport } from "next"
import { GeistMono } from "geist/font/mono"
import { GeistSans } from "geist/font/sans"

import { site } from "@/config/site"

import "@/styles/globals.css"

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: site.title,
  description: site.summary,
  applicationName: site.name,
  alternates: { canonical: "/" },
  keywords: [
    "OpenCode",
    "OpenCode VS Code extension",
    "OpenCode GUI",
    "OpenCode sidebar",
    "OpenCode chat",
    "VS Code AI coding agent",
    "Cursor",
    "VSCodium",
    "Windsurf",
  ],
  openGraph: {
    type: "website",
    url: "/",
    siteName: site.name,
    title: site.title,
    description: site.summary,
  },
  twitter: {
    card: "summary_large_image",
    title: site.title,
    description: site.summary,
  },
}

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark",
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh bg-background font-sans text-foreground">
        {children}
      </body>
    </html>
  )
}
