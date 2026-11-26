import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/api/observations": ["./public/data/network-static.json"],
  },
  webpack: (config, { isServer, dev }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        "node:sqlite": "commonjs node:sqlite",
      });
    }
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          "**/node_modules/**",
          "**/.git/**",
          "**/data/**",
          path.resolve(process.cwd(), "data") + "/**",
        ],
      };
    }
    return config;
  },
};

export default nextConfig;
