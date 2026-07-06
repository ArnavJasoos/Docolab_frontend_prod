import type { NextConfig } from "next";
import withBundleAnalyzer from "@next/bundle-analyzer";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the workspace root — a stray package-lock.json in a parent directory
  // otherwise makes Next infer the wrong root. dev/build always run from this
  // frontend dir, so cwd is the correct root.
  turbopack: {
    root: process.cwd(),
  },
};

const bundleAnalyzer = withBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

export default bundleAnalyzer(nextConfig);

