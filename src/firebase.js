// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDw4o2yLQtYlKVW1wDDFCuidBAHMxt6czQ",
  authDomain: "command-board-59e23.firebaseapp.com",
  projectId: "command-board-59e23",
  storageBucket: "command-board-59e23.firebasestorage.app",
  messagingSenderId: "339639440969",
  appId: "1:339639440969:web:4b5e24a5a6e8c9fa4ad198",
  measurementId: "G-PT3DMJDBG3"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
