# PramanAuth SDK Developer Documentation

**Status:** 🧪 Beta | **Network:** Polygon Amoy (Testnet)

Welcome to the PramanAuth SDK documentation. PramanAuth is a decentralized Identity-as-a-Service (IaaS) offering privacy-preserving, zero-knowledge (ZK) biometric authentication. 

Under the new **Web2.5 Hybrid Relayer (BaaS)** architecture, transactions are gasless, there are no MetaMask popups for the user, and all IPFS uploads/contract writes are handled securely off-chain by our backend relayer.

---

## Installation

Add the SDK package to your frontend project:

```bash
npm install @praman-network/sdk
```

---

## 1. Initialization

Initialize the SDK instance inside your app config or root component (compatible with both Next.js and Vite). Pass the `backendUrl` of your Backend Relayer:

```typescript
import { initPraman } from '@praman-network/sdk';

const praman = initPraman({
  apiKey: "YOUR_API_KEY",
  network: "polygon-amoy",
  idpUrl: "https://auth.praman.network",   // Updated for production
  backendUrl: "https://api.praman.network" // Updated for production
});
```

---

## 2. Triggering Popup Authentication (Firebase-style UX)

You can launch a centered OAuth-style popup window for face scanning and consent verification by calling `loginWithPopup()` or `registerWithPopup()`.

```typescript
import React, { useState } from 'react';
import { initPraman } from '@praman-network/sdk';

// Initialize PramanAuth SDK
const pramanAuth = initPraman({
  apiKey: "YOUR_API_KEY",
  network: "polygon-amoy",
  idpUrl: "https://auth.praman.network",
  backendUrl: "https://api.praman.network"
});

export function App() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      // Opens a centered popup, handles the consent screen, and runs ZK face verification
      const result = await pramanAuth.loginWithPopup({
        scopes: ['email', 'profile'],
      });

      if (result.success) {
        setUser(result.user);
        console.log("Decentralized Session Token:", result.token);
        console.log("ZK Proof details:", result.proof);
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h2>PramanAuth Web3 Login</h2>
      
      {user ? (
        <div>
          <p><strong>DID Address:</strong> {user.did}</p>
          {user.email && <p><strong>Email Address:</strong> {user.email}</p>}
          <button onClick={() => setUser(null)}>Logout</button>
        </div>
      ) : (
        <button onClick={handleLogin} disabled={loading}>
          {loading ? 'Authenticating...' : 'Sign In with PramanAuth'}
        </button>
      )}

      {error && <p style={{ color: 'red' }}>Error: {error}</p>}
    </div>
  );
}
```

---

## 3. Registering New Users

If you want to onboard a new user, call `registerWithPopup()` with custom options. It displays the registration inputs and secures their credentials:

```typescript
const handleRegister = async () => {
  try {
    const result = await pramanAuth.registerWithPopup({
      scopes: ['email', 'profile']
    });
    if (result.success) {
      alert(`Successfully registered DID: ${result.user.did}`);
    }
  } catch (err: any) {
    alert("Registration failed: " + err.message);
  }
};
```

---

## 4. Verifying Token (Client-Side & Backend)

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
