import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // Allow larger file uploads for videos
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
};

export default nextConfig;
