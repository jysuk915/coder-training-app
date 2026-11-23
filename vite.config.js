import { defineConfig } from 'vite';

// base './' makes the built site work at any GitHub Pages address
// (username.github.io/any-repo-name/) without editing this file.
export default defineConfig({
  base: './',
  test: { testTimeout: 60000, hookTimeout: 60000 },
});
