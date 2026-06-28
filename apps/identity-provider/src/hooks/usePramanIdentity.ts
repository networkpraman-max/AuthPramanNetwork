import { useState, useEffect, useCallback, useRef } from 'react';
const faceapi = (window as any).faceapi;
import { ethers } from 'ethers';
import {
  initPraman,
  decryptPII,
  getManualAuthSig,
  fetchFromIPFS,
  DEFAULT_RELAYER_URL
} from '@praman/sdk';

// Initialize the PramanAuth SDK with Backend Relayer URL
const praman = initPraman({
  apiKey: "pm_dev_identity_provider",
  network: "polygon-amoy",
  backendUrl: DEFAULT_RELAYER_URL, // Centralized Relayer Backend API
});

export type ProgressStep =
  | 'idle'
  | 'connecting-wallet'
  | 'loading-models'
  | 'waiting-for-scan'
  | 'scanning-face'
  | 'generating-vector'
  | 'checking-duplicate'
  | 'encrypting-pii'
  | 'uploading-ipfs'
  | 'generating-zk-proof'
  | 'registering-on-chain'
  | 'redirecting'
  | 'success'
  | 'error';

interface PramanIdentityConfig {
  adminAddress?: string;
  onLog?: (message: string) => void;
}

export function usePramanIdentity(config?: PramanIdentityConfig) {
  const adminAddress = config?.adminAddress || '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  
  // Use stable ref to prevent infinite callback re-creations
  const onLogRef = useRef(config?.onLog);
  useEffect(() => {
    onLogRef.current = config?.onLog;
  }, [config?.onLog]);

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isModelLoaded, setIsModelLoaded] = useState<boolean>(false);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progressStep, setProgressStep] = useState<ProgressStep>('idle');
  const [ipfsCid, setIpfsCid] = useState<string | null>(null);
  const [zkProof, setZkProof] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  // Local logging helper with stable reference
  const addLog = useCallback((msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    const formattedMsg = `[${timestamp}] ${msg}`;
    setLogs((prev) => [...prev, formattedMsg]);
    if (onLogRef.current) {
      onLogRef.current(formattedMsg);
    }
  }, []);

  // Sync wallet address from SDK (loads local ephemeral wallet on mount)
  useEffect(() => {
    try {
      const activeWallet = (praman as any).getLocalEphemeralWallet();
      setWalletAddress(activeWallet.address);
      addLog(`Loaded local ephemeral gasless wallet: ${activeWallet.address}`);
    } catch (e) {
      console.warn("Failed to load local ephemeral wallet:", e);
    }
  }, [addLog]);

  // Connects the wallet using standard Ethers.js (if MetaMask is preferred)
  const connectWallet = useCallback(async () => {
    setError(null);
    setProgressStep('connecting-wallet');
    addLog('Requesting MetaMask wallet connection...');

    if (!(window as any).ethereum) {
      const err = 'No Web3 wallet found. Please install MetaMask or another browser wallet.';
      setError(err);
      setProgressStep('error');
      addLog(`Wallet connection error: ${err}`);
      return null;
    }

    try {
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      if (accounts.length === 0) {
        throw new Error('No accounts returned from wallet.');
      }
      
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      
      setWalletAddress(address);
      setProgressStep('idle');
      addLog(`MetaMask connected: ${address}`);
      return signer;
    } catch (err: any) {
      const errMsg = err.message || 'Failed to connect wallet';
      setError(errMsg);
      setProgressStep('error');
      addLog(`Wallet connection error: ${errMsg}`);
      return null;
    }
  }, [addLog]);

  // Loads face-api.js models from public folder with a fallback to jsDelivr CDN
  const loadModels = useCallback(async () => {
    if (isModelLoaded) return;
    setError(null);
    setProgressStep('loading-models');
    addLog('Loading face detection & landmark models...');

    const localModelUrl = '/models';
    const cdnModelUrl = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';

    try {
      await faceapi.nets.ssdMobilenetv1.loadFromUri(localModelUrl);
      await faceapi.nets.faceLandmark68Net.loadFromUri(localModelUrl);
      await faceapi.nets.faceRecognitionNet.loadFromUri(localModelUrl);
      
      setIsModelLoaded(true);
      setProgressStep('idle');
      addLog('Face models loaded successfully from local storage.');
    } catch (localError) {
      addLog('Local models not found or failed to load. Fetching from jsDelivr CDN fallback...');
      try {
        await faceapi.nets.ssdMobilenetv1.loadFromUri(cdnModelUrl);
        await faceapi.nets.faceLandmark68Net.loadFromUri(cdnModelUrl);
        await faceapi.nets.faceRecognitionNet.loadFromUri(cdnModelUrl);
        
        setIsModelLoaded(true);
        setProgressStep('idle');
        addLog('Face models loaded successfully from CDN fallback.');
      } catch (cdnError: any) {
        const errMsg = `Failed to load face-api models: ${cdnError.message || cdnError}`;
        setError(errMsg);
        setProgressStep('error');
        addLog(`Model loading error: ${errMsg}`);
      }
    }
  }, [isModelLoaded, addLog]);

  // Registration Mode: Delegates tasks completely to Praman SDK
  const scanAndRegister = useCallback(async (
    piiData: { name: string; email: string; mobile: string },
    webcamScreenshot: string | null
  ) => {
    setError(null);
    setIsProcessing(true);

    if (!isModelLoaded) {
      const err = 'Face models are not loaded yet.';
      setError(err);
      setIsProcessing(false);
      setProgressStep('error');
      addLog(`Error: ${err}`);
      return null;
    }

    if (!webcamScreenshot) {
      const err = 'Failed to capture frame from Webcam.';
      setError(err);
      setIsProcessing(false);
      setProgressStep('error');
      addLog(`Error: ${err}`);
      return null;
    }

    let signer: any = null;
    // Check if standard browser wallet is connected, else fallback to ephemeral wallet in SDK
    if (walletAddress && (window as any).ethereum) {
      try {
        const provider = new ethers.BrowserProvider((window as any).ethereum);
        signer = await provider.getSigner();
      } catch (e) {}
    }

    try {
      addLog('Starting gasless registration flow via Relayer...');
      const result = await praman.register(
        webcamScreenshot,
        piiData,
        signer,
        faceapi,
        (progress) => {
          setProgressStep(progress.step as ProgressStep);
          addLog(progress.message);
        }
      );

      if (!result.success) {
        throw new Error(result.error);
      }

      setIpfsCid(result.ipfsCid || null);
      setProgressStep('success');
      setIsProcessing(false);
      addLog('Gasless registration completed successfully!');

      return {
        ipfsCid: result.ipfsCid,
        faceDescriptorHash: result.faceDescriptorHash,
      };
    } catch (err: any) {
      const errMsg = err.message || 'Registration flow failed';
      setError(errMsg);
      setProgressStep('error');
      setIsProcessing(false);
      addLog(`Registration execution error: ${errMsg}`);
      return null;
    }
  }, [isModelLoaded, walletAddress, addLog]);

  // Login Mode: Delegates task completely to Praman SDK
  const verifyAndLogin = useCallback(async (
    webcamScreenshot: string | null
  ) => {
    setError(null);
    setIsProcessing(true);

    if (!isModelLoaded) {
      const err = 'Face models are not loaded yet.';
      setError(err);
      setIsProcessing(false);
      setProgressStep('error');
      addLog(`Error: ${err}`);
      return null;
    }

    if (!webcamScreenshot) {
      const err = 'Failed to capture frame from Webcam.';
      setError(err);
      setIsProcessing(false);
      setProgressStep('error');
      addLog(`Error: ${err}`);
      return null;
    }

    let signer: any = null;
    if (walletAddress && (window as any).ethereum) {
      try {
        const provider = new ethers.BrowserProvider((window as any).ethereum);
        signer = await provider.getSigner();
      } catch (e) {}
    }

    try {
      addLog('Starting verification and ZK proof validation...');
      const result = await praman.login(
        webcamScreenshot,
        signer,
        faceapi,
        (progress) => {
          setProgressStep(progress.step as ProgressStep);
          addLog(progress.message);
        }
      );

      if (!result.success) {
        throw new Error(result.error);
      }

      setZkProof(result.proof);
      setIpfsCid(result.ipfsCid || null);
      setProgressStep('success');
      setIsProcessing(false);
      addLog(`Verification complete! Session token: ${result.jwt.slice(0, 15)}...`);

      return {
        ipfsCid: result.ipfsCid,
        zkProof: result.proof,
        faceDescriptorHash: result.faceDescriptorHash,
      };
    } catch (err: any) {
      const errMsg = err.message || 'Login flow failed';
      setError(errMsg);
      setProgressStep('error');
      setIsProcessing(false);
      addLog(`Verification execution error: ${errMsg}`);
      return null;
    }
  }, [isModelLoaded, walletAddress, addLog]);

  // Utility to decrypt and retrieve user PII (for self-verification)
  const testDecryption = useCallback(async (
    ipfsCid: string
  ) => {
    let activeSigner: any = null;
    if (walletAddress && (window as any).ethereum) {
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      activeSigner = await provider.getSigner();
    } else {
      activeSigner = (praman as any).getLocalEphemeralWallet();
    }
    
    addLog('Fetching encrypted payload from IPFS...');
    const payload = await fetchFromIPFS(ipfsCid);

    addLog('Starting test decryption flow...');
    try {
      const authSig = await getManualAuthSig(activeSigner);
      
      const decrypted = await decryptPII(
        payload.ciphertext,
        payload.dataToEncryptHash,
        activeSigner.address,
        adminAddress,
        authSig
      );
      
      addLog('Test decryption successful!');
      return decrypted;
    } catch (err: any) {
      const errMsg = err.message || 'Decryption failed';
      addLog(`Test decryption error: ${errMsg}`);
      throw err;
    }
  }, [walletAddress, adminAddress, addLog]);

  // Load models on mount automatically
  useEffect(() => {
    loadModels();
  }, [loadModels]);

  return {
    walletAddress,
    isModelLoaded,
    isScanning,
    isProcessing,
    progressStep,
    ipfsCid,
    zkProof,
    error,
    logs,
    connectWallet,
    scanAndRegister,
    verifyAndLogin,
    setIsScanning,
    testDecryption,
    addLog,
  };
}
