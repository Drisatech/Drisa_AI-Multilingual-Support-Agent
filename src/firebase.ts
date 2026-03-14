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

// Auth helper
export const signInWithGoogle = async () => {
  try {
    console.log("Attempting signInWithPopup...");
    const result = await signInWithPopup(auth, googleProvider);
    console.log("Popup sign-in successful:", result.user.email);
    return result.user;
  } catch (error: any) {
    console.warn("Popup sign-in failed:", error.code, error.message);
    
    // If popup is blocked, try redirect
    if (error.code === 'auth/popup-blocked' || error.code === 'auth/cancelled-popup-request' || error.code === 'auth/popup-closed-by-user') {
      console.log("Triggering signInWithRedirect...");
      await signInWithRedirect(auth, googleProvider);
      // The page will redirect, so we don't need to return anything here
      return null;
    }
    
    throw error;
  }
};

export { collection, addDoc, serverTimestamp, query, orderBy, onSnapshot, doc, getRedirectResult };
