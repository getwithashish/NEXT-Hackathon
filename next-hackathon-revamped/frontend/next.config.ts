import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Force no-store on all routes — prevents Next.js edge/CDN caching
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
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com", // Google profile pictures
      },
    ],
  },
};

export default nextConfig;
