import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  // Development logs print each server function call with its arguments; a form post's arguments are personal data.
  logging: { serverFunctions: false },
  // The apply form's post: a 5 MB CV plus the form's other fields. The default is 1 MB.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
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
