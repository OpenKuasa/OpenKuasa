import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Development logs print each server function call with its arguments; a form post's arguments are personal data.
  logging: { serverFunctions: false },
};

export default nextConfig;
