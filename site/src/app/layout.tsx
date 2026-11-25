import type { Metadata, Viewport } from "next"
import localFont from "next/font/local"
import { Analytics } from "@vercel/analytics/next"

import { site } from "@/config/site"

import "@/styles/globals.css"

// Geist (SIL OFL, see src/fonts/OFL.txt), cut down to the characters a page can use:
// Latin, punctuation, arrows and a few symbols. Half the size of the full fonts.
// Made with fontTools from the geist package's variable fonts:
//   pyftsubset <font>.woff2 --flavor=woff2 --layout-features='*' --unicodes=
//   U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2000-206F,
//   U+20AC,U+2122,U+2190-21FF,U+2212,U+2318,U+2325,U+23CE,U+2442,U+25A0-25FF,U+2713,U+2715
const GeistSans = localFont({
  src: "../fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
})
const GeistMono = localFont({
  src: "../fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
})

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: site.title,
  description: site.summary,
  applicationName: site.name,
  alternates: { canonical: "/" },
  verification: {
    other: { "msvalidate.01": "1F8B915FB03AF2E92D0C0626E8734ECC" },
  },
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
        <Analytics />
      </body>
    </html>
  )
}
