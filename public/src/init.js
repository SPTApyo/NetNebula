// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyC6v4zKmLOLv4YJWUskjiuTtbLzxjH87IE",
  authDomain: "netnebula-eb9eb.firebaseapp.com",
  projectId: "netnebula-eb9eb",
  storageBucket: "netnebula-eb9eb.firebasestorage.app",
  messagingSenderId: "131129019634",
  appId: "1:131129019634:web:a996de12181fd134d0946b",
  measurementId: "G-XJELSBSYK9"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);