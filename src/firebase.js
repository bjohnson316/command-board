import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// Paste the config object from Firebase Console → Project settings →
// General → Your apps → SDK setup and configuration. This is safe to
// commit — it identifies your project, it isn't a secret. Access is
// controlled by Firestore Security Rules (see firestore.rules and the
// README), not by hiding this object.
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
