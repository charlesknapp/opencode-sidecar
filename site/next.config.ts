import type { NextConfig } from "next"

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  headers: async () => [
    { source: "/:path*", headers: securityHeaders },
    // Media and demo files are linked with ?v=<hash of their content> (src/lib/assets.ts,
    // scripts/build-demo.mjs), so a changed file always has a new URL: browsers and the
    // CDN can keep each one for a year. Unversioned URLs keep the default revalidation.
    {
      source: "/:file((?:demo/)?[\\w.-]+\\.(?:mp4|webp|jpg|js|css))",
      has: [{ type: "query", key: "v" }],
      headers: [
        { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
      ],
    },
  ],
}

export default nextConfig
