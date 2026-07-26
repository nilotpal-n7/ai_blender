import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable React strict mode for better development experience
  reactStrictMode: true,

  // Transpile Three.js ecosystem packages
  transpilePackages: ["three", "@react-three/fiber", "@react-three/drei"],

  // TODO: WebGPU configuration (uncomment when migrating from WebGL)
  // webpack: (config) => {
  //   // Allow importing .wgsl shader files
  //   config.module.rules.push({
  //     test: /\.wgsl$/,
  //     type: "asset/source",
  //   });
  //   return config;
  // },

  // TODO: Standalone output for Docker production builds
  // output: "standalone",
};

export default nextConfig;
