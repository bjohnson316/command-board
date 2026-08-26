import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDw4o2yLQtYlKVW1wDDFCuidBAHMxt6czQ",
  authDomain: "command-board-59e23.firebaseapp.com",
  projectId: "command-board-59e23",
  storageBucket: "command-board-59e23.firebasestorage.app",
  messagingSenderId: "339639440969",
  appId: "1:339639440969:web:4b5e24a5a6e8c9fa4ad198",
  measurementId: "G-PT3DMJDBG3"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
