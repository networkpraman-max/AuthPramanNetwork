import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import * as snarkjs from 'snarkjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });      // Load local verify-endpoint/.env first
dotenv.config({ path: path.resolve(__dirname, '../../.env') }); // Fallback to workspace root .env

// Load contract config
const faceRegistryConfig = JSON.parse(
  fs.readFileSync(new URL('../../packages/sdk/src/contracts/FaceRegistry.json', import.meta.url))
);

// Load SnarkJS verification key if exists
let vKey = null;
try {
  vKey = JSON.parse(
    fs.readFileSync(new URL('../../build/verification_key.json', import.meta.url))
  );
} catch (e) {
  try {
    vKey = JSON.parse(
      fs.readFileSync(new URL('../../apps/identity-provider/public/zk/verification_key.json', import.meta.url))
    );
  } catch (err) {
    console.warn("[PramanVerifyServer] Warning: verification_key.json not found. Real ZK proof verification will fail.");
  }
}

const provider = new ethers.JsonRpcProvider("https://rpc-amoy.polygon.technology");
const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!relayerPrivateKey) {
  console.warn("[PramanVerifyServer] Warning: RELAYER_PRIVATE_KEY and PRIVATE_KEY environment variables are missing. Relayer transactions will fail.");
}
const relayerWallet = relayerPrivateKey ? new ethers.Wallet(relayerPrivateKey, provider) : null;
const contract = relayerWallet ? new ethers.Contract(faceRegistryConfig.address, faceRegistryConfig.abi, relayerWallet) : null;

// Pinata Upload helper
async function uploadToIPFS(payload) {
  const jwt = process.env.PINATA_JWT || process.env.VITE_PINATA_JWT || process.env.PINATA_API_KEY;
  if (!jwt) {
    throw new Error("Server Error: PINATA_JWT environment variable is missing.");
  }

  const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      pinataContent: payload,
      pinataMetadata: {
        name: `pramanauth_${payload.userAddress.slice(0, 8)}.json`,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pinata upload failed with status ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return { cid: data.IpfsHash };
}

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Helper function to verify the wallet-signed JWT token sent by the client.
 */
function verifyPramanToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }

    const [headerB64, payloadB64, signature] = parts;
    
    // Decode base64 URL-safe string
    const payloadString = Buffer.from(
      payloadB64.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString();
    const payload = JSON.parse(payloadString);

    // 1. Expiration validation
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      throw new Error('Token expired');
    }

    // 2. Issuer validation
    if (payload.iss !== 'pramanauth') {
      throw new Error('Invalid token issuer');
    }

    // 3. Reconstruct payload signature string
    const messageToVerify = `${headerB64}.${payloadB64}`;

    // 4. Recover address of signing wallet
    const recoveredAddress = ethers.verifyMessage(messageToVerify, signature);

    if (recoveredAddress.toLowerCase() !== payload.sub.toLowerCase()) {
      throw new Error('Invalid signature - wallet address mismatch');
    }

    return {
      valid: true,
      address: recoveredAddress,
      payload,
    };
  } catch (error) {
    return {
      valid: false,
      error: error.message,
    };
  }
}

/**
 * POST /verify endpoint
 * Expects: { token: string }
 */
app.post('/verify', (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ valid: false, error: 'Token is required' });
  }

  const result = verifyPramanToken(token);

  if (!result.valid) {
    return res.status(401).json({ valid: false, error: result.error });
  }

  return res.json({
    valid: true,
    address: result.address,
    faceHash: result.payload.faceHash,
    ipfsCid: result.payload.ipfsCid,
    name: result.payload.name || null,
    is_mock: result.payload.is_mock || false,
  });
});

// In-memory store for handover sessions
const handoverSessions = {};

// Helper to generate handover JWT
function generateHandoverJWT(sessionId, address, mode) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: address?.toLowerCase() || 'unknown',
    sessionId,
    mode,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600, // 10 minutes
  };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = Buffer.from(`${sessionId}_secret_sig`).toString('base64url');
  return `${headerB64}.${payloadB64}.${signature}`;
}

