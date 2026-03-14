import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult } from 'firebase/auth';
import { getFirestore, collection, addDoc, serverTimestamp, query, orderBy, onSnapshot, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Auth helper
export const signInWithGoogle = async () => {
  try {
    // Try popup first
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error: any) {
    console.warn("Popup sign-in failed, trying redirect...", error);
    // If popup is blocked or fails, try redirect
    if (error.code === 'auth/popup-blocked' || error.code === 'auth/cancelled-popup-request') {
      await signInWithRedirect(auth, googleProvider);
    }
    throw error;
  }
};

export { collection, addDoc, serverTimestamp, query, orderBy, onSnapshot, doc, getRedirectResult };
