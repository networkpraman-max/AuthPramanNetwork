import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  shims: true,
  minify: false,
  sourcemap: true,
  // TSLib ko bundle ke andar force karo
  noExternal: ['tslib'], 
  // IMPORTANT: Jo dependencies browser-side use ho rahi hain, unhe external rakho
  // Lekin tslib ko yahan se hata do
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