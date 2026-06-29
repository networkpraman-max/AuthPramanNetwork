import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  minify: false,
  sourcemap: true,
  noExternal: ['tslib'], // Bundling tslib
  
  // FINAL FIX: Inject a dummy require function for browser environments
  banner: {
    js: `
      import { createRequire as __createRequire } from 'module';
      const require = (typeof window !== 'undefined') ? (() => {}) : __createRequire(import.meta.url);
    `,
  },
  
  external: [
    'react',
    'ethers',
    'snarkjs',
    '@lit-protocol/lit-node-client'
  ],
  loader: {
    '.json': 'copy'
  }
});