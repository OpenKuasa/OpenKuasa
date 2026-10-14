import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  // Development logs print each server function call with its arguments; a form post's arguments are personal data.
  logging: { serverFunctions: false },
  experimental: {
    // The apply form's post: a 5 MB CV plus the form's other fields. The default is 1 MB.
    serverActions: { bodySizeLimit: "6mb" },
    // Client-side Router Cache. A page you just visited is re-served from the browser on
    // back/forward or re-navigation for this many seconds, with no server round-trip
    // (the `dynamic` default is 0 — always refetch). This is per-user, per-session browser
    // state, so it never crosses workspaces; the trade-off is a revisit can show data up
    // to `dynamic` seconds old until the next full load. `static` covers prefetched pages
    // and loading.tsx boundaries.
    staleTimes: { dynamic: 30, static: 180 },
  },
  // The fixed security headers, on every path. The full Content-Security-Policy carries a per-request nonce,
  // so src/proxy.ts sets it.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: staticSecurityHeaders({ isProd: process.env.NODE_ENV === "production" }),
      },
    ];
  },
};

export default nextConfig;
