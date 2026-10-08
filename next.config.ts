import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  redirects: async () => [{ source: "/", destination: "/btc", permanent: false }],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