// POST /api/handover/init
app.post('/api/handover/init', (req, res) => {
  const { address, mode } = req.body;
  const sessionId = 'sess_' + Math.random().toString(36).substring(2, 15);
  const token = generateHandoverJWT(sessionId, address, mode);

  handoverSessions[sessionId] = {
    sessionId,
    address: address?.toLowerCase() || '',
    mode: mode || 'register',
    status: 'pending',
    result: null,
    createdAt: Date.now(),
  };

  return res.json({
    success: true,
    sessionId,
    handoverToken: token,
  });
});

// POST /api/handover/complete
app.post('/api/handover/complete', (req, res) => {
  const { sessionId, result } = req.body;

  if (!sessionId || !handoverSessions[sessionId]) {
    return res.status(404).json({ success: false, error: 'Session not found or expired' });
  }

  handoverSessions[sessionId].status = 'completed';
  handoverSessions[sessionId].result = result;

  return res.json({
    success: true,
  });
});

// GET /api/handover/status/:sessionId
app.get('/api/handover/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = handoverSessions[sessionId];

  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  // Cleanup sessions older than 15 minutes to save memory
  if (Date.now() - session.createdAt > 15 * 60 * 1000) {
    delete handoverSessions[sessionId];
    return res.status(410).json({ success: false, error: 'Session has timed out' });
  }

  return res.json({
    success: true,
    status: session.status,
    result: session.result,
  });
});

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { apiKey, userAddress, faceDescriptorHash, quantizedVector, ciphertext, dataToEncryptHash, authSig } = req.body;

    // 1. Validate Developer API Key
    if (!apiKey || !apiKey.startsWith('pm_')) {
      return res.status(401).json({ success: false, error: 'Invalid or missing API Key.' });
    }

    // 2. Validate inputs
    if (!userAddress || !faceDescriptorHash || !quantizedVector || !ciphertext || !dataToEncryptHash) {
      return res.status(400).json({ success: false, error: 'Missing registration parameters.' });
    }

    // 3. Cryptographically verify user authorization signature (SIWE format)
    if (!authSig || !authSig.sig || !authSig.signedMessage) {
      return res.status(400).json({ success: false, error: 'Missing cryptographic authorization signature (authSig).' });
    }
    const recoveredAddress = ethers.verifyMessage(authSig.signedMessage, authSig.sig);
    if (recoveredAddress.toLowerCase() !== userAddress.toLowerCase()) {
      return res.status(401).json({ success: false, error: 'Authorization signature mismatch. Registration denied.' });
    }

    // 4. Verify duplicate registration check on-chain first before uploading to IPFS
    if (!contract) {
      return res.status(500).json({ success: false, error: 'Backend contract connection is not initialized.' });
    }
    const storedFaceHash = await contract.getUserFaceHash(userAddress);
    const zeroHash = '0x0000000000000000000000000000000000000000000000000000000000000000';
    if (storedFaceHash !== zeroHash && storedFaceHash !== '0x') {
      return res.status(400).json({ success: false, error: 'User wallet already registered.' });
    }

    const isFaceRegistered = await contract.isFaceRegistered(faceDescriptorHash);
    if (isFaceRegistered) {
      return res.status(400).json({ success: false, error: 'Biometric face identity already registered.' });
    }

    // 5. Secure Pinata IPFS Upload on backend
    const ipfsPayload = {
      ciphertext,
      dataToEncryptHash,
      faceDescriptorHash,
      quantizedVector,
      userAddress,
    };
    const ipfsResult = await uploadToIPFS(ipfsPayload);

    // 6. Broadcast Gas-sponsored contract transaction
    console.log(`[Relayer] Registering face hash ${faceDescriptorHash} for user ${userAddress} gaslessly...`);
    const tx = await contract.registerFaceFor(userAddress, faceDescriptorHash, ipfsResult.cid, {
      maxPriorityFeePerGas: ethers.parseUnits('30', 'gwei'),
      maxFeePerGas: ethers.parseUnits('35', 'gwei'),
      gasLimit: 300000
    });
    
    console.log(`[Relayer] Sent transaction: ${tx.hash}. Waiting for block confirmation...`);
    const receipt = await tx.wait();

    if (receipt.status === 0) {
      throw new Error("On-chain transaction reverted.");
    }
    console.log(`[Relayer] Transaction confirmed in block ${receipt.blockNumber}!`);

    return res.json({
      success: true,
      faceDescriptorHash,
      ipfsCid: ipfsResult.cid,
      txHash: tx.hash,
    });
  } catch (error) {
    console.error('[Relayer Error] Registration failed:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal Relayer Error' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { apiKey, userAddress, zkProof, publicSignals, is_mock } = req.body;

    // 1. Validate Developer API Key
    if (!apiKey || !apiKey.startsWith('pm_')) {
      return res.status(401).json({ success: false, error: 'Invalid or missing API Key.' });
    }

    if (!userAddress || !zkProof || !publicSignals) {
      return res.status(400).json({ success: false, error: 'Missing login verification parameters.' });
    }

    // 2. Query FaceRegistry contract to get registered face hash
    if (!contract) {
      return res.status(500).json({ success: false, error: 'Backend contract connection is not initialized.' });
    }
    const storedFaceHash = await contract.getUserFaceHash(userAddress);
    const zeroHash = '0x0000000000000000000000000000000000000000000000000000000000000000';
    if (storedFaceHash === zeroHash || storedFaceHash === '0x') {
      return res.status(404).json({ success: false, error: 'User is not registered.' });
    }

    // 3. Environment check for Mock Proofs
    const isProduction = process.env.NODE_ENV === 'production';
    if (is_mock) {
      if (isProduction) {
        return res.status(400).json({
          success: false,
          error: 'Critical Security Error: Mock ZK proof is rejected in production mode.'
        });
      }
      console.warn('[Relayer] Warning: Accepting mock ZK proof in development mode.');
      return res.json({ success: true, verified: true, is_mock: true });
    }

    // 4. Verify Real ZK-SNARK Proof off-chain using SnarkJS
    if (!vKey) {
      return res.status(500).json({
        success: false,
        error: 'Verification Key (vkey) is not loaded on the server. Cannot verify real ZK proofs.'
      });
    }

    // Verify publicSignals matching on-chain data
    // For real ZK proofs, publicSignals[0] is isMatch, and publicSignals[1...128] contains the reference vector.
    // Since Circom represents negative numbers in the BN254 finite field modulo P, we map them back to signed BigInts.
    try {
      const BN254_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      const halfPrime = BN254_PRIME / 2n;

      const publicSavedVector = publicSignals.slice(1, 129).map(x => {
        const val = BigInt(x);
        return val > halfPrime ? val - BN254_PRIME : val;
      });

      if (publicSavedVector.length !== 128) {
        return res.status(400).json({
          success: false,
          error: `ZK Proof public signals must contain 128 elements of reference vector, got ${publicSavedVector.length}`
        });
      }
      
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const encoded = abiCoder.encode(['int256[128]'], [publicSavedVector]);
      const calculatedHash = ethers.keccak256(encoded);

      if (calculatedHash.toLowerCase() !== storedFaceHash.toLowerCase()) {
        return res.status(400).json({
          success: false,
          error: 'ZK Proof public signals do not match registered on-chain face hash.'
        });
      }
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: `Failed to verify ZK Proof public signals vector format: ${e.message}`
      });
    }

    const verified = await snarkjs.groth16.verify(vKey, publicSignals, zkProof);
    if (!verified) {
      return res.status(401).json({ success: false, error: 'ZK proof verification failed.' });
    }

    return res.json({
      success: true,
      verified: true,
      is_mock: false,
    });
  } catch (error) {
    console.error('[Relayer Error] Login verification failed:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal Relayer Error' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[PramanVerifyServer] Reference server running on port ${PORT}`);
});

