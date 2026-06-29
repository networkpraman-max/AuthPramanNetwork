export { initPraman, PramanClient, DEFAULT_RELAYER_URL } from './client';
export type { PramanConfig, AuthResult, ProgressStepData, PramanErrorType, PopupOptions, PopupAuthResult } from './types';
export { PramanErrors } from './types';
export { quantizeFaceVector, hashFaceVector, getStableVector } from './biometrics';
export { generateZKFaceProof } from './zkLayer';
export { encryptPII, uploadToIPFS, getManualAuthSig, decryptPII, getPermissionAuthSig, fetchFromIPFS } from './storageLayer';
export { default as FaceRegistryConfig } from './contracts/FaceRegistry.json';
export { PramanAuth } from './PramanAuth';
export { LivenessGuard, useLivenessGuard } from './liveness';
export { DeviceGuard } from './device';

