import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/sandbox/**", "src/index.ts"],
    },
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      "@agents": "./src/agents",
      "@tools": "./src/tools",
      "@adapter": "./src/adapter",
      "@config": "./src/config",
      "@mcp": "./src/mcp",
    },
  },
});
