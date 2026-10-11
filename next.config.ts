import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Development logs print each server function call with its arguments; a form post's arguments are personal data.
  logging: { serverFunctions: false },
  // The apply form's post: a 5 MB CV plus the form's other fields. The default is 1 MB.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
};

export default nextConfig;
