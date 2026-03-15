import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { getFirestore, collection, addDoc, serverTimestamp, query, orderBy, onSnapshot, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

// Ensure persistence is set to local
setPersistence(auth, browserLocalPersistence).catch(err => console.error("Persistence error:", err));

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Auth helpers
export const signInWithGoogle = async () => {
  try {
    console.log("Attempting signInWithPopup...");
    const result = await signInWithPopup(auth, googleProvider);
    console.log("Popup sign-in successful:", result.user.email);
    return result.user;
  } catch (error: any) {
    console.warn("Popup sign-in failed:", error.code, error.message);
    
    // If popup is blocked or specific errors occur, try redirect
    if (
      error.code === 'auth/popup-blocked' || 
      error.code === 'auth/cancelled-popup-request' || 
      error.code === 'auth/popup-closed-by-user' ||
      error.code === 'auth/network-request-failed'
    ) {
      console.log("Triggering signInWithRedirect as fallback...");
      await signInWithRedirect(auth, googleProvider);
      return null;
    }
    
    throw error;
  }
};

export const signInWithGoogleRedirect = async () => {
  console.log("Triggering explicit signInWithRedirect...");
  await signInWithRedirect(auth, googleProvider);
};

export { collection, addDoc, serverTimestamp, query, orderBy, onSnapshot, doc, getRedirectResult };
