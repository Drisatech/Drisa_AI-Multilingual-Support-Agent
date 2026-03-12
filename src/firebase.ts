import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'MISSING_API_KEY',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'MISSING_PROJECT_ID',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
  firestoreDatabaseId: import.meta.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID || '(default)',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
};

let app;
try {
  app = initializeApp(firebaseConfig);
} catch (e) {
  console.error("Firebase initialization failed. Check your environment variables.", e);
  // Create a dummy app or handle gracefully
  app = { name: '[DEFAULT]' } as any; 
}

let db: any;
let auth: any;

try {
  db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
  auth = getAuth(app);
} catch (e) {
  console.error("Firebase services initialization failed:", e);
  db = null;
  auth = null;
}

export { db, auth };
export const googleProvider = new GoogleAuthProvider();

export const signInWithGoogle = () => {
  if (!auth) {
    alert("Firebase is not configured. Please set your environment variables.");
    return;
  }
  return signInWithPopup(auth, googleProvider);
};
