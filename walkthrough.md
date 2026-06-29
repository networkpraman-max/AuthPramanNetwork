# Monorepo Refactor Walkthrough & IaaS Platform Architecture

We have successfully refactored the PramanAuth project into a modular, production-ready, Turborepo-driven monorepo containing a publishable `@praman-network/sdk` NPM package, a hosted identity provider app, developer docs, and a backend verification server.

---

## 1. Monorepo Directory Layout

```
/Users/rahulchaudhary/pramanauth/
├── package.json                    ← workspace definitions + root scripts
├── turbo.json                      ← task execution orchestrator
├── tsconfig.json                   ← workspace TS references
├── packages/
│   └── sdk/                        ← @praman-network/sdk package
│       ├── package.json            ← public exports (esm/cjs/dts)
│       ├── tsup.config.ts          ← build configuration (zero-config, high-performance)
│       ├── tsconfig.json           ← target ESM & React JSX compilation configs
│       └── src/
│           ├── index.ts            ← barrel export module
│           ├── client.ts           ← PramanClient class, Webhook analytics, and SIWE-based JWT tokens
│           ├── biometrics.ts       ← 128-d vector quantization and Keccak hashing
│           ├── zkLayer.ts          ← biometric similarity & snarkjs proof logic
│           ├── storageLayer.ts     ← environment-agnostic Lit Protocol & IPFS integration
│           └── contracts/
│               └── FaceRegistry.json
├── apps/
│   ├── identity-provider/          ← hosted provider application
│   │   ├── package.json            ← imports `@praman-network/sdk` locally
│   │   ├── src/                    ← onboarding & login flows utilizing `@praman-network/sdk`
│   │   └── public/                 ← face-api models and zk proving files
│   └── documentation/
│       └── README.md               ← developer implementation guide
└── server/
    └── verify-endpoint/            ← express backend token verification server
```

---

## 2. Platform Core Architecture & Standardizations

### A. Decentralized Wallet-Signed JWT
The SDK generates a decentralized token on login/registration:
- **Structure**: `header.payload.signature`
- **Payload**: Contains `sub` (wallet address), `faceHash`, `ipfsCid`, `iat` (issued at), and `exp` (expiration).
- **Verification**: The token is signed using the user's Metamask wallet key via EIP-4361 standard SIWE formatting. Any backend server can verify this token offline (no database calls required) by running `ethers.verifyMessage`.

### B. Scalable Usage Tracking & Analytics
`PramanClient` has built-in webhook logic. If a developer sets `webhookUrl`, the SDK fires event notifications for registration/login success/failure events.

### C. Environment Agnostic
All browser references (like `window.location`) and environment variables are wrapped to prevent SSR errors in frameworks like Next.js or Remix.

---

## 3. Reference Implementation Verification

### Express Server Verification
We created a reference server under `server/verify-endpoint/` that exposes `/verify` POST request verification:
```javascript
const recoveredAddress = ethers.verifyMessage(messageToVerify, signature);
if (recoveredAddress.toLowerCase() !== payload.sub.toLowerCase()) {
  throw new Error('Invalid signature');
}
```

### Visual Verification & Build Output
Turborepo builds all modules concurrently in optimal topological order. Output is clean with zero compilation warnings:
```bash
npx turbo run build
```
- `@praman-network/sdk`: Builds ES module (`dist/index.js`), CommonJS (`dist/index.cjs`), and TypeScript declarations (`dist/index.d.ts`).
- `identity-provider`: Successfully compiles into client assets.
