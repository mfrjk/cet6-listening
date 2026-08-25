import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged as listenAuthState,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
  set,
  onValue,
  off
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";

const config = window.CET6_FIREBASE_CONFIG;
const authListeners = new Set();
let currentUser;
let database;
let auth;
let progressUnsubscribe = null;

const api = {
  provider: "password",
  status: "loading",
  get user() {
    return currentUser || null;
  },
  onAuthStateChanged(callback) {
    authListeners.add(callback);
    if (currentUser !== undefined) callback(currentUser);
    return () => authListeners.delete(callback);
  },
  async register(email, password) {
    if (!auth) throw new Error("firebase-not-ready");
    const result = await createUserWithEmailAndPassword(auth, email.trim(), password);
    return result.user;
  },
  async signIn(email, password) {
    if (!auth) throw new Error("firebase-not-ready");
    const result = await signInWithEmailAndPassword(auth, email.trim(), password);
    return result.user;
  },
  async signOut() {
    if (auth) await firebaseSignOut(auth);
  },
  async loadProgress() {
    if (!currentUser || !database) return null;
    const snapshot = await get(ref(database, "users/" + currentUser.uid + "/progress"));
    return snapshot.exists() ? snapshot.val() : null;
  },
  watchProgress(callback) {
    if (progressUnsubscribe) progressUnsubscribe();
    if (!currentUser || !database) return () => {};
    const progressRef = ref(database, "users/" + currentUser.uid + "/progress");
    const listener = onValue(
      progressRef,
      (snapshot) => callback(snapshot.exists() ? snapshot.val() : null, null),
      (error) => callback(null, error)
    );
    progressUnsubscribe = () => {
      off(progressRef, "value", listener);
      progressUnsubscribe = null;
    };
    return progressUnsubscribe;
  },
  async saveProgress(data) {
    if (!currentUser || !database) return;
    await set(ref(database, "users/" + currentUser.uid + "/progress"), {
      version: 1,
      updatedAt: Date.now(),
      data
    });
  }
};

window.CET_FIREBASE_SYNC = api;

try {
  const firebaseApp = initializeApp(config);
  auth = getAuth(firebaseApp);
  database = getDatabase(firebaseApp, config.databaseURL);
  api.status = "ready";
  listenAuthState(auth, (user) => {
    currentUser = user;
    authListeners.forEach((callback) => callback(user));
  });
} catch (error) {
  api.status = "error";
  api.error = error;
  console.error("Firebase initialization failed", error);
}

window.dispatchEvent(new CustomEvent("cet-firebase-ready"));
