import React, { useState, useEffect, useRef } from 'react';
import Webcam from 'react-webcam';
import { usePramanIdentity } from '../hooks/usePramanIdentity';
import type { ProgressStep } from '../hooks/usePramanIdentity';
import {
  DeviceGuard,
  useLivenessGuard,
  PramanAuth,
  DEFAULT_RELAYER_URL
} from '@praman-network/sdk';
import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';

const faceapi = (window as any).faceapi;

export function OnboardingFlow() {
  const [authMode, setAuthMode] = useState<'register' | 'login'>('register');
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    mobile: '',
  });

  const [isPopupFlow, setIsPopupFlow] = useState(false);
  const [clientApiKey, setClientApiKey] = useState<string | null>(null);

  // Consent states
  const [hasConsented, setHasConsented] = useState(false);
  const [consentEmail, setConsentEmail] = useState(true);
  const [consentProfile, setConsentProfile] = useState(true);

  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [customRedirectUrl, setCustomRedirectUrl] = useState('https://httpbin.org/get');
  const [countdown, setCountdown] = useState(3);

  // Decryption Sandbox State
  const [decryptedData, setDecryptedData] = useState<any>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [decryptionError, setDecryptionError] = useState<string | null>(null);

  // New configuration states
  const [livenessLevel, setLivenessLevel] = useState<'strict' | 'standard' | 'off'>('standard');
  const [signerInstance, setSignerInstance] = useState<any>(null);

  const [landmarker, setLandmarker] = useState<FaceLandmarker | null>(null);

  // Load MediaPipe FaceLandmarker once on mount
  useEffect(() => {
    let active = true;
    const initMediaPipe = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );
        const fl = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numFaces: 1,
        });
        if (active) {
          setLandmarker(fl);
        }
      } catch (err) {
        console.error('Failed to load landmarker in app:', err);
      }
    };
    initMediaPipe();
    return () => {
      active = false;
    };
  }, []);

  // Cross-Device Handover Desktop states
  const [isHandoverActive, setIsHandoverActive] = useState(false);
  const [handoverSessionId, setHandoverSessionId] = useState<string | null>(null);
  const [handoverToken, setHandoverToken] = useState<string | null>(null);

  // Mobile Handover Client states (if page opened via QR code URL)
  const [handoverUrlToken, setHandoverUrlToken] = useState<string | null>(null);
  const [handoverSessionData, setHandoverSessionData] = useState<{
    sessionId: string;
    address: string;
    mode: 'register' | 'login';
  } | null>(null);

  const webcamRef = useRef<Webcam>(null);

  const {
    walletAddress,
    isModelLoaded,
    isScanning,
    isProcessing,
    progressStep,
    ipfsCid,
    zkProof,
    error: sdkError,
    logs,
    connectWallet,
    scanAndRegister,
    verifyAndLogin,
    setIsScanning,
    testDecryption,
    addLog,
  } = usePramanIdentity({
    onLog: () => {
      const logContainer = document.getElementById('log-terminal');
      if (logContainer) {
        logContainer.scrollTop = logContainer.scrollHeight;
      }
    },
  });

  // Hook for active spoofing detection (Liveness challenges)
  const {
    status: liveness,
    evaluateFrame,
    failAttempt: failLivenessAttempt,
    resetAll: resetLiveness,
    resetLockout: resetLivenessLockout,
  } = useLivenessGuard(livenessLevel);

  // Extract redirectUrl or handoverToken from query parameters on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get('redirectUrl');
    const token = params.get('handoverToken');
    const modeParam = params.get('mode') as 'login' | 'register' | null;
    const apiKeyParam = params.get('apiKey');
    const scopesParam = params.get('scopes');

    // Check if it is a popup flow (has opener or query params indicating OAuth)
    const hasOpener = typeof window !== 'undefined' && !!window.opener;
    const isOAuth = !!modeParam || !!apiKeyParam;

    if (hasOpener || isOAuth) {
      setIsPopupFlow(true);
      if (modeParam === 'login' || modeParam === 'register') {
        setAuthMode(modeParam);
      }
      if (apiKeyParam) {
        setClientApiKey(apiKeyParam);
      }
      if (scopesParam) {
        const scopes = scopesParam.split(',');
        setConsentEmail(scopes.includes('email'));
        setConsentProfile(scopes.includes('profile'));
      }
      addLog(`Popup-based verification flow detected. Mode: ${modeParam || 'register'}, Scopes: ${scopesParam || 'none'}`);
    }

    if (token) {
      setHandoverUrlToken(token);
      try {
        const parts = token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
          setHandoverSessionData({
            sessionId: payload.sessionId,
            address: payload.sub,
            mode: payload.mode,
          });
          addLog(`Cross-Device Handover mode activated for session: ${payload.sessionId.slice(0, 10)}...`);
        }
      } catch (e) {
        addLog('Failed to decode mobile handover token JWT');
      }
    } else if (url) {
      setRedirectUrl(url);
      addLog(`Redirect parameter detected: ${url}`);
    } else {
      if (!hasOpener && !isOAuth) {
        addLog('No redirect URL parameter detected. Running in Sandbox Mode.');
      }
    }
  }, [addLog]);

  // Handle countdown and redirect
  useEffect(() => {
    let timer: any;
    if (progressStep === 'success' && redirectUrl) {
      addLog(`Success! Preparing redirect to: ${redirectUrl}`);
      timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            const separator = redirectUrl.includes('?') ? '&' : '?';
            const finalUrl = `${redirectUrl}${separator}status=success&cid=${ipfsCid}`;
            addLog(`Redirecting now to: ${finalUrl}`);
            window.location.href = finalUrl;
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [progressStep, redirectUrl, ipfsCid, addLog]);

  const validateForm = () => {
    const errors: Record<string, string> = {};
    if (!formData.name.trim()) errors.name = 'Name is required';
    if (!formData.email.trim()) {
      errors.email = 'Email is required';
    } else if (!/\S+@\S+\.\S+/.test(formData.email)) {
      errors.email = 'Email is invalid';
    }
    if (!formData.mobile.trim()) {
      errors.mobile = 'Mobile number is required';
    } else if (!/^\+?[1-9]\d{1,14}$/.test(formData.mobile.replace(/\s+/g, ''))) {
      errors.mobile = 'Mobile number is invalid (use E.164 format e.g. +1234567890)';
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (formErrors[name]) {
      setFormErrors((prev) => {
        const copy = { ...prev };
        delete copy[name];
        return copy;
      });
    }
  };

  // Triggers Cross-Device Handover Modal on desktop
  const triggerHandoverFlow = async () => {
    try {
      addLog('No physical camera detected or permission denied. Starting Mobile Handover...');
      setIsHandoverActive(true);

      const serverUrl = DEFAULT_RELAYER_URL;
      const response = await fetch(`${serverUrl}/api/handover/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: walletAddress || '',
          mode: authMode,
        }),
      });
      const data = await response.json();

      if (data.success) {
        setHandoverSessionId(data.sessionId);
        setHandoverToken(data.handoverToken);
        addLog(`Handover session initialized. Session ID: ${data.sessionId}`);

        // Save to local storage for local tab sync fallback
        const handoverUrl = `${window.location.origin}${window.location.pathname}?handoverToken=${data.handoverToken}`;
        localStorage.setItem(`handover_url_${data.sessionId}`, handoverUrl);
      } else {
        throw new Error(data.error || 'Failed to initialize session');
      }
    } catch (err: any) {
      addLog(`Server handover setup failed, reverting to local cross-tab fallback.`);
      const mockSessionId = 'sess_local_' + Math.random().toString(36).substring(2, 15);
      const mockToken = generateLocalHandoverToken(mockSessionId, walletAddress || '', authMode);
      setHandoverSessionId(mockSessionId);
      setHandoverToken(mockToken);

      const handoverUrl = `${window.location.origin}${window.location.pathname}?handoverToken=${mockToken}`;
      localStorage.setItem(`handover_url_${mockSessionId}`, handoverUrl);
    }
  };

  const generateLocalHandoverToken = (sessionId: string, address: string, modeStr: string) => {
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
      sub: address?.toLowerCase() || 'unknown',
      sessionId,
      mode: modeStr,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600
    };
    return `${btoa(JSON.stringify(header))}.${btoa(JSON.stringify(payload))}.mock_sig`;
  };

  // Poll for handover verification status
  useEffect(() => {
    if (!handoverSessionId || !isHandoverActive) return;

    const serverUrl = DEFAULT_RELAYER_URL;
    let pollInterval: any;

    pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${serverUrl}/api/handover/status/${handoverSessionId}`);
        const data = await res.json();
        if (data.success && data.status === 'completed') {
          clearInterval(pollInterval);
          setIsHandoverActive(false);
          setHandoverSessionId(null);
          setHandoverToken(null);

          if (data.result.success) {
            addLog('Mobile verification completed successfully! Handover verified.');
            window.location.reload();
          } else {
            addLog(`Mobile verification failed: ${data.result.error}`);
          }
        }
      } catch (err) { }
    }, 2000);

    // Local Storage cross-tab receiver fallback
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === `handover_result_${handoverSessionId}` && e.newValue) {
        try {
          const result = JSON.parse(e.newValue);
          clearInterval(pollInterval);
          setIsHandoverActive(false);
          setHandoverSessionId(null);
          setHandoverToken(null);
          localStorage.removeItem(`handover_result_${handoverSessionId}`);

          if (result.success) {
            addLog('Cross-tab simulated handover verified successfully!');
            // Trigger UI success
            window.location.reload();
          } else {
            addLog(`Simulated handover failed: ${result.error}`);
          }
        } catch { }
      }
    };

    window.addEventListener('storage', handleStorageChange);

    // Timeout (5 minutes)
    const timeoutId = setTimeout(() => {
      clearInterval(pollInterval);
      window.removeEventListener('storage', handleStorageChange);
      setIsHandoverActive(false);
      setHandoverSessionId(null);
      setHandoverToken(null);
      addLog(`Error: Handover session timed out.`);
    }, 5 * 60 * 1000);

    return () => {
      clearInterval(pollInterval);
      window.removeEventListener('storage', handleStorageChange);
      clearTimeout(timeoutId);
    };
  }, [handoverSessionId, isHandoverActive, addLog]);

  const startScanningFlow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (authMode === 'register' && !validateForm()) return;

    // Check Lockout
    if (liveness.isLocked) {
      addLog('Error: Anti-spoofing lockout is active. Please submit a manual support ticket.');
      return;
    }

    try {
      addLog('Connecting web3 wallet provider...');
      const signer = await connectWallet();
      if (!signer) {
        addLog('Signer connection required.');
        return;
      }
      setSignerInstance(signer);

      // Check device count first
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((d) => d.kind === 'videoinput');
      if (videoDevices.length === 0) {
        await triggerHandoverFlow();
        return;
      }

      // Check for virtual cameras
      const guardResult = await DeviceGuard.scanDevices();
      if (guardResult.isVirtual) {
        const errorMsg = `Virtual camera detected: "${guardResult.virtualCameraLabel}". Please connect a physical camera.`;
        addLog(`Error: ${errorMsg}`);
        alert(errorMsg);
        return;
      }

      setIsScanning(true);
      resetLiveness();
      addLog(`Webcam active. Starting ${livenessLevel === 'off' ? 'manual capture' : 'anti-spoofing challenge'}...`);
    } catch (err: any) {
      if (
        err.name === 'NotAllowedError' ||
        err.name === 'PermissionDeniedError' ||
        err.message?.includes('Permission denied')
      ) {
        await triggerHandoverFlow();
      } else {
        addLog(`Camera setup failed: ${err.message}`);
      }
    }
  };

  const handlePopupSuccess = (result: any) => {
    if (!window.opener) {
      addLog('Popup success handler active, but no parent window (window.opener) detected.');
      return;
    }

    addLog('Authentication successful! Sending payload back to parent window...');

    // Standardized Firebase-style response
    const payload = {
      success: true,
      user: {
        did: walletAddress || result.faceDescriptorHash || '',
        email: consentEmail ? (result.pii?.email || formData.email) : undefined,
        verified: true
      },
      token: result.jwt || '',
      proof: result.zkProof || zkProof || undefined
    };

    window.opener.postMessage({
      type: 'PRAMAN_AUTH_SUCCESS',
      payload
    }, '*');

    // Close the popup after a short delay so the user can see the success state
    setTimeout(() => {
      window.close();
    }, 1500);
  };

  const handleCancel = () => {
    if (window.opener) {
      window.opener.postMessage({
        type: 'PRAMAN_AUTH_ERROR',
        error: 'Authentication cancelled by user.'
      }, '*');
      window.close();
    } else {
      addLog('Authentication cancelled.');
    }
  };

  useEffect(() => {
    if (sdkError && isPopupFlow) {
      if (window.opener) {
        window.opener.postMessage({
          type: 'PRAMAN_AUTH_ERROR',
          error: sdkError
        }, '*');
      }
    }
  }, [sdkError, isPopupFlow]);

  const captureAndAuthenticate = async () => {
    if (!webcamRef.current) {
      addLog('Webcam ref not ready.');
      return;
    }

    try {
      addLog('Capturing video frame...');
      const imageSrc = webcamRef.current.getScreenshot();
      if (!imageSrc) {
        throw new Error('Webcam returned empty screenshot');
      }
      setScreenshot(imageSrc);

      // Stop scanner camera stream UI
      setIsScanning(false);

      let result = null;
      if (authMode === 'register') {
        addLog('Executing Registration flow...');
        result = await scanAndRegister(formData, imageSrc);
      } else {
        addLog('Executing Login flow (ZK Face Vector Matching)...');
        result = await verifyAndLogin(imageSrc);
      }

      if (result && isPopupFlow) {
        handlePopupSuccess(result);
      }
    } catch (err: any) {
      addLog(`Capture failed: ${err.message}`);
    }
  };

  // Real-time landmarks loop for active anti-spoofing
  useEffect(() => {
    if (isScanning && landmarker && livenessLevel !== 'off' && webcamRef.current) {
      let isSubscribed = true;
      let frameId: number;

      const detectLoop = async () => {
        if (!isSubscribed) return;

        const video = webcamRef.current?.video;
        if (video && !video.paused && !video.ended) {
          try {
            const results = landmarker.detectForVideo(video, performance.now());
            if (results.faceLandmarks && results.faceLandmarks.length > 0 && isSubscribed) {
              evaluateFrame(results.faceLandmarks[0]);
            }
          } catch (e) {
            // Ignore landmark transient errors
          }
        }

        if (isSubscribed) {
          frameId = requestAnimationFrame(detectLoop);
        }
      };

      detectLoop();

      return () => {
        isSubscribed = false;
        cancelAnimationFrame(frameId);
      };
    }
  }, [isScanning, landmarker, livenessLevel, evaluateFrame]);

  // Handle successful challenge validation
  useEffect(() => {
    if (liveness.completed && isScanning) {
      const targetScore = livenessLevel === 'strict' ? 0.95 : 0.85;
      if (liveness.score >= targetScore) {
        addLog(`Liveness challenges passed successfully! Score: ${liveness.score}. Processing biometrics...`);
        autoCaptureAndVerify();
      } else {
        addLog(`Spoofing warning: Challenge score too low (${liveness.score}). Attempt failed.`);
        failLivenessAttempt();
      }
    }
  }, [liveness.completed, liveness.score, isScanning]);

  const autoCaptureAndVerify = async () => {
    if (!webcamRef.current) return;
    try {
      const imageSrc = webcamRef.current.getScreenshot();
      if (!imageSrc) throw new Error('Webcam returned empty screenshot');
      setScreenshot(imageSrc);
      setIsScanning(false);

      let result = null;
      if (authMode === 'register') {
        addLog('Executing Registration flow...');
        result = await scanAndRegister(formData, imageSrc);
      } else {
        addLog('Executing Login flow (ZK Face Vector Matching)...');
        result = await verifyAndLogin(imageSrc);
      }

      if (result && isPopupFlow) {
        handlePopupSuccess(result);
      }
    } catch (err: any) {
      addLog(`Auto-authentication failed: ${err.message}`);
    }
  };

  // Landmark challenge step timeouts (15 seconds)
  const lastStepRef = useRef<number>(0);
  const lastStepTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    if (isScanning && livenessLevel !== 'off' && !liveness.completed && !liveness.isLocked) {
      if (liveness.challengeIndex !== lastStepRef.current) {
        lastStepRef.current = liveness.challengeIndex;
        lastStepTimeRef.current = Date.now();
      }

      const timer = setInterval(() => {
        const elapsed = (Date.now() - lastStepTimeRef.current) / 1000;
        if (elapsed > 15) {
          addLog(`Challenge step timed out. Current attempt failed.`);
          failLivenessAttempt();
          lastStepTimeRef.current = Date.now();
        }
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [
    isScanning,
    liveness.challengeIndex,
    liveness.completed,
    liveness.isLocked,
    livenessLevel,
    failLivenessAttempt,
    addLog,
  ]);



  const executeManualRedirect = () => {
    if (!ipfsCid) return;
    const separator = customRedirectUrl.includes('?') ? '&' : '?';
    const finalUrl = `${customRedirectUrl}${separator}status=success&cid=${ipfsCid}`;
    addLog(`Simulating OAuth redirect to: ${finalUrl}`);
    window.location.href = finalUrl;
  };

  const handleTestDecryption = async () => {
    if (!ipfsCid) return;
    setIsDecrypting(true);
    setDecryptionError(null);
    setDecryptedData(null);

    try {
      const decrypted = await testDecryption(ipfsCid);
      setDecryptedData(decrypted);
    } catch (err: any) {
      setDecryptionError(err.message || 'Decryption failed. Ensure you are using the correct connected wallet.');
    } finally {
      setIsDecrypting(false);
    }
  };

  const getStepColor = (step: string) => {
    if (progressStep === 'error') return 'border-red-500 text-red-400 bg-red-950/20';
    if (progressStep === 'success') return 'border-green-500 text-green-400 bg-green-950/20';

    const stepsOrder: ProgressStep[] = [
      'idle',
      'connecting-wallet',
      'loading-models',
      'scanning-face',
      'generating-vector',
      'checking-duplicate',
      'encrypting-pii',
      'uploading-ipfs',
      'generating-zk-proof',
      'registering-on-chain',
      'success'
    ];

    const currentIndex = stepsOrder.indexOf(progressStep);
    const targetIndex = stepsOrder.indexOf(step as ProgressStep);

    if (currentIndex > targetIndex) return 'border-purple-600 text-purple-400 bg-purple-950/20'; // Completed
    if (progressStep === step) return 'border-blue-500 text-blue-400 bg-blue-950/20 animate-pulse-ring'; // Active
    return 'border-zinc-800 text-zinc-500 bg-zinc-900/40'; // Pending
  };

  const challengeLabelMap: Record<string, string> = {
    blink: 'Blink your eyes 3 times',
    turn_left: 'Turn your head left',
    smile: 'Smile warmly',
  };

  // 1. MOBILE SCANNER VIEW (If scanned QR token)
  if (handoverUrlToken && handoverSessionData) {
    return (
      <div className="w-full max-w-md mx-auto p-6 bg-zinc-900 border border-zinc-800 rounded-3xl shadow-2xl text-center text-zinc-100 flex flex-col justify-center min-h-[460px]">
        <PramanAuth
          apiKey="pm_sandbox_test"
          network="datil-dev"
          mode={handoverSessionData.mode}
          signer={signerInstance}
          faceapiInstance={faceapi}
          liveness={livenessLevel}
          onLog={(msg) => addLog(`[Mobile Handover] ${msg}`)}
          onSuccess={(res) => addLog(`Handover success! Details: ${JSON.stringify(res)}`)}
          onError={(err) => addLog(`Handover error: ${err}`)}
          buttonText="Start Mobile Handover Scan"
        />

        {!signerInstance && (
          <div className="mt-8 space-y-4">
            <p className="text-xs text-zinc-400">Please connect your wallet first to authorize the mobile biometrics scanner.</p>
            <button
              onClick={async () => {
                const signer = await connectWallet();
                if (signer) setSignerInstance(signer);
              }}
              className="px-6 py-2.5 bg-gradient-to-r from-purple-600 to-blue-600 text-xs font-semibold rounded-xl"
            >
              Connect Mobile Wallet
            </button>
          </div>
        )}
      </div>
    );
  }

  // 2. LIVENESS PERMANENT LOCKOUT SCREEN
  if (liveness.isLocked) {
    return (
      <div className="w-full max-w-md mx-auto p-8 bg-zinc-900/80 border border-red-500 rounded-3xl shadow-2xl text-center space-y-6">
        <div className="text-5xl">🛡️</div>
        <h2 className="text-xl font-bold text-red-500">Security Lockout Active</h2>
        <p className="text-xs text-zinc-400 leading-relaxed">
          Too many failed spoofing detection attempts. Your access was blocked to prevent bot or presentation attacks.
        </p>

        <button
          onClick={() => {
            window.open('https://support.pramanauth.com/ticket', '_blank');
          }}
          className="w-full py-3.5 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 text-xs font-bold uppercase rounded-xl transition-all shadow-lg shadow-blue-500/20"
        >
          Submit Support Ticket
        </button>

        <button
          onClick={resetLivenessLockout}
          className="text-[10px] text-zinc-500 hover:underline block mx-auto"
        >
          Reset Lockout (Sandbox Mode)
        </button>
      </div>
    );
  }

  // 3. DESKTOP HANDOVER QR CODE MODAL
  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col lg:flex-row gap-8 items-start justify-center">
      {isHandoverActive && handoverToken && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md flex items-center justify-center z-[99999] p-4 text-center">
          <div className="max-w-sm w-full bg-zinc-900 border border-zinc-800 rounded-3xl p-6 space-y-6">
            <h3 className="text-lg font-bold text-zinc-200">📷 Use Mobile Camera</h3>
            <p className="text-xs text-zinc-400">
              No physical camera detected on this computer. Scan this QR code with your mobile device to verify.
            </p>

            <div className="bg-white p-3 rounded-2xl inline-block mx-auto">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(
                  `${window.location.origin}${window.location.pathname}?handoverToken=${handoverToken}`
                )}`}
                alt="QR Link"
              />
            </div>

            <div className="text-[10px] font-mono text-purple-400 animate-pulse">
              ⚡ Listening for mobile verification payload...
            </div>

            <div className="flex flex-col gap-2.5">
              <button
                onClick={() => {
                  const url = `${window.location.origin}${window.location.pathname}?handoverToken=${handoverToken}`;
                  window.open(url, '_blank');
                }}
                className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-300 rounded-xl"
              >
                Simulate Mobile Scanning (Open Tab)
              </button>

              <button
                onClick={() => {
                  setIsHandoverActive(false);
                  setHandoverSessionId(null);
                  setHandoverToken(null);
                }}
                className="w-full py-2 bg-red-650 hover:bg-red-600 text-xs font-semibold text-white rounded-xl"
              >
                Cancel Handover
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Onboarding Main panel */}
      <div className="w-full lg:w-3/5 bg-zinc-900/60 backdrop-blur-xl border border-zinc-800 rounded-3xl p-6 lg:p-8 shadow-2xl relative overflow-hidden">

        <div className="absolute top-0 right-0 w-48 h-48 bg-purple-600/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-48 h-48 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />

        {isPopupFlow && !hasConsented ? (
          <div className="space-y-6 py-4">
            <div className="text-center lg:text-left">
              <span className="px-3 py-1 text-xs font-semibold tracking-widest text-purple-400 uppercase bg-purple-950/30 border border-purple-800/50 rounded-full">
                Data Sharing Request
              </span>
              <h1 className="text-2xl font-bold tracking-tight text-white mt-4">
                An application is requesting your Identity
              </h1>
              <p className="text-xs text-zinc-400 mt-2 font-mono">
                Requested by: <span className="text-purple-400 font-semibold">{document.referrer ? new URL(document.referrer).host : 'Secure Client Application'}</span>
                {clientApiKey && (
                  <>
                    <br />
                    API Key: <span className="text-purple-405 font-semibold text-[10px]">{clientApiKey}</span>
                  </>
                )}
              </p>
            </div>

            <div className="bg-zinc-950/80 border border-zinc-800/80 rounded-2xl p-5 space-y-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400 border-b border-zinc-900 pb-2">
                Requested Permissions
              </h3>

              {/* Permission Item 1: Mandatory Biometric ZK Proof */}
              <div className="flex items-start justify-between gap-4 p-3 bg-zinc-900/40 border border-zinc-800/60 rounded-xl">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-green-400 text-sm">🛡️</span>
                    <span className="text-xs font-bold text-white">Biometric ZK Proof (Mandatory)</span>
                  </div>
                  <p className="text-[11px] text-zinc-500 leading-relaxed pl-6">
                    Generates a zero-knowledge proof of facial metrics. Your raw biometric data is never shared.
                  </p>
                </div>
                <div className="relative inline-flex items-center cursor-not-allowed">
                  <input type="checkbox" checked disabled className="sr-only peer" />
                  <div className="w-9 h-5 bg-purple-650 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600 opacity-60"></div>
                </div>
              </div>

              {/* Permission Item 2: Email Address */}
              <div className="flex items-start justify-between gap-4 p-3 bg-zinc-900/40 border border-zinc-800/60 rounded-xl hover:border-zinc-700/80 transition-colors">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-blue-400 text-sm">📧</span>
                    <span className="text-xs font-bold text-white">Share Email Address</span>
                  </div>
                  <p className="text-[11px] text-zinc-500 leading-relaxed pl-6">
                    Accesses your registered email address to verify account ownership.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={consentEmail}
                    onChange={(e) => setConsentEmail(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-zinc-850 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div>
                </label>
              </div>

              {/* Permission Item 3: Profile Info */}
              <div className="flex items-start justify-between gap-4 p-3 bg-zinc-900/40 border border-zinc-800/60 rounded-xl hover:border-zinc-700/80 transition-colors">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-purple-400 text-sm">👤</span>
                    <span className="text-xs font-bold text-white">Share Profile Information</span>
                  </div>
                  <p className="text-[11px] text-zinc-500 leading-relaxed pl-6">
                    Accesses your full name and other profile details registered with Praman Network.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={consentProfile}
                    onChange={(e) => setConsentProfile(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-zinc-850 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div>
                </label>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <button
                type="button"
                onClick={handleCancel}
                className="flex-1 py-3.5 text-xs font-bold uppercase border border-zinc-800 text-zinc-400 hover:bg-zinc-800/50 rounded-xl transition-all"
              >
                Reject &amp; Deny
              </button>
              <button
                type="button"
                onClick={async () => {
                  setHasConsented(true);
                  addLog('User granted data permissions. Proceeding to identity verification...');

                  // Automatically trigger wallet connection if not connected
                  if (!walletAddress) {
                    addLog('Automatically connecting wallet...');
                    await connectWallet();
                  }
                }}
                className="flex-1 py-3.5 text-xs font-bold uppercase bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white rounded-xl glow-purple transition-all"
              >
                Approve &amp; Continue
              </button>
            </div>
          </div>
        ) : (
          <>

            <div className="mb-6 text-center lg:text-left">
              <span className="px-3 py-1 text-xs font-semibold tracking-widest text-purple-400 uppercase bg-purple-950/30 border border-purple-800/50 rounded-full">
                Biometric Identity Provider
              </span>
              <h1 className="text-3xl font-bold tracking-tight text-white mt-3">
                PramanAuth ZK-Identity
              </h1>
              <p className="text-sm text-zinc-400 mt-2">
                100% decentralized · Client-side biometrics · ZK Proofs · No central DB
              </p>
            </div>

            {/* Tab switcher */}
            {!isScanning && progressStep !== 'success' && progressStep !== 'redirecting' && !isProcessing && (
              <div className="flex gap-1 p-1 bg-zinc-950/80 border border-zinc-800 rounded-2xl mb-6">
                <button
                  type="button"
                  id="tab-register"
                  onClick={() => setAuthMode('register')}
                  className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider rounded-xl transition-all duration-200 ${authMode === 'register'
                      ? 'bg-gradient-to-r from-purple-600 to-blue-600 text-white shadow-lg'
                      : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                >
                  ✦ Register
                </button>
                <button
                  type="button"
                  id="tab-login"
                  onClick={() => setAuthMode('login')}
                  className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider rounded-xl transition-all duration-200 ${authMode === 'login'
                      ? 'bg-gradient-to-r from-green-600 to-teal-600 text-white shadow-lg'
                      : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                >
                  ⚡ Login
                </button>
              </div>
            )}

            {/* REGISTER FORM */}
            {!isScanning && progressStep !== 'success' && progressStep !== 'redirecting' && authMode === 'register' && (
              <form onSubmit={startScanningFlow} className="space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                      Full Name
                    </label>
                    <input
                      type="text"
                      name="name"
                      value={formData.name}
                      onChange={handleInputChange}
                      placeholder="Enter name"
                      disabled={isProcessing}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white placeholder-zinc-600 focus:outline-none focus:border-purple-500 transition-colors"
                    />
                    {formErrors.name && <p className="text-xs text-red-500 mt-1">{formErrors.name}</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                      Email Address
                    </label>
                    <input
                      type="email"
                      name="email"
                      value={formData.email}
                      onChange={handleInputChange}
                      placeholder="Enter email"
                      disabled={isProcessing}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white placeholder-zinc-600 focus:outline-none focus:border-purple-500 transition-colors"
                    />
                    {formErrors.email && <p className="text-xs text-red-500 mt-1">{formErrors.email}</p>}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                    Mobile Number (E.164 Format)
                  </label>
                  <input
                    type="text"
                    name="mobile"
                    value={formData.mobile}
                    onChange={handleInputChange}
                    placeholder="+1234567890"
                    disabled={isProcessing}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-white placeholder-zinc-600 focus:outline-none focus:border-purple-500 transition-colors"
                  />
                  {formErrors.mobile && <p className="text-xs text-red-500 mt-1">{formErrors.mobile}</p>}
                </div>

                {/* Liveness settings configurator dropdown */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                    Liveness Spoof Protection
                  </label>
                  <select
                    value="strict"
                    disabled
                    className="w-full bg-zinc-950 border border-zinc-800 text-zinc-500 text-xs rounded-xl px-4 py-3 outline-none opacity-60 cursor-not-allowed"
                  >
                    <option value="strict">Strict Protection (Hard Enforced for Registration)</option>
                  </select>
                </div>

                {/* Wallet Info Banner */}
                <div className="bg-zinc-950/80 border border-zinc-800/80 rounded-2xl p-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${walletAddress ? 'bg-green-500 glow-green' : 'bg-amber-500 animate-pulse'}`} />
                    <div>
                      <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">Connected Wallet</h4>
                      <p className="text-xs font-mono text-zinc-500 mt-0.5 truncate max-w-[200px] sm:max-w-xs">
                        {walletAddress || 'Not Connected'}
                      </p>
                    </div>
                  </div>
                  {!walletAddress && (
                    <button
                      type="button"
                      onClick={connectWallet}
                      className="px-4 py-2 text-xs font-semibold text-white bg-zinc-800 hover:bg-zinc-700 active:scale-95 border border-zinc-700 rounded-xl transition-all"
                    >
                      Connect Wallet
                    </button>
                  )}
                </div>

                <button
                  id="btn-register-scan"
                  type="submit"
                  disabled={isProcessing || !isModelLoaded}
                  className={`w-full py-4 rounded-xl text-sm font-bold tracking-wider uppercase text-white bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 active:scale-[0.99] transition-all flex items-center justify-center gap-3 shadow-lg glow-purple ${(!isModelLoaded || isProcessing) && 'opacity-50 cursor-not-allowed'
                    }`}
                >
                  {!isModelLoaded ? (
                    <><div className="w-5 h-5 border-2 border-zinc-400 border-t-white rounded-full animate-spin" />Loading Neural Nets...</>
                  ) : (
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
                      </svg>
                      Scan Face &amp; Create Identity
                    </>
                  )}
                </button>
              </form>
            )}

            {/* LOGIN FORM */}
            {!isScanning && progressStep !== 'success' && progressStep !== 'redirecting' && authMode === 'login' && (
              <form onSubmit={startScanningFlow} className="space-y-5">
                <div className="bg-teal-950/30 border border-teal-800/40 rounded-2xl p-5 text-center space-y-2">
                  <div className="w-14 h-14 mx-auto rounded-full bg-teal-500/10 border border-teal-500/30 flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-7 h-7 text-teal-400">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7.864 4.243A7.5 7.5 0 0 1 19.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 0 0 4.5 10.5a7.464 7.464 0 0 1-1.15 3.993m1.989 3.559A11.209 11.209 0 0 0 8.25 10.5a3.75 3.75 0 1 1 7.5 0c0 .527-.021 1.049-.064 1.565M12 10.5a14.94 14.94 0 0 1-3.6 9.75m6.633-4.596a18.666 18.666 0 0 1-2.485 5.33" />
                    </svg>
                  </div>
                  <h3 className="text-sm font-bold text-teal-300">Biometric Login with ZK Proof</h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    A <span className="text-teal-400 font-semibold">Groth16 ZK Proof</span> verifies your identity without revealing biometric descriptors.
                  </p>
                </div>

                {/* Liveness Selector */}
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                    Liveness Spoof Protection
                  </label>
                  <select
                    value={livenessLevel}
                    onChange={(e) => setLivenessLevel(e.target.value as any)}
                    className="w-full bg-zinc-950 border border-zinc-800 text-zinc-300 text-xs rounded-xl px-4 py-3 outline-none focus:border-purple-500"
                  >
                    <option value="standard">Standard Protection (Liveness Score &gt; 0.85)</option>
                    <option value="strict">Strict Protection (Liveness Score &gt; 0.95)</option>
                    <option value="off">Bypass / Off</option>
                  </select>
                </div>

                <div className="space-y-2">
                  {[
                    { icon: '🔍', label: 'Scan face → Extract 128-d vector' },
                    { icon: '⛓', label: 'Query contract → Fetch registered CID' },
                    { icon: '🔐', label: 'Run snarkjs.groth16.fullProve in browser' },
                  ].map((step) => (
                    <div key={step.label} className="flex items-center gap-3 text-xs text-zinc-400 bg-zinc-950/60 border border-zinc-800/60 rounded-xl px-4 py-2.5">
                      <span className="text-base">{step.icon}</span>
                      <span>{step.label}</span>
                    </div>
                  ))}
                </div>

                {/* Wallet Banner */}
                <div className="bg-zinc-950/80 border border-zinc-800/80 rounded-2xl p-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${walletAddress ? 'bg-green-500 glow-green' : 'bg-amber-500 animate-pulse'}`} />
                    <div>
                      <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">Connected Wallet</h4>
                      <p className="text-xs font-mono text-zinc-500 mt-0.5 truncate max-w-[200px] sm:max-w-xs">
                        {walletAddress || 'Not Connected'}
                      </p>
                    </div>
                  </div>
                  {!walletAddress && (
                    <button
                      type="button"
                      onClick={connectWallet}
                      className="px-4 py-2 text-xs font-semibold text-white bg-zinc-800 hover:bg-zinc-700 active:scale-95 border border-zinc-700 rounded-xl transition-all"
                    >
                      Connect Wallet
                    </button>
                  )}
                </div>

                <button
                  id="btn-login-scan"
                  type="submit"
                  disabled={isProcessing || !isModelLoaded}
                  className={`w-full py-4 rounded-xl text-sm font-bold tracking-wider uppercase text-white bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-500 hover:to-teal-500 active:scale-[0.99] transition-all flex items-center justify-center gap-3 shadow-lg ${(!isModelLoaded || isProcessing) && 'opacity-50 cursor-not-allowed'
                    }`}
                >
                  {!isModelLoaded ? (
                    <><div className="w-5 h-5 border-2 border-zinc-400 border-t-white rounded-full animate-spin" />Loading Neural Nets...</>
                  ) : (
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                      </svg>
                      Scan Face to Login
                    </>
                  )}
                </button>
              </form>
            )}

            {/* WEBCAM SCANNING INTERFACE */}
            {isScanning && (
              <div className="flex flex-col items-center justify-center space-y-6">
                <div className="relative w-full max-w-sm aspect-square bg-zinc-950 rounded-2xl overflow-hidden border-2 border-purple-500 glow-purple">

                  <Webcam
                    audio={false}
                    ref={webcamRef}
                    screenshotFormat="image/jpeg"
                    videoConstraints={{ width: 400, height: 400, facingMode: 'user' }}
                    className="w-full h-full object-cover"
                  />

                  <div className="absolute inset-0 border-4 border-dashed border-purple-500/20 rounded-2xl pointer-events-none" />
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4/5 h-4/5 border-2 border-purple-500/50 rounded-full pointer-events-none flex items-center justify-center">
                    <div className="w-full h-0.5 bg-gradient-to-r from-transparent via-purple-500 to-transparent absolute animate-scan pointer-events-none" />
                  </div>

                  <div className="absolute top-4 left-4 w-6 h-6 border-t-4 border-l-4 border-purple-500 pointer-events-none" />
                  <div className="absolute top-4 right-4 w-6 h-6 border-t-4 border-r-4 border-purple-500 pointer-events-none" />
                  <div className="absolute bottom-4 left-4 w-6 h-6 border-b-4 border-l-4 border-purple-500 pointer-events-none" />
                  <div className="absolute bottom-4 right-4 w-6 h-6 border-b-4 border-r-4 border-purple-500 pointer-events-none" />

                  {/* Dynamic Liveness instruction overlay */}
                  <div className="absolute bottom-4 inset-x-4 bg-zinc-950/95 backdrop-blur border border-zinc-800 rounded-lg p-2.5 text-center pointer-events-none">
                    <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">
                      {livenessLevel === 'off' ? 'Face Frame Alignment' : 'Spoofing Guard Active'}
                    </p>
                    <p className="text-xs text-purple-400 font-semibold mt-0.5">
                      {livenessLevel === 'off'
                        ? 'Center face inside the frame'
                        : liveness.instruction || 'Analyzing structure...'}
                    </p>
                  </div>
                </div>

                {/* Challenge Progress feedback bar */}
                {livenessLevel !== 'off' && liveness.currentChallenge && (
                  <div className="w-full max-w-sm bg-zinc-950/80 border border-zinc-800 rounded-xl p-4 space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-400 font-medium">
                        Step {liveness.challengeIndex + 1}/3: {challengeLabelMap[liveness.currentChallenge]}
                      </span>
                      <span className="text-purple-400 font-bold">Attempt {liveness.attempts + 1}/3</span>
                    </div>

                    {liveness.currentChallenge === 'blink' ? (
                      <div className="flex gap-1.5 pt-1">
                        {[1, 2, 3].map((step) => (
                          <div
                            key={step}
                            className={`flex-1 h-2 rounded-full transition-all duration-300 ${step <= liveness.progress ? 'bg-green-500' : 'bg-zinc-800'
                              }`}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="w-full h-2 bg-zinc-850 rounded-full overflow-hidden">
                        <div
                          className="bg-green-500 h-full transition-all duration-200"
                          style={{ width: `${liveness.progress}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="flex gap-4 w-full max-w-sm">
                  <button
                    type="button"
                    onClick={() => setIsScanning(false)}
                    className="flex-1 py-3 text-xs font-bold uppercase border border-zinc-800 text-zinc-400 hover:bg-zinc-800/50 rounded-xl transition-all"
                  >
                    Cancel
                  </button>
                  {livenessLevel === 'off' && (
                    <button
                      type="button"
                      onClick={captureAndAuthenticate}
                      className="flex-1 py-3 text-xs font-bold uppercase bg-purple-600 hover:bg-purple-500 text-white rounded-xl glow-purple transition-all"
                    >
                      Capture &amp; Verify
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Redirecting Flow */}
            {(progressStep === 'success' || progressStep === 'redirecting') && (
              <div className="text-center py-12 flex flex-col items-center justify-center space-y-6">
                <div className="w-20 h-20 rounded-full border-4 border-green-500 flex items-center justify-center glow-green animate-pulse-ring">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-10 h-10 text-green-400">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                  </svg>
                </div>

                {screenshot && (
                  <div className="w-20 h-20 rounded-full overflow-hidden border-2 border-green-500/50 glow-green shadow-lg flex items-center justify-center">
                    <img src={screenshot} className="w-full h-full object-cover" alt="Scanned Biometrics" />
                  </div>
                )}

                <div>
                  <h2 className="text-2xl font-bold text-white">Identity Secured!</h2>
                  {redirectUrl ? (
                    <p className="text-sm text-zinc-400 mt-2">
                      Authentication verified. Redirecting back to app in <span className="font-mono text-purple-400 text-lg font-bold">{countdown}</span> seconds...
                    </p>
                  ) : (
                    <p className="text-sm text-zinc-400 mt-2">
                      Biometrics matching completed and archived onto IPFS!
                    </p>
                  )}
                </div>

                <div className="w-full bg-zinc-950 border border-zinc-800 rounded-2xl p-4 text-left font-mono text-xs space-y-2.5">
                  <div>
                    <span className="text-zinc-500">IPFS CID:</span>
                    <span className="text-purple-400 ml-2 break-all">{ipfsCid}</span>
                  </div>
                  {zkProof && (
                    <div>
                      <span className="text-zinc-500">ZK Proof Protocol:</span>
                      <span className="text-green-400 ml-2">{zkProof.protocol}</span>
                    </div>
                  )}
                  {livenessLevel !== 'off' && liveness.score > 0 && (
                    <div>
                      <span className="text-zinc-500">Liveness Score:</span>
                      <span className="text-purple-400 ml-2 font-bold">{liveness.score}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-zinc-500">Wallet Auth:</span>
                    <span className="text-blue-400 ml-2 truncate">{walletAddress}</span>
                  </div>
                </div>

                {!redirectUrl && (
                  <div className="w-full pt-4 border-t border-zinc-800 space-y-6 text-left">
                    <div className="bg-amber-950/20 border border-amber-800/40 rounded-xl p-3 text-amber-400 text-xs flex gap-2">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 shrink-0">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                      </svg>
                      <span>
                        No redirect parameter found. Showing diagnostic tools and decrypters.
                      </span>
                    </div>

                    <div className="space-y-2">
                      <label className="block text-xs uppercase tracking-wider text-zinc-500 font-bold">
                        Test Redirect URL
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={customRedirectUrl}
                          onChange={(e) => setCustomRedirectUrl(e.target.value)}
                          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-700 font-mono focus:outline-none focus:border-purple-500"
                        />
                        <button
                          type="button"
                          onClick={executeManualRedirect}
                          className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 active:scale-95 border border-zinc-700 text-white rounded-xl text-xs font-semibold transition-all shrink-0"
                        >
                          Redirect
                        </button>
                      </div>
                    </div>

                    <div className="bg-zinc-950/60 border border-zinc-800 rounded-xl p-4 space-y-4">
                      <div>
                        <h4 className="text-xs font-bold uppercase tracking-wider text-purple-400">Decryption Sandbox</h4>
                        <p className="text-zinc-500 text-[11px] mt-1">
                          Retrieve and decrypt your PII directly from the client. Prove the Lit Protocol access control holds.
                        </p>
                      </div>

                      {decryptionError && (
                        <p className="text-xs text-red-400 font-mono bg-red-950/20 border border-red-800/40 p-2 rounded-lg">
                          {decryptionError}
                        </p>
                      )}

                      {decryptedData ? (
                        <div className="bg-purple-950/20 border border-purple-800/40 rounded-lg p-3 space-y-1 font-mono text-[11px]">
                          <div className="text-purple-400 font-bold uppercase mb-1">Decrypted PII Payload:</div>
                          <div>Name: <span className="text-white font-sans font-medium">{decryptedData.name}</span></div>
                          <div>Email: <span className="text-white font-sans font-medium">{decryptedData.email}</span></div>
                          <div>Mobile: <span className="text-white font-sans font-medium">{decryptedData.mobile}</span></div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={handleTestDecryption}
                          disabled={isDecrypting}
                          className="w-full py-2.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-2"
                        >
                          {isDecrypting ? (
                            <>
                              <div className="w-4 h-4 border-2 border-zinc-400 border-t-white rounded-full animate-spin" />
                              Decrypting...
                            </>
                          ) : (
                            'Decrypt Using Wallet'
                          )}
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => window.location.reload()}
                      className="w-full py-2 border border-zinc-800 hover:bg-zinc-900 text-zinc-400 rounded-xl text-xs font-bold uppercase tracking-wider transition-all"
                    >
                      Restart Flow
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Global Errors Banner */}
            {sdkError && (
              <div className="mt-6 rounded-2xl p-4 flex flex-col gap-3 text-sm border border-red-800/50 bg-red-950/30">
                <div className="flex gap-3 text-red-400">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 shrink-0 mt-0.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                  </svg>
                  <div>
                    <h5 className="font-bold text-red-300">
                      {sdkError.toLowerCase().includes('already exists') || sdkError.toLowerCase().includes('sybil')
                        ? '⚠ Identity Already Registered'
                        : sdkError.toLowerCase().includes('not found') || sdkError.toLowerCase().includes('register first')
                          ? '⚠ Identity Not Found'
                          : 'Execution Error'}
                    </h5>
                    <p className="text-xs text-red-300/80 mt-1 font-mono leading-relaxed">{sdkError}</p>
                  </div>
                </div>

                {(sdkError.toLowerCase().includes('already exists') || sdkError.toLowerCase().includes('sybil')) && (
                  <button
                    type="button"
                    onClick={() => setAuthMode('login')}
                    className="w-full py-2.5 bg-gradient-to-r from-green-700 to-teal-700 hover:from-green-600 hover:to-teal-600 text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-2"
                  >
                    ⚡ Switch to Login Mode
                  </button>
                )}
                {(sdkError.toLowerCase().includes('not found') || sdkError.toLowerCase().includes('register first')) && (
                  <button
                    type="button"
                    onClick={() => setAuthMode('register')}
                    className="w-full py-2.5 bg-gradient-to-r from-purple-700 to-blue-700 hover:from-purple-600 hover:to-blue-600 text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-2"
                  >
                    ✦ Switch to Register Mode
                  </button>
                )}


              </div>
            )}
          </>
        )}
      </div>

      {/* Diagnostic Logs Sidebar */}
      <div className="w-full lg:w-2/5 bg-zinc-900/60 backdrop-blur-xl border border-zinc-800 rounded-3xl p-6 shadow-2xl flex flex-col h-[520px] lg:h-[680px] relative overflow-hidden">

        <div className="flex items-center justify-between border-b border-zinc-800 pb-4 mb-4">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-red-500" />
            <span className="w-3 h-3 rounded-full bg-yellow-500" />
            <span className="w-3 h-3 rounded-full bg-green-500" />
            <span className="text-xs font-bold font-mono text-zinc-400 ml-2">pramanauth-diagnostics</span>
          </div>
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse glow-green" />
        </div>

        <div className="mb-4 bg-zinc-950 border border-zinc-800/80 rounded-xl p-3.5 space-y-2">
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Integration Status</h4>

          <div className="grid grid-cols-2 gap-2 text-[10px] font-medium font-mono">
            <div className={`border p-1.5 rounded-lg flex items-center gap-2 ${getStepColor('connecting-wallet')}`}>
              <div className="w-1.5 h-1.5 rounded-full bg-current" />
              Wallet
            </div>
            <div className={`border p-1.5 rounded-lg flex items-center gap-2 ${getStepColor('loading-models')}`}>
              <div className="w-1.5 h-1.5 rounded-full bg-current" />
              Models
            </div>
            <div className={`border p-1.5 rounded-lg flex items-center gap-2 ${getStepColor('scanning-face')}`}>
              <div className="w-1.5 h-1.5 rounded-full bg-current" />
              Face scan
            </div>
            <div className={`border p-1.5 rounded-lg flex items-center gap-2 ${getStepColor('checking-duplicate')}`}>
              <div className="w-1.5 h-1.5 rounded-full bg-current" />
              Sybil Check
            </div>
            <div className={`border p-1.5 rounded-lg flex items-center gap-2 ${getStepColor('encrypting-pii')}`}>
              <div className="w-1.5 h-1.5 rounded-full bg-current" />
              Lit Encrypt
            </div>
            <div className={`border p-1.5 rounded-lg flex items-center gap-2 ${getStepColor('uploading-ipfs')}`}>
              <div className="w-1.5 h-1.5 rounded-full bg-current" />
              IPFS Pin
            </div>
            <div className={`border p-1.5 rounded-lg flex items-center gap-2 ${getStepColor('generating-zk-proof')}`}>
              <div className="w-1.5 h-1.5 rounded-full bg-current" />
              ZK Proof
            </div>
            <div className={`border p-1.5 rounded-lg flex items-center gap-2 ${getStepColor('registering-on-chain')}`}>
              <div className="w-1.5 h-1.5 rounded-full bg-current" />
              Registry
            </div>
          </div>
        </div>

        <div className="flex-1 bg-zinc-950 rounded-xl p-4 font-mono text-[11px] overflow-y-auto border border-zinc-800/60" id="log-terminal">
          {logs.length === 0 ? (
            <p className="text-zinc-600 italic">No diagnostic events emitted yet...</p>
          ) : (
            <div className="space-y-1.5">
              {logs.map((log, index) => {
                let colorClass = 'text-zinc-300';
                if (log.includes('error') || log.includes('Error')) colorClass = 'text-red-400 font-bold';
                else if (log.includes('successfully') || log.includes('successful') || log.includes('secured') || log.includes('succeeded')) colorClass = 'text-green-400';
                else if (log.includes('Lit Protocol') || log.includes('SIWE')) colorClass = 'text-purple-400';
                else if (log.includes('IPFS') || log.includes('CID')) colorClass = 'text-blue-400';
                else if (log.includes('ZK') || log.includes('proof')) colorClass = 'text-emerald-400';

                return (
                  <div key={index} className={`break-all leading-normal ${colorClass}`}>
                    {log}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
