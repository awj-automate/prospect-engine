import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The worker imports the same lib/ code; keep the server bundle lean and
  // don't try to bundle native/driver deps that must resolve at runtime.
  serverExternalPackages: ["postgres", "@anthropic-ai/sdk"],
  eslint: {
    // We ship and iterate; don't let lint block a deploy.
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.licdn.com" },
      { protocol: "https", hostname: "**.linkedin.com" },
    ],
  },
};

export default nextConfig;
