import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Force no-store on all routes — prevents Next.js edge/CDN caching
  // from serving stale data on repeated visits.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
          { key: "Pragma",        value: "no-cache" },
        ],
      },
    ];
  },
};

export default nextConfig;
