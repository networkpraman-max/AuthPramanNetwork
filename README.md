# PramanAuth Network

**Status:** 🧪 Beta | **Network:** Polygon Amoy (Testnet)

PramanAuth is a decentralized, privacy-preserving Identity-as-a-Service (IaaS) platform offering zero-knowledge (ZK) biometric authentication. It enables trustless identity validation on Web3 applications without centralized biometric databases.

---

## Project Repository Architecture

This is a monorepo containing all components of the PramanAuth network:

*   **[`packages/sdk`](file:///Users/rahulchaudhary/pramanauth/packages/sdk)**: The core PramanAuth TypeScript/React SDK for developers.
*   **[`apps/identity-provider`](file:///Users/rahulchaudhary/pramanauth/apps/identity-provider)**: Client-facing React/Vite app containing the webcam scanners, face-matching algorithms, and ZK proof generation.
*   **[`server/verify-endpoint`](file:///Users/rahulchaudhary/pramanauth/server/verify-endpoint)**: A lightweight reference backend implementation to verify signed session tokens.
*   **[`circuits`](file:///Users/rahulchaudhary/pramanauth/circuits)**: Circom zero-knowledge matching circuits (`face_verify.circom`).
*   **[`contracts`](file:///Users/rahulchaudhary/pramanauth/contracts)**: Solidity smart contracts (`FaceRegistry.sol`) running on-chain.

---

## SDK Integration Guide

### Installation

Add the SDK package to your frontend project:

```bash
npm install @praman/sdk
```

### 1. Initialization

Initialize the SDK instance inside your app config or root component (compatible with both Next.js and Vite):

```typescript
import { initPraman } from '@praman/sdk';

const praman = initPraman({
  apiKey: "pm_live_your_api_key_here",
  network: "polygon-amoy", // or local
  webhookUrl: "https://your-backend.com/api/praman-events" // optional billing/analytics tracking
});
```

### 2. Triggering Login Flow

During login, your app scans the user's face, captures a webcam frame base64 string, and calls the SDK `login` method. 

```typescript
import { useWallet } from './your-wallet-context'; // get signer / provider

const handleLogin = async (webcamScreenshotBase64: string) => {
  const result = await praman.login(
    webcamScreenshotBase64,
    signer,
    window.faceapi // pass loaded faceapi instance
  );

  if (result.success) {
    console.log("Decentralized Session Token:", result.jwt);
    console.log("ZK Proof details:", result.proof);
    console.log("Is Mock Proof:", result.is_mock); // Flag representing proof authenticity
    
    // Send token to your backend server for verification!
    const response = await fetch('/api/verify', {
      method: 'POST',
      body: JSON.stringify({ token: result.jwt }),
      headers: { 'Content-Type': 'application/json' }
    });
    const authData = await response.json();
    if (authData.valid) {
      alert("Successfully Logged In!");
    }
  } else {
    alert("Authentication failed: " + result.error);
  }
};
```

### 3. Triggering Registration Flow

During registration, gather user form data, scan their face, and invoke `register`:

```typescript
const handleRegister = async (webcamScreenshotBase64: string, pii: { name: string, email: string, mobile: string }) => {
  const result = await praman.register(
    webcamScreenshotBase64,
    pii,
    signer,
    window.faceapi
  );

  if (result.success) {
    console.log("Registered identity session JWT:", result.jwt);
    alert("Biometric credentials registered on-chain successfully!");
  } else {
    alert("Registration failed: " + result.error);
  }
};
```

---

## Verification & Backend Integration

### Client-Side Decrypt/Read
You can quickly read and verify token contents in the client browser:

```typescript
const verifyTokenResult = praman.verifyToken(token);
if (verifyTokenResult.valid) {
  console.log("Authenticated User Wallet Address:", verifyTokenResult.payload.sub);
  console.log("Is Mock Token:", verifyTokenResult.payload.is_mock);
}
```

### Backend Integration
When your backend receives the token from the client, it must decrypt and verify it.

> [!IMPORTANT]
> **Mandatory Security Rule:** Always check the `is_mock` flag in the decoded token payload on your backend. If `is_mock` is `true` in a production environment, the authentication transaction **MUST** be rejected to prevent mock-bypass exploits.

---

## Security Best Practices

### Production Hardening & Environment Guard
The PramanAuth SDK is production-hardened to prevent development simulation tools from leaking into live deployments.

> [!WARNING]
> **Environment Guard:** In production mode, the SDK enforces a strict **hard-fail** policy. If real ZK proof generation fails (due to missing static files like `.wasm`/`.zkey`, or browser resource exhaustion), it will throw a critical error rather than falling back to a mock proof. 
> 
> Ensure that your production bundler config or environment variable (`import.meta.env.MODE` for Vite or `process.env.NODE_ENV` for Node environments) is correctly set to `'production'` in your deployed builds.

---

## Privacy, Sovereignty & Zero-Knowledge Verification

PramanAuth is designed around user sovereignty and mathematical trust, ensuring that biometrics can be verified without sacrificing privacy.

*   **Zero Biometric Storage:** We do not store raw biometric data (such as images, photos, or raw face descriptors) on any centralized server or database.
*   **Decentralized Verification:** 128-dimensional quantized face vectors are converted into a Keccak256 hash. The actual mathematical verification is performed locally inside the user's browser using client-side ZK-SNARK Proving (via Groth16 SnarkJS).
*   **Cryptographic Verifiability:** Since only the zero-knowledge proof is sent for verification, your servers and the public ledger never gain visibility of the user's raw face measurements. Trust is mathematically guaranteed.
