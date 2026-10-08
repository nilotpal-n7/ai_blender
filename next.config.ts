import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Route params and props are checked against the app's actual routes.
  typedRoutes: true,
  // The editor uses every corner of the window; errors still surface without the badge.
  devIndicators: false,
};

export default nextConfig;
