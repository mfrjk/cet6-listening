(function () {
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
      const result = await auth.createUserWithEmailAndPassword(email.trim(), password);
      return result.user;
    },
    async signIn(email, password) {
      if (!auth) throw new Error("firebase-not-ready");
      const result = await auth.signInWithEmailAndPassword(email.trim(), password);
      return result.user;
    },
    async signOut() {
      if (auth) await auth.signOut();
    },
    async loadProgress() {
      if (!currentUser || !database) return null;
      const snapshot = await database.ref("users/" + currentUser.uid + "/progress").once("value");
      return snapshot.exists() ? snapshot.val() : null;
    },
    watchProgress(callback) {
      if (progressUnsubscribe) progressUnsubscribe();
      if (!currentUser || !database) return () => {};
      const progressRef = database.ref("users/" + currentUser.uid + "/progress");
      const listener = progressRef.on(
        "value",
        (snapshot) => callback(snapshot.exists() ? snapshot.val() : null, null),
        (error) => callback(null, error)
      );
      progressUnsubscribe = () => {
        progressRef.off("value", listener);
        progressUnsubscribe = null;
      };
      return progressUnsubscribe;
    },
    async saveProgress(data) {
      if (!currentUser || !database) return;
      await database.ref("users/" + currentUser.uid + "/progress").set({
        version: 1,
        updatedAt: Date.now(),
        data
      });
    }
  };

  window.CET_FIREBASE_SYNC = api;

  try {
    if (!window.firebase) throw new Error("firebase-sdk-not-loaded");
    const firebaseApp = window.firebase.initializeApp(config);
    auth = window.firebase.auth(firebaseApp);
    database = window.firebase.database(firebaseApp);
    api.status = "ready";
    auth.onAuthStateChanged((user) => {
      currentUser = user;
      authListeners.forEach((callback) => callback(user));
    });
  } catch (error) {
    api.status = "error";
    api.error = error;
    console.error("Firebase initialization failed", error);
  }

  window.dispatchEvent(new CustomEvent("cet-firebase-ready"));
})();
