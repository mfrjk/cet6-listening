(() => {
  const data = window.CET_LISTENING_DATA;
  const storageKey = "cet6-listening-progress-v1";
  const cloudOwnerKey = storageKey + "-owner-v1";
  const app = document.getElementById("app");
  let saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
  const state = {
    screen: "home",
    paperId: data.papers[0].id,
    taskIndex: 0,
    answers: {},
    submitted: false,
    filter: "",
    focusQuestion: null,
    focusTranscript: false,
    mock: null,
    sidebarCollapsed: false,
    suppressOptionClick: false,
    optionPointer: null,
    optionDragging: false,
    showTranscript: false,
    wrongGroup: null,
    wrongReturn: null,
    cloudUser: null,
    cloudStatus: "local",
    cloudBound: false,
    cloudWatchStop: null,
    cloudLocalOwner: localStorage.getItem(cloudOwnerKey) || "",
    cloudConnectToken: 0
  };

  // Progress can contain the complete mock-paper history. Do not send that
  // payload for every small highlight/answer change, especially on mobile.
  let cloudSaveTimer = 0;
  let cloudSaveInFlight = false;
  let cloudSaveQueued = false;
  let lastPersistedJson = localStorage.getItem(storageKey) || "{}";

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[char]));
  const paper = () => data.papers.find((item) => item.id === state.paperId) || data.papers[0];
  const task = () => paper().tasks[state.taskIndex];
  const recordFor = (paperId) => saved[paperId] || { completed: {}, best: 0 };
  const completedCount = (item) => Object.keys(recordFor(item.id).completed || {}).length;
  const allTasks = () => data.papers.flatMap((item) => item.tasks);
  const mockTasks = () => allTasks().filter((item) => item.audioScope !== "whole-paper");
  const allCompleted = () => data.papers.reduce((sum, item) => sum + completedCount(item), 0);
  const wrongKey = (taskId, questionNumber) => `${taskId}::${questionNumber}`;
  const mockWrongStorageKey = "__mock-wrong-v1";
  const wrongItems = () => data.papers.flatMap((item) => item.tasks.flatMap((current) => {
    const record = recordFor(item.id);
    const result = record.completed?.[current.id];
    if (!result || !result.answers) return [];
    const answers = result.answers || {};
    const deleted = new Set(record.deletedWrong || []);
    return current.questions.filter((question) => !deleted.has(wrongKey(current.id, question.number)) && answers[question.number] !== question.answer).map((question) => ({
      paperId: item.id,
      paperTitle: item.title,
      taskId: current.id,
      taskTitle: current.title,
      question,
      chosen: answers[question.number] || "未作答",
      submittedAt: result.at
    }));
  }));

  const locateMockSource = (item) => {
    if (item.sourcePaperId && item.sourceTaskId && item.sourceQuestionNumber != null) return item;
    const candidatePapers = item.sourcePaper ? data.papers.filter((paperItem) => paperItem.title === item.sourcePaper) : data.papers;
    for (const paperItem of candidatePapers) {
      const candidateTasks = item.taskTitle ? paperItem.tasks.filter((taskItem) => taskItem.title === item.taskTitle) : paperItem.tasks;
      for (const taskItem of candidateTasks) {
        const question = taskItem.questions.find((questionItem) => questionItem.stem === item.stem && (item.answer == null || questionItem.answer === item.answer)) ||
          taskItem.questions.find((questionItem) => questionItem.stem === item.stem);
        if (question) return { ...item, sourcePaperId: paperItem.id, sourceTaskId: taskItem.id, sourceQuestionNumber: question.number };
      }
    }
    return item;
  };
  const mockWrongItems = () => {
    const sets = Array.isArray(saved[mockWrongStorageKey]) ? saved[mockWrongStorageKey] : [];
    return sets.flatMap((set) => {
      const deleted = new Set(set.deletedIds || []);
      return (set.items || []).filter((item) => !deleted.has(item.id)).map((item) => ({
        ...locateMockSource(item),
        setId: set.id,
        submittedAt: set.submittedAt
      }));
    });
  };
  const wrongTotal = () => wrongItems().length + mockWrongItems().length;
  const formatReviewTime = (timestamp) => {
    const date = new Date(Number(timestamp));
    if (!Number.isFinite(date.getTime())) return "时间未知";
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  };
  const correctCount = () => data.papers.reduce((sum, item) => sum + Object.values(recordFor(item.id).completed || {}).reduce((n, entry) => n + (entry.score || 0), 0), 0);

  function cancelQueuedCloudSave() {
    if (cloudSaveTimer) window.clearTimeout(cloudSaveTimer);
    cloudSaveTimer = 0;
    cloudSaveQueued = false;
  }

  async function flushCloudSave() {
    cloudSaveTimer = 0;
    if (!cloudSaveQueued || cloudSaveInFlight) return;
    const sync = window.CET_FIREBASE_SYNC;
    const user = state.cloudUser;
    const connectionToken = state.cloudConnectToken;
    if (!user || !sync?.saveProgress) {
      cloudSaveQueued = false;
      return;
    }
    cloudSaveQueued = false;
    cloudSaveInFlight = true;
    // Snapshot once, at send time. This prevents later UI changes from
    // mutating an in-flight Firebase write and avoids overlapping writes.
    const payload = cloneCloudData(saved);
    try {
      await sync.saveProgress(payload);
      if (state.cloudUser?.uid === user.uid && state.cloudConnectToken === connectionToken) {
        state.cloudStatus = "synced";
        decorateCloudUi();
      }
    } catch (error) {
      if (state.cloudUser?.uid === user.uid && state.cloudConnectToken === connectionToken) {
        state.cloudStatus = "error";
        decorateCloudUi();
      }
      console.warn("Firebase progress save failed", error);
    } finally {
      cloudSaveInFlight = false;
      if (cloudSaveQueued && state.cloudUser) {
        cloudSaveTimer = window.setTimeout(flushCloudSave, 650);
      }
    }
  }

  function queueCloudSave() {
    const sync = window.CET_FIREBASE_SYNC;
    if (!state.cloudUser || !sync?.saveProgress) return;
    cloudSaveQueued = true;
    state.cloudStatus = "syncing";
    decorateCloudUi();
    if (cloudSaveTimer) window.clearTimeout(cloudSaveTimer);
    cloudSaveTimer = window.setTimeout(flushCloudSave, 650);
  }

  function persist(options = {}) {
    // Local persistence remains immediate so a refresh does not lose a newly
    // selected answer or highlight. Cloud persistence is batched separately.
    lastPersistedJson = JSON.stringify(saved);
    localStorage.setItem(storageKey, lastPersistedJson);
    if (!options.skipCloud) queueCloudSave();
  }

  function cloudErrorText(error) {
    const code = error?.code || "";
    return ({
      "auth/invalid-credential": "\u90ae\u7bb1\u6216\u5bc6\u7801\u4e0d\u6b63\u786e\u3002",
      "auth/user-not-found": "\u8d26\u53f7\u4e0d\u5b58\u5728\uff0c\u8bf7\u5148\u6ce8\u518c\u3002",
      "auth/wrong-password": "\u90ae\u7bb1\u6216\u5bc6\u7801\u4e0d\u6b63\u786e\u3002",
      "auth/email-already-in-use": "\u8be5\u90ae\u7bb1\u5df2\u6ce8\u518c\uff0c\u8bf7\u76f4\u63a5\u767b\u5f55\u3002",
      "auth/invalid-email": "\u90ae\u7bb1\u683c\u5f0f\u4e0d\u6b63\u786e\u3002",
      "auth/weak-password": "\u5bc6\u7801\u81f3\u5c11\u9700\u8981 6 \u4f4d\u3002",
      "auth/too-many-requests": "\u5c1d\u8bd5\u6b21\u6570\u8fc7\u591a\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002",
      "auth/network-request-failed": "\u7f51\u7edc\u8fde\u63a5 Firebase \u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u3002",
      "auth/operation-not-allowed": "\u8bf7\u5728 Firebase \u63a7\u5236\u53f0\u5f00\u542f\u201c\u90ae\u7bb1/\u5bc6\u7801\u201d\u767b\u5f55\u3002"
    })[code] || "\u4e91\u7aef\u64cd\u4f5c\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002";
  }

  function showCloudAuthModal(mode = "signin") {
    document.querySelector(".cloud-auth-modal")?.remove();
    const modal = document.createElement("div");
    modal.className = "cloud-auth-modal";
    const registering = mode === "register";
    modal.innerHTML =
      '<div class="cloud-auth-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-auth-title">' +
      '<button class="cloud-auth-close" type="button" aria-label="\u5173\u95ed">\u00d7</button>' +
      '<div class="eyebrow" style="color:var(--teal)">CET-6 CLOUD SYNC</div>' +
      '<h2 id="cloud-auth-title">' + (registering ? "\u6ce8\u518c\u540c\u6b65\u8d26\u53f7" : "\u767b\u5f55\u540c\u6b65\u8d26\u53f7") + '</h2>' +
      '<p>\u4f7f\u7528\u540c\u4e00\u4e2a\u90ae\u7bb1\u548c\u5bc6\u7801\u767b\u5f55\uff0c\u624b\u673a\u4e0e\u7535\u8111\u4f1a\u5171\u7528\u7ec3\u4e60\u8fdb\u5ea6\u3002</p>' +
      '<form class="cloud-auth-form">' +
      '<label>\u90ae\u7bb1<input type="email" name="email" autocomplete="email" required></label>' +
      '<label>\u5bc6\u7801<input type="password" name="password" minlength="6" autocomplete="' + (registering ? "new-password" : "current-password") + '" required></label>' +
      '<div class="cloud-auth-error" role="alert" hidden></div>' +
      '<button class="button primary" type="submit">' + (registering ? "\u6ce8\u518c\u5e76\u540c\u6b65" : "\u767b\u5f55\u5e76\u540c\u6b65") + '</button>' +
      '</form>' +
      '<button class="cloud-auth-switch" type="button">' + (registering ? "\u5df2\u6709\u8d26\u53f7\uff1f\u76f4\u63a5\u767b\u5f55" : "\u8fd8\u6ca1\u6709\u8d26\u53f7\uff1f\u7acb\u5373\u6ce8\u518c") + '</button>' +
      '</div>';
    document.body.append(modal);
    const close = () => modal.remove();
    modal.querySelector(".cloud-auth-close").addEventListener("click", close);
    modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
    modal.querySelector(".cloud-auth-switch").addEventListener("click", () => {
      showCloudAuthModal(registering ? "signin" : "register");
    });
    modal.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector("button[type=submit]");
      const errorNode = form.querySelector(".cloud-auth-error");
      const sync = window.CET_FIREBASE_SYNC;
      if (!sync) {
        errorNode.textContent = "云端模块正在加载，请稍候再点登录。";
        errorNode.hidden = false;
        submit.disabled = false;
        return;
      }
      submit.disabled = true;
      errorNode.hidden = true;
      try {
        const email = form.elements.email.value.trim();
        const password = form.elements.password.value;
        if (registering) await sync.register(email, password);
        else await sync.signIn(email, password);
        close();
      } catch (error) {
        errorNode.textContent = cloudErrorText(error);
        errorNode.hidden = false;
        submit.disabled = false;
      }
    });
    modal.querySelector("input")?.focus();
  }

  function handleCloudError(error) {
    state.cloudStatus = "error";
    console.warn("Firebase operation failed", error);
    render();
    window.alert(cloudErrorText(error));
  }

  function cloneCloudData(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function mergeMockWrongSets(localSets, remoteSets) {
    const byId = new Map();
    [...(Array.isArray(localSets) ? localSets : []), ...(Array.isArray(remoteSets) ? remoteSets : [])].forEach((set) => {
      if (!set || typeof set !== "object" || !set.id) return;
      const incoming = cloneCloudData(set);
      const existing = byId.get(set.id);
      if (!existing) {
        byId.set(set.id, incoming);
        return;
      }
      const latest = Number(incoming.submittedAt) >= Number(existing.submittedAt) ? incoming : existing;
      byId.set(set.id, {
        ...latest,
        deletedIds: [...new Set([...(existing.deletedIds || []), ...(incoming.deletedIds || [])])],
        items: Array.isArray(latest.items) ? latest.items : []
      });
    });
    return [...byId.values()].sort((a, b) => Number(b.submittedAt) - Number(a.submittedAt));
  }

  function mergeCloudProgress(localData, remoteData) {
    const merged = cloneCloudData(localData);
    Object.entries(remoteData || {}).forEach(([paperId, remoteRecord]) => {
      if (paperId === mockWrongStorageKey) return;
      if (!remoteRecord || typeof remoteRecord !== "object" || Array.isArray(remoteRecord)) return;
      const localRecord = merged[paperId] || {};
      const paperClearedAt = Math.max(Number(localRecord.clearedAt) || 0, Number(remoteRecord.clearedAt) || 0);
      const clearedTasks = {};
      [localRecord, remoteRecord].forEach((record) => {
        Object.entries(record.clearedTasks || {}).forEach(([taskId, timestamp]) => {
          const at = Number(timestamp) || 0;
          if (at > (clearedTasks[taskId] || 0)) clearedTasks[taskId] = at;
        });
      });
      const taskClearedAt = (taskId) => Math.max(paperClearedAt, Number(clearedTasks[taskId]) || 0);
      const completed = {};
      const addCompleted = (taskId, result) => {
        if (!result || Number(result.at || 0) <= taskClearedAt(taskId)) return;
        const current = completed[taskId];
        if (!current || Number(result.at || 0) > Number(current.at || 0)) completed[taskId] = result;
      };
      Object.entries(localRecord.completed || {}).forEach(([taskId, result]) => addCompleted(taskId, result));
      Object.entries(remoteRecord.completed || {}).forEach(([taskId, result]) => addCompleted(taskId, result));

      const isFreshDeletedWrong = (record, key) => {
        const taskId = String(key).split("::")[0];
        const tombstone = taskClearedAt(taskId);
        const recordClearedAt = Math.max(
          Number(record.clearedAt) || 0,
          Number(record.clearedTasks?.[taskId]) || 0
        );
        return !tombstone || recordClearedAt >= tombstone;
      };
      const deletedWrong = [...new Set([
        ...(localRecord.deletedWrong || []).filter((key) => isFreshDeletedWrong(localRecord, key)),
        ...(remoteRecord.deletedWrong || []).filter((key) => isFreshDeletedWrong(remoteRecord, key))
      ])];


      const highlights = {};
      [localRecord, remoteRecord].forEach((record) => {
        Object.entries(record.highlights || {}).forEach(([taskId, taskHighlights]) => {
          highlights[taskId] = highlights[taskId] || {};
          Object.entries(taskHighlights || {}).forEach(([questionNumber, optionHighlights]) => {
            highlights[taskId][questionNumber] = highlights[taskId][questionNumber] || {};
            Object.entries(optionHighlights || {}).forEach(([letter, values]) => {
              const currentValues = highlights[taskId][questionNumber][letter] || [];
              highlights[taskId][questionNumber][letter] = [...new Set([
                ...currentValues,
                ...(Array.isArray(values) ? values : [])
              ])];
            });
          });
        });
      });

      const scores = Object.values(completed).map((result) => Number(result?.score) || 0);
      const best = paperClearedAt || Object.keys(clearedTasks).length
        ? Math.max(...scores, 0)
        : Math.max(Number(localRecord.best) || 0, Number(remoteRecord.best) || 0, ...scores);
      const mergedRecord = {
        ...localRecord,
        ...remoteRecord,
        completed,
        deletedWrong,
        highlights,
        best
      };
      if (paperClearedAt) mergedRecord.clearedAt = paperClearedAt;
      else delete mergedRecord.clearedAt;
      if (Object.keys(clearedTasks).length) mergedRecord.clearedTasks = clearedTasks;
      else delete mergedRecord.clearedTasks;
      if (Object.keys(highlights).length) mergedRecord.highlights = highlights;
      else delete mergedRecord.highlights;
      merged[paperId] = mergedRecord;
    });
    const mergedMockWrong = mergeMockWrongSets(localData?.[mockWrongStorageKey], remoteData?.[mockWrongStorageKey]);
    if (mergedMockWrong.length) merged[mockWrongStorageKey] = mergedMockWrong;
    else delete merged[mockWrongStorageKey];
    return merged;
  }

  function handleCloudRemoteData(remoteData) {
    if (!state.cloudUser || !remoteData || typeof remoteData !== "object") return;
    const remoteJson = JSON.stringify(remoteData);
    // Firebase echoes our own write. Skip the expensive merge/stringify/render
    // cycle when the remote snapshot is already the locally persisted state.
    if (remoteJson === lastPersistedJson) return;
    const merged = mergeCloudProgress(saved, remoteData);
    const after = JSON.stringify(merged);
    if (after !== lastPersistedJson) {
      saved = merged;
      persist({ skipCloud: true });
      state.answers = {};
      state.submitted = false;
      render();
    }
    // Only write back when the merge actually changed our local snapshot.
    // Firebase may return the same values with a different object-key order;
    // that is not a data change and must not create a sync feedback loop.
    if (remoteJson !== after && after !== lastPersistedJson) queueCloudSave();
  }

  async function connectCloudUser(user) {
    if (state.cloudUser?.uid !== user?.uid) cancelQueuedCloudSave();
    const connectionToken = (state.cloudConnectToken || 0) + 1;
    state.cloudConnectToken = connectionToken;
    if (state.cloudWatchStop) {
      state.cloudWatchStop();
      state.cloudWatchStop = null;
    }
    state.cloudUser = user;
    if (!user) {
      state.cloudLocalOwner = "guest";
      localStorage.setItem(cloudOwnerKey, "guest");
      state.cloudStatus = "local";
      render();
      return;
    }
    const accountKey = "firebase:" + user.uid;
    const storedOwner = localStorage.getItem(cloudOwnerKey) || "";
    const knownOwner = storedOwner || state.cloudLocalOwner || "";
    if (!state.cloudLocalOwner) state.cloudLocalOwner = knownOwner || accountKey;
    const canMergeLocal = !knownOwner || knownOwner === accountKey;
    state.cloudStatus = "loading";
    render();
    const sync = window.CET_FIREBASE_SYNC;
    try {
      const payload = await sync.loadProgress();
      if (state.cloudConnectToken !== connectionToken || state.cloudUser?.uid !== user.uid) return;
      const remoteData = payload?.data && typeof payload.data === "object" ? payload.data : null;
      const localData = canMergeLocal ? saved : {};
      saved = mergeCloudProgress(localData, remoteData || {});
      localStorage.setItem(cloudOwnerKey, accountKey);
      state.cloudLocalOwner = accountKey;
      persist({ skipCloud: true });
      state.answers = {};
      state.submitted = false;
      await sync.saveProgress(saved);
      if (state.cloudConnectToken !== connectionToken || state.cloudUser?.uid !== user.uid) return;
      state.cloudStatus = "synced";
      state.cloudWatchStop = sync.watchProgress((nextPayload, error) => {
        if (error) {
          state.cloudStatus = "error";
          console.warn("Firebase progress watch failed", error);
          render();
          return;
        }
        const nextData = nextPayload?.data;
        if (nextData) handleCloudRemoteData(nextData);
      });
      render();
    } catch (error) {
      if (state.cloudConnectToken !== connectionToken || state.cloudUser?.uid !== user.uid) return;
      state.cloudStatus = "error";
      console.warn("Firebase progress load failed", error);
      render();
    }
  }

  function bindCloudSync() {
    if (state.cloudBound) return;
    const sync = window.CET_FIREBASE_SYNC;
    if (!sync?.onAuthStateChanged) return;
    state.cloudBound = true;
    sync.onAuthStateChanged((user) => { connectCloudUser(user); });
  }

  function exportProgressData() {
    const payload = {
      format: "cet6-listening-progress",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: saved
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = "cet6-listening-progress-" + stamp + ".json";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function restoreProgressFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result || ""));
        if (!payload || payload.format !== "cet6-listening-progress" || payload.version !== 1 || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
          throw new Error("invalid-format");
        }
        const knownPaperIds = new Set(data.papers.map((item) => item.id));
        const imported = {};
        Object.entries(payload.data).forEach(([paperId, record]) => {
          if (paperId === mockWrongStorageKey) {
            imported[mockWrongStorageKey] = mergeMockWrongSets([], record);
            return;
          }
          if (!knownPaperIds.has(paperId) || !record || typeof record !== "object" || Array.isArray(record)) return;
          const completed = record.completed && typeof record.completed === "object" && !Array.isArray(record.completed) ? record.completed : {};
          const deletedWrong = Array.isArray(record.deletedWrong) ? record.deletedWrong.filter((key) => typeof key === "string") : [];
          const best = Number.isFinite(Number(record.best)) ? Number(record.best) : 0;
          imported[paperId] = { completed, deletedWrong, best };

          const importedHighlights = record.highlights && typeof record.highlights === 'object' && !Array.isArray(record.highlights) ? record.highlights : {};
          if (Object.keys(importedHighlights).length) imported[paperId].highlights = importedHighlights;
          const clearedAt = Number(record.clearedAt) || 0;
          if (clearedAt > 0) imported[paperId].clearedAt = clearedAt;
          const clearedTasks = record.clearedTasks && typeof record.clearedTasks === "object" && !Array.isArray(record.clearedTasks) ? record.clearedTasks : {};
          const importedClearedTasks = {};
          Object.entries(clearedTasks).forEach(([taskId, timestamp]) => {
            const at = Number(timestamp) || 0;
            if (at > 0) importedClearedTasks[taskId] = at;
          });
          if (Object.keys(importedClearedTasks).length) imported[paperId].clearedTasks = importedClearedTasks;
        });
        if (Object.keys(payload.data).length && !Object.keys(imported).length) {
          throw new Error("no-known-papers");
        }
        if (!window.confirm("\u6062\u590d\u6570\u636e\u4f1a\u8986\u76d6\u5f53\u524d\u8fdb\u5ea6\uff0c\u786e\u5b9a\u8981\u7ee7\u7eed\u5417\uff1f")) return;
        Object.keys(saved).forEach((key) => delete saved[key]);
        Object.assign(saved, imported);
        state.answers = {};
        state.submitted = false;
        state.showTranscript = false;
        persist();
        render();
        window.alert("\u6570\u636e\u6062\u590d\u6210\u529f\uff01");
      } catch (error) {
        window.alert("\u6062\u590d\u5931\u8d25\uff1a\u8bf7\u9009\u62e9\u672c\u7f51\u7ad9\u5bfc\u51fa\u7684 JSON \u6587\u4ef6\u3002");
      }
    };
    reader.onerror = () => window.alert("\u65e0\u6cd5\u8bfb\u53d6\u6570\u636e\u6587\u4ef6\u3002");
    reader.readAsText(file);
  }

  function clearTaskProgress(paperId, taskId) {
    const item = data.papers.find((entry) => entry.id === paperId);
    if (!item || !taskId) return;
    const record = recordFor(paperId);
    const pendingAnswers = state.paperId === paperId ? state.answers[taskId] : null;
    const hasProgress = Boolean(record.completed?.[taskId]) ||
      Object.keys(pendingAnswers || {}).length > 0 ||
      (record.deletedWrong || []).some((key) => key.startsWith(taskId + "::"));
    const hasHighlights = Object.keys(record.highlights?.[taskId] || {}).length > 0;
    if (!hasProgress && !hasHighlights) {
      window.alert("本段对话暂时没有需要清除的选择。");
      return;
    }
    const taskTitle = item.tasks.find((entry) => entry.id === taskId)?.title || "当前听力对话";
    if (!window.confirm("确定清除“" + taskTitle + "”的全部作答、成绩和错题记录吗？")) return;
    if (!saved[paperId]) saved[paperId] = { completed: {}, best: 0 };
    const target = saved[paperId];
    target.completed = { ...(target.completed || {}) };
    delete target.completed[taskId];
    target.deletedWrong = (target.deletedWrong || []).filter((key) => !key.startsWith(taskId + "::"));
    target.highlights = { ...(target.highlights || {}) };
    delete target.highlights[taskId];
    target.clearedTasks = { ...(target.clearedTasks || {}), [taskId]: Date.now() };
    target.best = Math.max(...Object.values(target.completed).map((result) => Number(result?.score) || 0), 0);
    if (state.paperId === paperId && task().id === taskId) {
      delete state.answers[taskId];
      state.submitted = false;
      state.showTranscript = false;
    }
    persist();
    render();
  }

  function closeWrongMenu() { document.querySelector(".wrong-context-menu")?.remove(); }
  function deleteWrongItem(paperId, taskId, questionNumber) {
    if (!saved[paperId]) saved[paperId] = { completed: {}, best: 0 };
    const record = saved[paperId];
    record.deletedWrong = [...new Set([...(record.deletedWrong || []), wrongKey(taskId, questionNumber)])];
    persist();
    closeWrongMenu();
    render();
  }
  function deleteMockWrongItem(setId, itemId) {
    const sets = Array.isArray(saved[mockWrongStorageKey]) ? saved[mockWrongStorageKey] : [];
    const target = sets.find((set) => set.id === setId);
    if (!target) return;
    target.deletedIds = [...new Set([...(target.deletedIds || []), itemId])];
    saved[mockWrongStorageKey] = sets;
    persist();
    closeWrongMenu();
    render();
  }

  function deleteWrongGroup(type, id) {
    const group = wrongGroupById(type, id);
    if (!group) return;
    if (type === 'mock') {
      const sets = Array.isArray(saved[mockWrongStorageKey]) ? saved[mockWrongStorageKey] : [];
      const target = sets.find((set) => set.id === id);
      if (!target) return;
      target.deletedIds = [...new Set([...(target.deletedIds || []), ...group.items.map((item) => item.id)])];
      saved[mockWrongStorageKey] = sets;
    } else {
      group.items.forEach((item) => {
        if (!saved[item.paperId]) saved[item.paperId] = { completed: {}, best: 0 };
        const record = saved[item.paperId];
        record.deletedWrong = [...new Set([...(record.deletedWrong || []), wrongKey(item.taskId, item.question.number)])];
      });
    }
    persist();
    closeWrongMenu();
    state.wrongGroup = null;
    render();
  }


  function showWrongMenu(event, card) {
    event.preventDefault();
    closeWrongMenu();
    const wholeGroup = Boolean(card.dataset.wrongGroupType && card.dataset.wrongGroupId);
    const menu = document.createElement('div');
    menu.className = 'wrong-context-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = wholeGroup
      ? '<button type=button role=menuitem><span>×</span> 删除整套错题</button>'
      : '<button type=button role=menuitem><span>✓</span> 删除这道错题</button>';
    const menuWidth = wholeGroup ? 210 : 176;
    menu.style.left = Math.min(event.clientX, window.innerWidth - menuWidth) + 'px';
    menu.style.top = Math.min(event.clientY, window.innerHeight - 54) + 'px';
    menu.querySelector('button').addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      if (wholeGroup) {
        deleteWrongGroup(card.dataset.wrongGroupType, card.dataset.wrongGroupId);
      } else if (card.dataset.mockWrongId) {
        deleteMockWrongItem(card.dataset.mockSetId, card.dataset.mockWrongId);
      } else {
        deleteWrongItem(card.dataset.wrongPaper, card.dataset.wrongTask, card.dataset.wrongQuestion);
      }
    });
    document.body.append(menu);
  }

  function currentAnswers() {
    const id = task().id;
    if (Object.prototype.hasOwnProperty.call(state.answers, id)) return state.answers[id];
    return recordFor(state.paperId).completed?.[id]?.answers || {};
  }
  function nav(active) {
    return `<nav class="topnav">
      <button class="nav-link ${active === "practice" ? "active" : ""}" data-action="home">真题练习</button>
      <button class="nav-link ${active === "mock" ? "active" : ""}" data-action="open-mock">模拟练习</button>
      <button class="nav-link ${active === "wrong" ? "active" : ""}" data-action="open-wrong">错题回顾${wrongTotal() ? ` · ${wrongTotal()}` : ""}</button>
    </nav>`;
  }
  function header(active = "practice", context = "") {
    return `<header class="topbar">
      <button class="brand" data-action="home" aria-label="返回试卷列表"><span class="brand-mark">L</span><span class="brand-name">听力自习室<small>CET-6 LISTENING LAB</small></span></button>
      ${nav(active)}
      <div class="top-actions"><div class="cloud-tools" aria-label="\u4e91\u7aef\u540c\u6b65"><span class="cloud-status" data-cloud-status>\u672c\u673a\u4fdd\u5b58</span><button class="data-tool cloud-auth" type="button" data-action="cloud-auth" title="\u4f7f\u7528\u90ae\u7bb1\u548c\u5bc6\u7801\u767b\u5f55\u540c\u6b65">\u767b\u5f55\u540c\u6b65</button></div><div class="data-tools" aria-label="\u4e2a\u4eba\u6570\u636e\u5de5\u5177"><button class="data-tool data-export" type="button" data-action="export-data" title="\u4e0b\u8f7d\u7ec3\u4e60\u8fdb\u5ea6\u5907\u4efd">\u5bfc\u51fa\u6570\u636e</button><button class="data-tool data-restore" type="button" data-action="restore-data" title="\u4ece JSON \u6587\u4ef6\u6062\u590d\u7ec3\u4e60\u8fdb\u5ea6">\u6062\u590d\u6570\u636e</button><input class="data-restore-input" type="file" accept="application/json,.json" data-restore-file aria-label="\u9009\u62e9\u7ec3\u4e60\u6570\u636e\u6587\u4ef6" hidden></div><span class="source-label">${esc(context || "陈宇昂的专属听力空间")}</span><span class="profile-name">陈宇昂</span><span class="brand-mark profile-mark" style="width:32px;height:32px;border-radius:50%;font-size:14px">陈</span></div>
    </header>`;
  }

  function homeTemplate() {
    const filtered = data.papers.filter((item) => item.title.toLowerCase().includes(state.filter.toLowerCase()));
    return `${header("practice")}<section class="hero"><div class="hero-copy"><div class="eyebrow">CET-6 · LISTENING PRACTICE</div><div class="hero-welcome">陈宇昂的专属听力训练场</div><h1>把每一次听见，<br>都变成分数。</h1><p>历年六级真题听力 · 本地音频 · 即时核对 · 听力原文</p><button class="button hero-start" data-action="open-mock">开始随机模拟 →</button></div><div class="hero-stat-wrap"><div class="hero-stat"><strong>${data.papers.length}</strong><span>套真题试卷</span></div><div class="hero-stat"><strong>${allTasks().length}</strong><span>组听力材料</span></div><div class="hero-stat"><strong>${allCompleted()}<small style="font-size:12px;font-weight:500"> / ${allTasks().length}</small></strong><span>已完成听力组</span></div></div></section><main class="content"><div class="section-head"><div><h2>选择一套真题</h2><p>每组独立练习；如果想一次完成完整听力，请使用“模拟练习”。</p></div><input class="search-box" data-filter placeholder="搜索试卷，例如 24-6" value="${esc(state.filter)}"></div><div class="paper-grid">${filtered.length ? filtered.map(paperCard).join("") : '<div class="empty">没有找到对应试卷</div>'}</div></main><footer class="footer">题目与音频来源：真题墙、过级鸭、蜻蜓 FM 等公开页面 · 陈宇昂的个人离线练习空间</footer>`;
  }
  function paperCard(item) {
    const done = completedCount(item);
    const progress = Math.round(done / item.tasks.length * 100);
    const best = recordFor(item.id).best || 0;
    return `<article class="paper-card"><div><div class="paper-card-top"><div><div class="paper-kicker">CET-6 LISTENING</div><h3>${esc(item.title)}</h3><p class="paper-meta">${item.tasks.length} 组听力 · ${item.questionCount} 道题</p></div>${done === item.tasks.length ? '<span class="paper-badge">已完成</span>' : best ? `<span class="paper-badge">最高 ${best} 题</span>` : '<span class="paper-badge">未开始</span>'}</div></div><div><div class="paper-footer"><div class="progress-track"><i style="width:${progress}%"></i></div><span class="progress-number">${done}/${item.tasks.length} 组</span><button class="button primary" data-paper="${esc(item.id)}">${done ? "继续练习" : "开始练习"}</button></div></div></article>`;
  }
  function sidePapers() {
    return `<aside class="practice-side"><button class="side-back" data-action="home">← 返回试卷列表</button><div class="side-title">历年听力真题</div>${data.papers.map((item) => `<button class="side-paper ${item.id === state.paperId ? "active" : ""}" data-side-paper="${esc(item.id)}"><span>${esc(item.title)}</span><small>${completedCount(item)}/${item.tasks.length}</small></button>`).join("")}</aside>`;
  }
  function practiceTemplate() {
    const item = paper();
    const current = task();
    const answers = currentAnswers();
    const result = state.submitted ? recordFor(item.id).completed?.[current.id] : null;
    const selectedCount = Object.keys(answers).length;
    return `${header("practice", `${item.title} · 练习中`)}<main class="practice-layout">${sidePapers()}<section class="practice-main"><div class="practice-heading"><div>${state.wrongReturn ? '<button class=practice-return type=button data-action=return-wrong>返回错题回顾</button>' : ''}<div class="eyebrow" style="color:var(--teal)">LISTENING PRACTICE / ${esc(item.title)}</div><h1>${esc(current.title)}</h1><p>先完整听一遍，再选择你认为正确的答案。</p></div><div class="task-pager"><button class="button light" data-action="previous" ${state.taskIndex === 0 ? "disabled" : ""}>上一组</button><strong>${state.taskIndex + 1}</strong><span>/ ${item.tasks.length}</span><button class="button light" data-action="next" ${state.taskIndex === item.tasks.length - 1 ? "disabled" : ""}>下一组</button></div></div><div class="audio-card"><div class="audio-card-top"><div><div class="audio-label">NOW PLAYING · ${esc(current.section)}</div><h2>Questions ${current.questions[0]?.number || ""} to ${current.questions.at(-1)?.number || ""}</h2><p>${esc(current.context)}</p></div><div class="audio-card-tools"><span class="audio-icon">◖◗</span><button class="button audio-clear" type="button" data-action="clear-task" data-clear-task="${esc(current.id)}" title="清除本段对话的作答、成绩和错题记录">清除本段选择</button></div></div><audio id="audio-player" controls preload="metadata" src="${esc(current.audio)}"></audio><button type="button" class="button transcript-quick-toggle" data-action="toggle-transcript" aria-controls="transcript-current">显示 / 隐藏听力原文</button></div><section class="question-panel"><div class="question-panel-head"><div><h2>选择题</h2><span>已选择 ${selectedCount} / ${current.questions.length}</span></div>${result ? `<span class="score-pill">本组得分 ${result.score}/${result.total}</span>` : "<span>提交后显示答案</span>"}</div>${current.questions.map((question) => questionTemplate(question, answers)).join("")}<div class="question-actions"><span class="hint">${state.submitted ? "点击下方“听力原文”可回到当前听力段落。" : "每组听力可以反复播放，提交后仍可继续下一组。"}</span><div class="action-group"><button class="button ghost" data-action="reset-task">清空选择</button><button class="button primary" data-action="submit-task">${state.submitted ? "重新提交本组" : "提交本组答案"}</button></div></div>${(state.submitted || state.showTranscript) ? transcriptTemplate(current, "transcript-current") : ""}</section></section></main>`;
  }
  function questionTemplate(question, answers) {
    const selected = answers[question.number];
    const correct = question.answer;
    const status = state.submitted ? (selected === correct ? "good" : "bad") : "";
    return `<article class="question" data-question-number="${question.number}"><div class="question-stem"><span class="question-no">${question.number}</span><p>${esc(question.stem)}</p></div><div class="options">${Object.entries(question.options).map(([letter, text]) => { const chosen = selected === letter; const cls = state.submitted ? (letter === correct ? "is-correct" : chosen ? "is-wrong" : "") : chosen ? "is-selected" : ""; return `<label class="option ${cls}" data-highlight-question="${question.number}" data-highlight-option="${letter}"><input type="radio" name="q-${question.number}" value="${letter}" data-answer="${question.number}" ${chosen ? "checked" : ""}><span><b>${letter}.</b> ${renderOptionText(text, getRealHighlightValues(question.number, letter))}</span></label>`; }).join("")}</div>${state.submitted ? `<div class="result-line ${status}">${selected === correct ? "✓ 回答正确" : `✕ 正确答案是 ${correct}${selected ? `，你的选择是 ${selected}` : "，本题未作答"}`}</div>` : ""}</article>`;
  }
  function transcriptLinesTemplate(current, mock = false) {
    return (current.transcript || []).map((line, index) => {
      const timing = current.transcriptTiming?.[index] || {};
      const mockAttr = mock ? ` data-transcript-audio-id="${esc(current.mockId)}"` : "";
      const start = Number.isFinite(Number(timing.start)) ? ` data-transcript-start="${timing.start}"` : "";
      const end = Number.isFinite(Number(timing.end)) ? ` data-transcript-end="${timing.end}"` : "";
      return `<button type="button" class="transcript-line ${index === 0 ? "current-line" : ""}" data-transcript-line="${index}"${mockAttr}${start}${end}>${esc(line)}</button>`;
    }).join("");
  }
  function transcriptTemplate(current, id, mock = false) {
    const action = mock ? "focus-mock-transcript" : "focus-transcript";
    const audioAttr = mock ? `data-mock-audio-id="${current.mockId}"` : "";
    const containerAudioAttr = mock ? ` data-transcript-audio-id="${esc(current.mockId)}"` : "";
    return `<div class="transcript ${mock ? "mock-transcript" : ""}" id="${id}"${containerAudioAttr}><button class="transcript-heading" data-action="${action}" ${audioAttr}><span>听力原文 · TRANSCRIPT</span><small>点击句子跳到这里并继续播放</small></button>${transcriptLinesTemplate(current, mock)}</div>`;
  }

  function randomPick(list, count) {
    return [...list].sort(() => Math.random() - 0.5).slice(0, count);
  }
  function randomPickTotal(list, target) {
    const candidates = [...list].sort(() => Math.random() - 0.5);
    function search(start, remaining, picked) {
      if (remaining === 0) return picked;
      for (let index = start; index < candidates.length; index += 1) {
        const item = candidates[index];
        const size = item.questions?.length || 0;
        if (size > remaining) continue;
        const result = search(index + 1, remaining - size, [...picked, item]);
        if (result) return result;
      }
      return null;
    }
    return search(0, target, []) || [];
  }
  function createMock() {
    const source = mockTasks();
    const selected = [
      ...randomPickTotal(source.filter((item) => item.section === "Sec A"), 8),
      ...randomPickTotal(source.filter((item) => item.section === "Sec B"), 7),
      ...randomPickTotal(source.filter((item) => item.section === "Sec C"), 10)
    ];
    let number = 1;
    const groups = selected.map((item, index) => {
      const sourcePaper = data.papers.find((paperItem) => paperItem.tasks.some((taskItem) => taskItem.id === item.id));
      return {
        ...item,
        mockId: `${item.id}-${Date.now()}-${index}`,
        sourcePaper: sourcePaper?.title || "真题",
        groupNumber: index + 1,
        questions: item.questions.map((question) => ({ ...question, number: number++ }))
      };
    });
    state.mock = { groups, answers: {}, highlights: {}, submitted: false, score: 0, correct: 0, bySection: {} };
    state.mock.audioStatus = `\u6b63\u5728\u62fc\u63a5 ${state.mock.groups.length} \u6bb5\u97f3\u9891\uff0c\u8bf7\u7a0d\u5019\u2026`;
    state.screen = "mock";
    render();
  }
  function mockTotalQuestions() { return state.mock.groups.reduce((sum, group) => sum + group.questions.length, 0); }
  function mockAnswersCount() { return Object.keys(state.mock.answers).length; }
  function mockWeight(section) { return section === "Sec C" ? 14 : 7; }
  function mockSectionName(section) { return section === "Sec A" ? "第一部分 · 长对话" : section === "Sec B" ? "第二部分 · 听力篇章" : "第三部分 · 讲座 / 讲话"; }
  function mockTemplate() {
    const mock = state.mock;
    const total = mockTotalQuestions();
    const answered = mockAnswersCount();
    const summary = mock.submitted ? `<section class="score-summary"><div class="score-big">${mock.score}<small> / 249 分</small></div><p>本套模拟已完成 · ${mock.correct} / ${total} 题回答正确</p><div class="score-breakdown"><span>第一部分：${mock.bySection["Sec A"]?.score || 0} / 56</span><span>第二部分：${mock.bySection["Sec B"]?.score || 0} / 49</span><span>第三部分：${mock.bySection["Sec C"]?.score || 0} / 140</span></div></section>` : "";
    return `${header("mock", "随机模拟练习")}<main class="mock-page"><div class="mock-heading"><div><div class="eyebrow" style="color:var(--teal)">CET-6 · RANDOM MOCK</div><h1>随机模拟练习</h1><p>从历年真题随机抽取 7 组，连续完成全部 25 题后统一评分。</p></div><div class="mock-actions"><button class="button ghost" data-action="mock-new">换一套</button><button class="button light" data-action="home">返回真题</button></div></div>${summary}<div class="mock-stats"><div class="mock-stat"><strong>25</strong><span>听力题总数</span></div><div class="mock-stat"><strong>8 × 7</strong><span>第一部分 · 56分</span></div><div class="mock-stat"><strong>7 × 7</strong><span>第二部分 · 49分</span></div><div class="mock-stat"><strong>10 × 14</strong><span>第三部分 · 140分</span></div></div>${mock.groups.map(mockGroupTemplate).join("")}<div class="mock-submit"><div><strong>整套模拟</strong><p>已作答 ${answered} / ${total} 题${mock.submitted ? " · 可重新提交" : " · 做完全部题目后交卷"}</p></div><button class="button" data-action="submit-mock" ${!mock.submitted && answered < total ? "disabled" : ""}>${mock.submitted ? "重新评分" : "交卷并评分"}</button></div></main>`;
  }
  function mockGroupTemplate(group) {
    const answers = state.mock.answers;
    return `<section class="mock-group" id="mock-group-${group.groupNumber}"><div class="mock-group-head"><div><p>第 ${group.groupNumber} 组 · ${mockSectionName(group.section)}</p><h2>${esc(group.sourcePaper)} / ${esc(group.title)}</h2></div><span class="score-pill">每题 ${mockWeight(group.section)} 分</span></div><div class="audio-card"><div class="audio-card-top"><div><div class="audio-label">MOCK AUDIO · ${esc(group.section)}</div><h2>Questions ${group.questions[0]?.number || ""} to ${group.questions.at(-1)?.number || ""}</h2><p>${esc(group.context)}</p></div><span class="audio-icon">◖◗</span></div><audio controls preload="metadata" data-mock-audio="${group.mockId}" src="${esc(group.audio)}"></audio></div><section class="question-panel"><div class="question-panel-head"><div><h2>${mockSectionName(group.section)}</h2><span>${group.questions.length} 道题 · 每题 ${mockWeight(group.section)} 分</span></div><span>${state.mock.submitted ? "已评分" : "请作答"}</span></div>${group.questions.map((question) => mockQuestionTemplate(question, group, answers)).join("")}</section>${state.mock.submitted ? transcriptTemplate(group, `mock-transcript-${group.groupNumber}`, true) : ""}</section>`;
  }
  function mockQuestionTemplate(question, group, answers) {
    const id = `${group.mockId}-${question.number}`;
    const selected = answers[id];
    return `<article class="question" data-mock-question="${id}"><div class="question-stem"><span class="question-no">${question.number}</span><p>${esc(question.stem)}</p></div><div class="options">${Object.entries(question.options).map(([letter, text]) => { const chosen = selected === letter; const cls = state.mock.submitted ? (letter === question.answer ? "is-correct" : chosen ? "is-wrong" : "") : chosen ? "is-selected" : ""; return `<label class="option ${cls}" data-highlight-question="${question.number}" data-highlight-option="${letter}"><input type="radio" name="mock-${id}" value="${letter}" data-mock-answer="${id}" ${chosen ? "checked" : ""}><span><b>${letter}.</b> ${renderOptionText(text, getMockHighlightValues(id, letter))}</span></label>`; }).join("")}</div>${state.mock.submitted ? `<div class="result-line ${selected === question.answer ? "good" : "bad"}">${selected === question.answer ? "✓ 回答正确" : `✕ 正确答案是 ${question.answer}${selected ? `，你的选择是 ${selected}` : "，本题未作答"}`}</div>` : ""}</article>`;
  }

  function recordMockWrongAnswers(mock, submittedAt) {
    const items = [];
    for (const group of mock.groups) {
      for (const question of group.questions) {
        const selected = mock.answers[group.mockId + '-' + question.number];
        if (selected === question.answer) continue;
        items.push({
          id: mock.id + '-' + group.groupNumber + '-' + question.number,
          sourcePaper: group.sourcePaper,
          sourcePaperId: group.sourcePaperId,
          sourceTaskId: group.id,
          taskTitle: group.title,
          section: group.section,
          groupNumber: group.groupNumber,
          questionNumber: question.number,
          sourceQuestionNumber: question.sourceNumber ?? question.number,
          stem: question.stem,
          answer: question.answer,
          chosen: selected || '未作答'
        });
      }
    }
    const previous = Array.isArray(saved[mockWrongStorageKey]) ? saved[mockWrongStorageKey] : [];
    const next = previous.filter((set) => set.id !== mock.id);
    next.push({
      id: mock.id,
      source: '模拟组卷',
      submittedAt,
      score: mock.score,
      correct: mock.correct,
      bySection: mock.bySection,
      groups: mock.groups,
      answers: { ...mock.answers },
      highlights: mock.highlights || {},
      items,
      deletedIds: []
    });
    saved[mockWrongStorageKey] = next;
  }

  function submitMock() {
    const mock = state.mock;
    const bySection = {};
    let score = 0;
    let correct = 0;
    for (const group of mock.groups) {
      const section = bySection[group.section] || { score: 0, total: 0, correct: 0 };
      for (const question of group.questions) {
        const selected = mock.answers[`${group.mockId}-${question.number}`];
        const weight = mockWeight(group.section);
        section.total += weight;
        if (selected === question.answer) { score += weight; section.score += weight; section.correct += 1; correct += 1; }
      }
      bySection[group.section] = section;
    }
    mock.score = score;
    mock.correct = correct;
    mock.bySection = bySection;
    const submittedAt = Date.now();
    recordMockWrongAnswers(mock, submittedAt);
    mock.submittedAt = submittedAt;
    mock.submitted = true;
    persist();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function realWrongGroups() {
    const groups = new Map();
    wrongItems().forEach((item) => {
      const id = item.paperId + "::" + item.taskId + "::" + item.submittedAt;
      if (!groups.has(id)) groups.set(id, { id, type: "real", title: item.paperTitle + " · " + item.taskTitle, subtitle: "真题练习", submittedAt: item.submittedAt, items: [] });
      groups.get(id).items.push(item);
    });
    return [...groups.values()].sort((a, b) => Number(b.submittedAt) - Number(a.submittedAt));
  }

  function mockWrongGroups() {
    const sets = Array.isArray(saved[mockWrongStorageKey]) ? saved[mockWrongStorageKey] : [];
    const activeItems = mockWrongItems();
    return sets.map((set) => {
      const items = activeItems.filter((item) => item.setId === set.id);
      if (!items.length) return null;
      return {
        id: set.id,
        type: 'mock',
        title: '随机模拟组卷',
        subtitle: '模拟组卷',
        submittedAt: set.submittedAt,
        items,
        history: set
      };
    }).filter(Boolean).sort((a, b) => Number(b.submittedAt) - Number(a.submittedAt));
  }
  function wrongGroupById(type, id) {
    return (type === "mock" ? mockWrongGroups() : realWrongGroups()).find((group) => group.id === id) || null;
  }
  function wrongSetCardTemplate(group) {
    return '<button type="button" class="wrong-set-card" data-action="open-wrong-group" data-wrong-group-type="' + group.type + '" data-wrong-group-id="' + esc(group.id) + '">' +
      '<div><div class="wrong-source-tag ' + (group.type === "mock" ? "mock" : "") + '">' + esc(group.subtitle) + '</div><h3>' + esc(group.title) + '</h3><p>提交时间：' + esc(formatReviewTime(group.submittedAt)) + '</p></div>' +
      '<span class="wrong-set-count">' + group.items.length + ' 道错题 <b>›</b></span></button>';
  }
  function wrongItemCardTemplate(item, type) {
    const isMock = type === "mock";
    const paperId = isMock ? item.sourcePaperId : item.paperId;
    const taskId = isMock ? item.sourceTaskId : item.taskId;
    const questionNumber = isMock ? item.sourceQuestionNumber : item.question.number;
    const locateAttrs = paperId && taskId && questionNumber != null ? ' data-action="locate-wrong" data-locate-paper="' + esc(paperId) + '" data-locate-task="' + esc(taskId) + '" data-locate-question="' + esc(questionNumber) + '"' : "";
    const sourceAttrs = paperId && taskId && questionNumber != null ? ' data-wrong-paper="' + esc(paperId) + '" data-wrong-task="' + esc(taskId) + '" data-wrong-question="' + esc(questionNumber) + '"' : "";
    const deleteAttrs = isMock ? ' data-mock-set-id="' + esc(item.setId) + '" data-mock-wrong-id="' + esc(item.id) + '"' : "";
    const number = isMock ? item.questionNumber : item.question.number;
    const stem = isMock ? item.stem : item.question.stem;
    const answer = isMock ? item.answer : item.question.answer;
    const source = isMock ? item.sourcePaper + " · " + item.taskTitle + " · " + mockSectionName(item.section) : item.paperTitle + " · " + item.taskTitle;
    return '<button type="button" class="wrong-item-card wrong-card" ' + locateAttrs + sourceAttrs + deleteAttrs + '><div><div class="wrong-source-tag ' + (isMock ? "mock" : "") + '">' + (isMock ? "模拟组卷错题" : "真题练习错题") + '</div><h3>' + esc(number) + '. ' + esc(stem) + '</h3><p>' + esc(source) + '</p></div><span class="wrong-meta"><span class="wrong-answer">你的答案：' + esc(item.chosen) + '</span><span class="wrong-time">' + (isMock ? "组卷时间：" : "练习时间：") + esc(formatReviewTime(item.submittedAt)) + '</span><span>正确：' + esc(answer) + '</span></span></button>';
  }
  function wrongSectionTemplate(title, subtitle, groups) {
    const cards = groups.map(wrongSetCardTemplate).join("");
    return '<section class="wrong-section"><div class="wrong-section-head"><div><div class="eyebrow" style="color:var(--teal)">' + esc(subtitle) + '</div><h2>' + esc(title) + '</h2></div><strong>' + groups.length + ' 套</strong></div>' + (groups.length ? cards : '<div class="empty">这一部分暂时没有错题</div>') + '</section>';
  }



  function mockHistoryQuestionTemplate(question, group, set) {
    const id = group.mockId + '-' + question.number;
    const selected = set.answers?.[id];
    const status = selected === question.answer ? 'good' : 'bad';
    const wrongItem = (set.items || []).find((item) => item.groupNumber === group.groupNumber && Number(item.questionNumber) === Number(question.number));
    const wrongAttrs = wrongItem ? ' mock-history-wrong-item data-mock-set-id=' + esc(set.id) + ' data-mock-wrong-id=' + esc(wrongItem.id) : '';
    return '<article class=question' + wrongAttrs + ' data-mock-question=' + esc(id) + '><div class=question-stem><span class=question-no>' + esc(question.number) + '</span><p>' + esc(question.stem) + '</p></div><div class=options>' +
      Object.entries(question.options || {}).map(([letter, text]) => {
        const chosen = selected === letter;
        const cls = letter === question.answer ? 'is-correct' : chosen ? 'is-wrong' : '';
        return '<div class=option ' + cls + ' data-highlight-question=' + esc(question.number) + ' data-highlight-option=' + esc(letter) + '><span><b>' + esc(letter) + '.</b> ' + renderOptionText(text, getMockHighlightValues(id, letter, set)) + '</span></div>';
      }).join('') +
      '</div><div class=result-line ' + status + '>' + (selected === question.answer ? '✓ 回答正确' : '✕ 正确答案是 ' + esc(question.answer) + (selected ? '，你的选择是 ' + esc(selected) : '，本题未作答')) + '</div></article>';
  }
  function mockHistoryGroupTemplate(group, set) {
    return '<section class=mock-history-group><div class=mock-group-head><div><p>第 ' + esc(group.groupNumber) + ' 组 · ' + esc(mockSectionName(group.section)) + '</p><h2>' + esc(group.sourcePaper || '真题') + ' / ' + esc(group.title) + '</h2></div><span class=score-pill>每题 ' + mockWeight(group.section) + ' 分</span></div><section class=question-panel><div class=question-panel-head><div><h2>' + esc(mockSectionName(group.section)) + '</h2><span>' + group.questions.length + ' 道题</span></div><span>已完成</span></div>' + group.questions.map((question) => mockHistoryQuestionTemplate(question, group, set)).join('') + '</section></section>';
  }
  function mockHistoryDetailTemplate(group) {
    const set = group.history;
    const score = Number.isFinite(Number(set.score)) ? set.score + ' / 249 分' : '已完成';
    const breakdown = Object.entries(set.bySection || {}).map(([section, info]) => '<span>' + esc(mockSectionName(section)) + '：' + esc(info.score || 0) + ' 分</span>').join('');
    return header('wrong', '错题回顾') +
      '<main class=content><button type=button class=wrong-back data-action=wrong-back>← 返回错题整套列表</button><div class=wrong-header wrong-detail-header><div class=eyebrow style=color:var(--teal)>模拟组卷完整记录</div><h1>随机模拟组卷</h1><p>提交时间：' + esc(formatReviewTime(set.submittedAt)) + ' · 得分：' + esc(score) + ' · 错题：' + group.items.length + ' 道</p><div class=mock-history-summary>' + breakdown + '</div></div><div class=mock-history-list>' + set.groups.map((item) => mockHistoryGroupTemplate(item, set)).join('') + '</div></main>';
  }
  function wrongDetailTemplate(group) {
    if (group.type === 'mock' && group.history?.groups?.length) return mockHistoryDetailTemplate(group);
    return header('wrong', '错题回顾') +
      '<main class=content><button type=button class=wrong-back data-action=wrong-back>← 返回错题整套列表</button><div class=wrong-header wrong-detail-header><div class=eyebrow style=color:var(--teal)>' + esc(group.subtitle) + '</div><h1>' + esc(group.title) + '</h1><p>提交时间：' + esc(formatReviewTime(group.submittedAt)) + ' · 共 ' + group.items.length + ' 道错题；点击题目定位到真题原题。</p></div><div class=wrong-detail-list>' + group.items.map((item) => wrongItemCardTemplate(item, group.type)).join('') + '</div></main>';
  }
  function wrongTemplate() {
    if (state.wrongGroup) {
      const group = wrongGroupById(state.wrongGroup.type, state.wrongGroup.id);
      if (group) return wrongDetailTemplate(group);
      state.wrongGroup = null;
    }
    const realGroups = realWrongGroups();
    const mockGroups = mockWrongGroups();
    const total = realGroups.reduce((sum, group) => sum + group.items.length, 0) + mockGroups.reduce((sum, group) => sum + group.items.length, 0);
    return header("wrong", "错题回顾") +
      '<main class="content"><div class="wrong-header"><div class="eyebrow" style="color:var(--teal)">REVIEW YOUR MISTAKES</div><h1>错题回顾</h1><p>' +
      (total ? '共 ' + total + ' 道错题；先选择整套记录，再点击具体题目定位到真题原题。' : '完成真题练习或模拟组卷并提交后，错题会自动出现在这里。') +
      '</p></div><div class="wrong-sections">' +
      wrongSectionTemplate("真题练习错题", "REAL PAPER PRACTICE", realGroups) +
      wrongSectionTemplate("模拟组卷错题", "RANDOM MOCK REVIEW", mockGroups) +
      '</div></main>';
  }

  function openPaper(paperId, taskId = null, focusQuestion = null, transcript = false, wrongReturn = null) {
    state.paperId = paperId;
    state.taskIndex = taskId ? paper().tasks.findIndex((item) => String(item.id) === String(taskId)) : 0;
    if (state.taskIndex < 0) state.taskIndex = 0;
    state.submitted = Boolean(recordFor(paperId).completed?.[paper().tasks[state.taskIndex].id]);
    state.focusQuestion = focusQuestion ? Number(focusQuestion) : null;
    state.focusTranscript = transcript;
    state.wrongReturn = wrongReturn ? { ...wrongReturn } : null;
    state.screen = "practice";
    render();
    if (state.focusQuestion || state.focusTranscript) setTimeout(focusCurrent, 80);
  }
  function focusCurrent() {
    if (state.focusTranscript) document.getElementById("transcript-current")?.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (state.focusQuestion) app.querySelector(`[data-question-number="${state.focusQuestion}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    state.focusQuestion = null;
    state.focusTranscript = false;
  }
  function focusTranscript() {
    const audio = app.querySelector("#audio-player");
    if (audio) { audio.currentTime = 0; audio.play().catch(() => {}); }
    document.getElementById("transcript-current")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function focusMockTranscript(eventTarget) {
    const id = eventTarget.dataset.mockAudioId;
    const audio = app.querySelector(`[data-mock-audio="${id}"]`);
    if (audio) { audio.currentTime = 0; audio.play().catch(() => {}); }
    eventTarget.closest(".transcript")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function render() {
    if (state.screen === "mock") app.innerHTML = mockTemplate();
    else if (state.screen === "wrong") app.innerHTML = wrongTemplate();
    else if (state.screen === "practice") app.innerHTML = practiceTemplate();
    else app.innerHTML = homeTemplate();
  }

  app.addEventListener("input", (event) => {
    if (!event.target.matches("[data-filter]")) return;
    state.filter = event.target.value;
    render();
    const input = app.querySelector("[data-filter]");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
  app.addEventListener("change", (event) => {
    const input = event.target.closest("[data-answer]");
    if (input && state.screen === "practice") {
      if (!state.answers[task().id]) state.answers[task().id] = {};
      state.answers[task().id][input.dataset.answer] = input.value;
      app.querySelectorAll(`[data-answer="${input.dataset.answer}"]`).forEach((node) => node.closest("label")?.classList.toggle("is-selected", node.checked));
      const counter = app.querySelector(".question-panel-head span");
      if (counter) counter.textContent = `已选择 ${Object.keys(state.answers[task().id]).length} / ${task().questions.length}`;
      return;
    }
    const mockInput = event.target.closest("[data-mock-answer]");
    if (mockInput && state.mock) {
      state.mock.answers[mockInput.dataset.mockAnswer] = mockInput.value;
      app.querySelectorAll(`[data-mock-answer="${mockInput.dataset.mockAnswer}"]`).forEach((node) => node.closest("label")?.classList.toggle("is-selected", node.checked));
      const count = app.querySelector(".mock-submit p");
      if (count) count.textContent = `已作答 ${mockAnswersCount()} / ${mockTotalQuestions()} 题 · 做完全部题目后交卷`;
      const submit = app.querySelector('[data-action="submit-mock"]');
      if (submit && !state.mock.submitted) submit.disabled = mockAnswersCount() < mockTotalQuestions();
    }
  });
  app.addEventListener("change", (event) => {
    const input = event.target.closest("[data-restore-file]");
    if (!input || !input.files?.[0]) return;
    const file = input.files[0];
    input.value = "";
    restoreProgressFile(file);
  });
  function expandToWord(range) {
    if (range.startContainer !== range.endContainer || range.startContainer.nodeType !== 3) return range;
    const text = range.startContainer.nodeValue || "";
    const isWordChar = (char) => /[\p{L}\p{N}_'-]/u.test(char);
    let start = range.startOffset;
    let end = range.endOffset;
    if (!text.slice(start, end).trim()) return range;
    while (start > 0 && isWordChar(text[start - 1])) start -= 1;
    while (end < text.length && isWordChar(text[end])) end += 1;
    const expanded = range.cloneRange();
    expanded.setStart(range.startContainer, start);
    expanded.setEnd(range.endContainer, end);
    return expanded;
  }

  function getRealHighlightValues(questionNumber, letter) {
    const currentTask = task();
    return saved[state.paperId]?.highlights?.[currentTask?.id]?.[String(questionNumber)]?.[letter] || [];
  }
  function getMockHighlightValues(mockQuestionId, letter, source = state.mock) {
    return source?.highlights?.[mockQuestionId]?.[letter] || [];
  }
  function renderOptionText(text, values = []) {
    const source = String(text ?? '');
    const ranges = [];
    for (const rawValue of Array.isArray(values) ? values : []) {
      const value = typeof rawValue === 'string' ? rawValue : rawValue?.text;
      if (!value) continue;
      let start = source.indexOf(value);
      while (start >= 0 && ranges.some((range) => start < range.end && start + value.length > range.start)) {
        start = source.indexOf(value, start + 1);
      }
      if (start >= 0) ranges.push({ start, end: start + value.length });
    }
    ranges.sort((a, b) => a.start - b.start);
    if (!ranges.length) return esc(source);
    let cursor = 0;
    return ranges.map((range) => {
      const before = esc(source.slice(cursor, range.start));
      const marked = '<mark class=user-highlight>' + esc(source.slice(range.start, range.end)) + '</mark>';
      cursor = range.end;
      return before + marked;
    }).join('') + esc(source.slice(cursor));
  }
  function highlightBucketFor(option) {
    const questionNumber = option.dataset.highlightQuestion;
    const letter = option.dataset.highlightOption;
    if (!questionNumber || !letter) return null;
    const mockQuestion = option.closest('[data-mock-question]');
    if (mockQuestion) {
      if (!state.mock) return null;
      state.mock.highlights = state.mock.highlights || {};
      state.mock.highlights[mockQuestion.dataset.mockQuestion] = state.mock.highlights[mockQuestion.dataset.mockQuestion] || {};
      state.mock.highlights[mockQuestion.dataset.mockQuestion][letter] = state.mock.highlights[mockQuestion.dataset.mockQuestion][letter] || [];
      return { values: state.mock.highlights[mockQuestion.dataset.mockQuestion][letter], mock: true };
    }
    const currentTask = task();
    if (!currentTask || !state.paperId) return null;
    if (!saved[state.paperId]) saved[state.paperId] = { completed: {}, best: 0 };
    const record = saved[state.paperId];
    record.highlights = record.highlights || {};
    record.highlights[currentTask.id] = record.highlights[currentTask.id] || {};
    record.highlights[currentTask.id][String(questionNumber)] = record.highlights[currentTask.id][String(questionNumber)] || {};
    record.highlights[currentTask.id][String(questionNumber)][letter] = record.highlights[currentTask.id][String(questionNumber)][letter] || [];
    return { values: record.highlights[currentTask.id][String(questionNumber)][letter], mock: false };
  }
  function saveMockHighlights() {
    if (!state.mock?.submitted) return;
    const sets = Array.isArray(saved[mockWrongStorageKey]) ? saved[mockWrongStorageKey] : [];
    const target = sets.find((set) => set.id === state.mock.id);
    if (!target) return;
    target.highlights = state.mock.highlights || {};
    saved[mockWrongStorageKey] = sets;
    persist();
  }
  function markOptionSelection(selection) {
    if (state.screen !== 'practice' && state.screen !== 'mock') return false;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !selection.toString().trim()) return false;
    const range = selection.getRangeAt(0);
    const optionFor = (node) => {
      const element = node.nodeType === 1 ? node : node.parentElement;
      return element?.closest('.option');
    };
    const startOption = optionFor(range.startContainer);
    const endOption = optionFor(range.endContainer);
    if (!startOption || startOption !== endOption) return false;
    const highlightStore = highlightBucketFor(startOption);
    if (!highlightStore) return false;
    const markFor = (node) => {
      const element = node.nodeType === 1 ? node : node.parentElement;
      return element?.closest('.user-highlight');
    };
    const startMark = markFor(range.startContainer);
    const endMark = markFor(range.endContainer);
    if (startMark && startMark === endMark) {
      const highlightedText = (startMark.textContent || '').trim();
      const index = highlightStore.values.indexOf(highlightedText);
      if (index >= 0) highlightStore.values.splice(index, 1);
      const parent = startMark.parentNode;
      if (parent) {
        while (startMark.firstChild) parent.insertBefore(startMark.firstChild, startMark);
        startMark.remove();
        if (highlightStore.mock) saveMockHighlights();
        else persist();
        if (typeof selection.removeAllRanges === 'function') selection.removeAllRanges();
        return true;
      }
    }
    if (startMark || endMark) return false;
    const wordRange = expandToWord(range);
    const markedText = wordRange.toString().trim();
    if (!markedText) return false;
    const mark = document.createElement('mark');
    mark.className = 'user-highlight';
    try {
      mark.appendChild(wordRange.extractContents());
      wordRange.insertNode(mark);
      if (!highlightStore.values.includes(markedText)) highlightStore.values.push(markedText);
      if (highlightStore.mock) saveMockHighlights();
      else persist();
      if (typeof selection.removeAllRanges === 'function') selection.removeAllRanges();
      return true;
    } catch (error) {
      if (typeof selection.removeAllRanges === 'function') selection.removeAllRanges();
      return false;
    }
  }
  app.addEventListener("click", (event) => {
    if (state.suppressOptionClick) {
      event.preventDefault();
      state.suppressOptionClick = false;
      return;
    }
    if (event.target.closest(".option") && markOptionSelection(window.getSelection())) {
      event.preventDefault();
      return;
    }
    const transcriptLine = event.target.closest("[data-transcript-line]");
    if (transcriptLine) return seekTranscriptLine(transcriptLine);
    const paperButton = event.target.closest("[data-paper]");
    if (paperButton) return openPaper(paperButton.dataset.paper);
    const sidePaper = event.target.closest("[data-side-paper]");
    if (sidePaper) return openPaper(sidePaper.dataset.sidePaper);
    const wrongButton = event.target.closest("[data-wrong-paper]");
    if (wrongButton) return openPaper(wrongButton.dataset.wrongPaper, wrongButton.dataset.wrongTask, wrongButton.dataset.wrongQuestion, false, state.wrongGroup ? { ...state.wrongGroup } : null);
    const actionTarget = event.target.closest("[data-action]");
    const action = actionTarget?.dataset.action;
    if (!action) return;
    if (action === "home") { state.screen = "home"; state.submitted = false; render(); }
    if (action === "open-mock") createMock();
    if (action === "mock-new") createMock();
    if (action === "toggle-mock-questions" && state.mock) {
      const audio = app.querySelector('#mock-audio-player');
      const currentTime = audio?.currentTime || 0;
      const playing = Boolean(audio && !audio.paused);
      state.mock.showQuestions = state.mock.showQuestions === false;
      render();
      const nextAudio = app.querySelector('#mock-audio-player');
      if (nextAudio) {
        nextAudio.currentTime = currentTime;
        if (playing) nextAudio.play().catch(() => {});
      }
      return;
    }
    if (action === "open-wrong") {
      state.wrongGroup = null;
      state.wrongReturn = null;
      state.screen = "wrong";
      render();
    }
    if (action === "open-wrong-group") {
      state.wrongGroup = {
        type: actionTarget.dataset.wrongGroupType,
        id: actionTarget.dataset.wrongGroupId
      };
      state.screen = "wrong";
      render();
      return;
    }
    if (action === "wrong-back") {
      state.wrongGroup = null;
      render();
      return;
    }
    if (action === "return-wrong") {
      const returnGroup = state.wrongReturn;
      state.wrongReturn = null;
      state.wrongGroup = returnGroup ? { ...returnGroup } : null;
      state.screen = "wrong";
      render();
      return;
    }
    if (action === "locate-wrong") {
      openPaper(actionTarget.dataset.locatePaper, actionTarget.dataset.locateTask, actionTarget.dataset.locateQuestion);
      return;
    }

    if (action === "clear-task") {
      clearTaskProgress(state.paperId, actionTarget.dataset.clearTask);
      return;
    }
    if (action === "cloud-auth") {
      const sync = window.CET_FIREBASE_SYNC;
      if (state.cloudUser) sync?.signOut().catch(handleCloudError);
      else showCloudAuthModal("signin");
    }
    if (action === "toggle-sidebar") { state.sidebarCollapsed = !state.sidebarCollapsed; render(); }
    if (action === "submit-task") {
      const current = task();
      const answers = currentAnswers();
      const score = current.questions.reduce((sum, question) => sum + (answers[question.number] === question.answer ? 1 : 0), 0);
      if (!saved[state.paperId]) saved[state.paperId] = { completed: {}, best: 0 };
      saved[state.paperId].completed[current.id] = { score, total: current.questions.length, answers: { ...answers }, at: Date.now() };
      saved[state.paperId].deletedWrong = (saved[state.paperId].deletedWrong || []).filter((key) => !key.startsWith(`${current.id}::`));
      saved[state.paperId].best = Math.max(saved[state.paperId].best || 0, score);
      persist();
      state.submitted = true;
      render();
    }
    if (action === "reset-task") { state.answers[task().id] = {}; state.submitted = false; render(); }
    if (action === "previous" && state.taskIndex > 0) { state.taskIndex -= 1; state.submitted = false; render(); }
    if (action === "next" && state.taskIndex < paper().tasks.length - 1) { state.taskIndex += 1; state.submitted = false; render(); }
    if (action === "focus-transcript") focusTranscript();
    if (action === "focus-mock-transcript") focusMockTranscript(actionTarget);
    if (action === "submit-mock") submitMock();
  });
  app.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !event.target.closest(".option span")) return;
    state.optionPointer = { x: event.clientX, y: event.clientY };
    state.optionDragging = false;
  });
  app.addEventListener("mousemove", (event) => {
    if (!state.optionPointer) return;
    const moved = Math.abs(event.clientX - state.optionPointer.x) + Math.abs(event.clientY - state.optionPointer.y);
    if (moved > 5) state.optionDragging = true;
  });
  app.addEventListener("mouseup", (event) => {
    if (event.button !== 0) return;
    const dragged = state.optionDragging;
    state.optionPointer = null;
    state.optionDragging = false;
    const selection = window.getSelection();
    if (dragged) {
      state.suppressOptionClick = true;
      if (!markOptionSelection(selection)) {
        window.setTimeout(() => markOptionSelection(window.getSelection()), 0);
      }
    } else if (markOptionSelection(selection)) {
      state.suppressOptionClick = true;
    }
  });
  app.addEventListener("contextmenu", (event) => {
    const card = event.target.closest(".wrong-set-card, .wrong-item-card, .mock-history-wrong-item");
    if (state.screen === "wrong" && card) showWrongMenu(event, card);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".wrong-context-menu")) closeWrongMenu();
  });

  // Mock mode is prepared first, then started separately so the user sees
  // the random paper only after pressing “开始考试”.
  function disposeMockAudio() {
    if (state.mock?.audioUrl) URL.revokeObjectURL(state.mock.audioUrl);
  }
  function createMock() {
    disposeMockAudio();
    const source = mockTasks();
    const selected = [
      ...randomPickTotal(source.filter((item) => item.section === "Sec A"), 8),
      ...randomPickTotal(source.filter((item) => item.section === "Sec B"), 7),
      ...randomPickTotal(source.filter((item) => item.section === "Sec C"), 10)
    ];
    let number = 1;
    const createdAt = Date.now();
    const groups = selected.map((item, index) => {
      const sourcePaper = data.papers.find((paperItem) => paperItem.tasks.some((taskItem) => taskItem.id === item.id));
      return {
        ...item,
        mockId: `${item.id}-${createdAt}-${index}`,
        sourcePaper: sourcePaper?.title || "真题",
        sourcePaperId: sourcePaper?.id,
        groupNumber: index + 1,
        questions: item.questions.map((question) => ({ ...question, sourceNumber: question.number, number: number++ }))
      };
    });
    state.mock = { id: `mock-${createdAt}`, createdAt, groups, answers: {}, highlights: {}, submitted: false, started: false, audioUrl: "", audioSegments: [], audioMode: "combined", audioStatus: "" , score: 0, correct: 0, bySection: {} };
    state.screen = "mock-setup";
    render();
  }
  function mockSetupTemplate() {
    const mock = state.mock;
    return `${header("mock", "随机模拟练习")}<main class="mock-page"><div class="mock-heading"><div><div class="eyebrow" style="color:var(--teal)">CET-6 · RANDOM MOCK</div><h1>随机模拟练习</h1><p>一键从历年真题中随机组卷，确认后开始一场完整听力考试。</p></div><div class="mock-actions"><button class="button ghost" data-action="mock-new">一键随机组卷</button><button class="button light" data-action="home">返回真题</button></div></div><section class="mock-setup"><div class="mock-setup-title"><div><strong>本次试卷已生成</strong><p>共 7 组听力、25 道题；考试开始后只保留一个连续音源。</p></div><span class="score-pill">满分 249 分</span></div><div class="mock-source-list">${mock.groups.map((group) => `<div class="mock-source-item"><span>第 ${group.groupNumber} 组 · ${mockSectionName(group.section)}</span><strong>${esc(group.sourcePaper)} / ${esc(group.title)}</strong><small>${group.questions.length} 题 · 每题 ${mockWeight(group.section)} 分</small></div>`).join("")}</div><button class="button primary mock-start" data-action="start-mock">开始考试 →</button></section></main>`;
  }
  function startMock() {
    if (!state.mock) return createMock();
    state.mock.started = true;
    state.mock.showQuestions = false;
    state.mock.audioStatus = `\u6b63\u5728\u62fc\u63a5 ${state.mock.groups.length} \u6bb5\u97f3\u9891\uff0c\u8bf7\u7a0d\u5019\u2026`;
    state.mock.audioStatus = "正在拼接 7 段音频，请稍候…";
    state.mock.audioStatus = `\u6b63\u5728\u62fc\u63a5 ${state.mock.groups.length} \u6bb5\u97f3\u9891\uff0c\u8bf7\u7a0d\u5019\u2026`;
    state.screen = "mock";
    render();
    prepareMockAudio();
  }
  function audioBufferToWav(buffer) {
    const channels = Math.min(2, buffer.numberOfChannels);
    const bytesPerSample = 2;
    const dataLength = buffer.length * channels * bytesPerSample;
    const output = new ArrayBuffer(44 + dataLength);
    const view = new DataView(output);
    const write = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    write(0, "RIFF"); view.setUint32(4, 36 + dataLength, true); write(8, "WAVE"); write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true); view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, dataLength, true);
    let offset = 44;
    for (let sample = 0; sample < buffer.length; sample += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const value = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[sample]));
        view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([output], { type: "audio/wav" });
  }
  function isMobileAudioDevice() {
    const userAgent = navigator.userAgent || "";
    return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
      || (Number(navigator.maxTouchPoints) > 1 && window.innerWidth <= 900);
  }
  function setMockAudioStatus(mock, text) {
    mock.audioStatus = text;
    if (state.mock !== mock) return;
    const status = app.querySelector("[data-mock-audio-status]");
    if (status) status.textContent = text;
  }
  function groupAudioDuration(group) {
    return Number(group.transcriptTimingMeta?.duration)
      || Number(group.duration)
      || 0;
  }
  function setPlaylistTrack(mock, player, index, autoplay = false, startAt = 0) {
    const group = mock.groups[index];
    if (!group) return false;
    player.pause();
    player.dataset.playlistIndex = String(index);
    player.dataset.playlistRetries = "0";
    player.src = group.audio;
    player.load();
    if (!autoplay) return true;
    let settled = false;
    const playWhenReady = () => {
      if (settled) return;
      settled = true;
      player.removeEventListener("loadedmetadata", playWhenReady);
      player.removeEventListener("canplay", playWhenReady);
      if (startAt > 0) {
        try { player.currentTime = startAt; } catch (error) { /* metadata is still loading */ }
      }
      const promise = player.play();
      if (promise?.catch) promise.catch(() => {
        setMockAudioStatus(mock, "下一段音频已准备好，请点击播放继续整套听力");
      });
    };
    player.addEventListener("loadedmetadata", playWhenReady);
    player.addEventListener("canplay", playWhenReady);
    if (player.readyState >= 1) window.setTimeout(playWhenReady, 0);
    return true;
  }
  function bindMockPlaylist(mock, player) {
    if (player.dataset.playlistBound === "1") return;
    player.dataset.playlistBound = "1";
    player.addEventListener("ended", () => {
      if (state.mock !== mock) return;
      const currentIndex = Number(player.dataset.playlistIndex || 0);
      const nextIndex = currentIndex + 1;
      if (nextIndex >= mock.groups.length) {
        setMockAudioStatus(mock, "整套听力已播放完毕");
        return;
      }
      setMockAudioStatus(mock, "正在播放第 " + (nextIndex + 1) + " / " + mock.groups.length + " 段音频");
      setPlaylistTrack(mock, player, nextIndex, true);
    });
    player.addEventListener("error", () => {
      if (state.mock !== mock) return;
      const index = Number(player.dataset.playlistIndex || 0);
      setMockAudioStatus(mock, "第 " + (index + 1) + " 段音频加载失败，请点击“一键随机组卷”重试");
    });
  }
  function prepareMockPlaylist(mock, player, statusText) {
    mock.audioMode = "playlist";
    mock.audioSegments = [];
    let offset = 0;
    mock.groups.forEach((group) => {
      const duration = groupAudioDuration(group);
      const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
      mock.audioSegments.push({
        mockId: group.mockId,
        start: offset,
        end: offset + safeDuration,
        audio: group.audio
      });
      offset += safeDuration;
    });
    bindMockPlaylist(mock, player);
    setPlaylistTrack(mock, player, 0, false);
    setMockAudioStatus(mock, statusText || "已准备连续播放，点击播放后会自动衔接全部音频");
  }
  async function prepareMockAudio() {
    const mock = state.mock;
    const player = app.querySelector("#mock-audio-player");
    if (!mock || !player) return;
    if (isMobileAudioDevice()) {
      prepareMockPlaylist(mock, player, "手机端已准备连续播放，点击播放后会自动衔接全部音频");
      return;
    }
    let context = null;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("audio-context-unavailable");
      context = new AudioContextClass({ latencyHint: "playback", sampleRate: 44100 });
      if (context.state === "suspended") await context.resume();
      const sampleRate = context.sampleRate;
      const channels = 1;
      const gapSamples = Math.round(sampleRate * 0.6);
      const durations = mock.groups.map(groupAudioDuration);
      if (durations.some((duration) => !Number.isFinite(duration) || duration <= 0)) throw new Error("missing-audio-duration");
      const lengths = durations.map((duration) => Math.max(1, Math.round(duration * sampleRate)));
      const totalLength = lengths.reduce((sum, length) => sum + length, 0) + gapSamples * (mock.groups.length - 1);
      const estimatedBytes = totalLength * channels * 2;
      if (estimatedBytes > 120 * 1024 * 1024) throw new Error("combined-audio-too-large");
      const combined = context.createBuffer(channels, totalLength, sampleRate);
      const segments = [];
      let offset = 0;
      for (let index = 0; index < mock.groups.length; index += 1) {
        const group = mock.groups[index];
        const response = await fetch(group.audio, { cache: "force-cache" });
        if (!response.ok) throw new Error("audio-fetch-" + response.status);
        const bytes = await response.arrayBuffer();
        const buffer = await context.decodeAudioData(bytes);
        const length = lengths[index];
        if (Math.abs(buffer.duration - durations[index]) > 2.5) throw new Error("audio-duration-mismatch");
        segments.push({ mockId: group.mockId, start: offset / sampleRate, end: (offset + length) / sampleRate, audio: group.audio });
        const destination = combined.getChannelData(0);
        const sources = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
        for (let sample = 0; sample < length; sample += 1) {
          const sourceIndex = Math.min(buffer.length - 1, Math.floor(sample * buffer.length / length));
          destination[offset + sample] = sources.reduce((sum, source) => sum + source[sourceIndex], 0) / sources.length;
        }
        offset += length + (index < mock.groups.length - 1 ? gapSamples : 0);
      }
      const url = URL.createObjectURL(audioBufferToWav(combined));
      if (state.mock !== mock || !player.isConnected) {
        URL.revokeObjectURL(url);
        return;
      }
      mock.audioUrl = url;
      mock.audioSegments = segments;
      mock.audioMode = "combined";
      player.src = url;
      player.load();
      setMockAudioStatus(mock, mock.groups.length + " 段音频已拼接为一个连续音源 · 可直接播放");
    } catch (error) {
      if (state.mock !== mock || !player.isConnected) return;
      prepareMockPlaylist(mock, player, "连续音源暂时无法拼接，已切换为单播放器自动连续播放");
      console.warn("Mock audio concatenation fallback", error);
    } finally {
      if (context) {
        try { await context.close(); } catch (closeError) { /* already closed */ }
      }
    }
  }
  function mockTemplate() {
    const mock = state.mock;
    const total = mockTotalQuestions();
    const answered = mockAnswersCount();
    const showQuestions = mock.showQuestions !== false;
    const summary = mock.submitted ? `<section class="score-summary"><div class="score-big">${mock.score}<small> / 249 分</small></div><p>本套模拟已完成 · ${mock.correct} / ${total} 题回答正确</p><div class="score-breakdown"><span>第一部分：${mock.bySection["Sec A"]?.score || 0} / 56</span><span>第二部分：${mock.bySection["Sec B"]?.score || 0} / 49</span><span>第三部分：${mock.bySection["Sec C"]?.score || 0} / 140</span></div></section>` : "";
    return `${header("mock", "随机模拟练习")}<main class="mock-page"><div class="mock-heading"><div><div class="eyebrow" style="color:var(--teal)">CET-6 · RANDOM MOCK</div><h1>随机模拟练习</h1><p>连续完成全部 25 题，最后统一交卷评分。</p></div><div class="mock-actions"><button class="button ghost" data-action="mock-new">一键随机组卷</button><button class="button light" data-action="home">返回真题</button></div></div>${summary}<div class="mock-stats"><div class="mock-stat"><strong>25</strong><span>听力题总数</span></div><div class="mock-stat"><strong>8 × 7</strong><span>第一部分 · 56分</span></div><div class="mock-stat"><strong>7 × 7</strong><span>第二部分 · 49分</span></div><div class="mock-stat"><strong>10 × 14</strong><span>第三部分 · 140分</span></div></div><section class="mock-audio-card"><div><div class="audio-label">ONE AUDIO SOURCE · 连续听力</div><h2>整套模拟音源</h2><p data-mock-audio-status>${esc(mock.audioStatus || "正在准备连续音源…")}</p></div><audio id="mock-audio-player" controls preload="metadata" src="${esc(mock.audioUrl)}"></audio></section><div class="mock-question-visibility"><button class="button light" data-action="toggle-mock-questions">${showQuestions ? "隐藏题目" : "显示题目"}</button><span>${showQuestions ? "题目已显示" : "听力播放中，题目已隐藏"}</span></div>${showQuestions ? mock.groups.map(mockGroupTemplate).join("") : '<div class=mock-questions-hidden>题目已隐藏，点击上方按钮显示题目。</div>'}<div class="mock-submit"><div><strong>整套模拟</strong><p>已作答 ${answered} / ${total} 题${mock.submitted ? " · 可重新评分" : " · 做完全部题目后交卷"}</p></div><button class="button" data-action="submit-mock" ${!mock.submitted && answered < total ? "disabled" : ""}>${mock.submitted ? "重新评分" : "交卷并评分"}</button></div></main>`;
  }
  function mockGroupTemplate(group) {
    const answers = state.mock.answers;
    return `<section class="mock-group" id="mock-group-${group.groupNumber}"><div class="mock-group-head"><div><p>第 ${group.groupNumber} 组 · ${mockSectionName(group.section)}</p><h2>${esc(group.sourcePaper)} / ${esc(group.title)}</h2></div><span class="score-pill">每题 ${mockWeight(group.section)} 分</span></div><section class="question-panel"><div class="question-panel-head"><div><h2>${mockSectionName(group.section)}</h2><span>${group.questions.length} 道题 · 每题 ${mockWeight(group.section)} 分</span></div><span>${state.mock.submitted ? "已评分" : "请作答"}</span></div>${group.questions.map((question) => mockQuestionTemplate(question, group, answers)).join("")}</section>${state.mock.submitted ? transcriptTemplate(group, `mock-transcript-${group.groupNumber}`, true) : ""}</section>`;
  }
  function focusMockTranscript(eventTarget) {
    const id = eventTarget.dataset.mockAudioId;
    const segment = state.mock?.audioSegments?.find((item) => item.mockId === id);
    const audio = app.querySelector("#mock-audio-player");
    if (audio && segment) {
      if (state.mock.audioMode === "combined") {
        audio.currentTime = segment.start;
        audio.play().catch(() => {});
      } else {
        const index = state.mock.groups.findIndex((group) => group.mockId === id);
        bindMockPlaylist(state.mock, audio);
        setPlaylistTrack(state.mock, audio, index, true);
      }
    }
      eventTarget.closest(".transcript")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function setTranscriptActive(container, time) {
    if (!container || !Number.isFinite(time)) return;
    const lines = [...container.querySelectorAll("[data-transcript-line]")];
    let active = lines.find((line) => time >= Number(line.dataset.transcriptStart) && time < Number(line.dataset.transcriptEnd));
    if (!active && lines.length && time >= Number(lines.at(-1).dataset.transcriptStart)) active = lines.at(-1);
    lines.forEach((line) => line.classList.toggle("current-line", line === active));
  }
  function syncTranscriptHighlight(audio) {
    if (!audio) return;
    if (audio.id === "audio-player") {
      setTranscriptActive(app.querySelector("#transcript-current"), audio.currentTime);
      return;
    }
    if (audio.id !== "mock-audio-player" || !state.mock) return;
    const currentTime = audio.currentTime;
    app.querySelectorAll(".mock-transcript[data-transcript-audio-id]").forEach((container) => {
      const id = container.dataset.transcriptAudioId;
      const index = state.mock.groups.findIndex((group) => group.mockId === id);
      const segment = state.mock.audioSegments?.find((item) => item.mockId === id);
      let relative = NaN;
      if (state.mock.audioMode === "combined" && segment && currentTime >= segment.start && currentTime <= segment.end) relative = currentTime - segment.start;
      if (state.mock.audioMode === "playlist" && Number(audio.dataset.playlistIndex) === index) relative = currentTime;
      setTranscriptActive(container, relative);
    });
  }
  function playAudioAt(audio, time) {
    const play = () => {
      const target = Math.max(0, Number(time) || 0);
      audio.pause();
      try { audio.currentTime = target; } catch (error) { /* metadata is still loading */ }
      window.setTimeout(() => {
        try { if (Math.abs(audio.currentTime - target) > 0.35) audio.currentTime = target; } catch (error) { /* media is still loading */ }
        syncTranscriptHighlight(audio);
        audio.play().catch(() => {});
      }, 0);
    };
    if (audio.readyState >= 1) play();
    else audio.addEventListener("loadedmetadata", play, { once: true });
  }
  function seekTranscriptLine(line) {
    const start = Number(line.dataset.transcriptStart);
    if (!Number.isFinite(start)) return;
    const container = line.closest(".transcript");
    const isMock = container?.classList.contains("mock-transcript");
    const audio = app.querySelector(isMock ? "#mock-audio-player" : "#audio-player");
    if (!audio) return;
    if (!isMock) {
      playAudioAt(audio, start);
    } else {
      const id = container.dataset.transcriptAudioId;
      const index = state.mock.groups.findIndex((group) => group.mockId === id);
      const segment = state.mock.audioSegments?.find((item) => item.mockId === id);
      if (state.mock.audioMode === "combined" && segment) playAudioAt(audio, segment.start + start);
      else if (segment) {
        bindMockPlaylist(state.mock, audio);
        setPlaylistTrack(state.mock, audio, index, false);
        playAudioAt(audio, start);
      } else if (state.mock.groups[index]) {
        state.mock.audioMode = "playlist";
        audio.src = state.mock.groups[index].audio;
        audio.dataset.playlistIndex = String(index);
        playAudioAt(audio, start);
      }
    }
    container?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function decorateMockAudio() {
    if (state.screen !== "mock" || !state.mock || state.mock.audioMode !== "playlist") return;
    const player = app.querySelector("#mock-audio-player");
    if (!player || player.dataset.playlistBound === "1") return;
    prepareMockPlaylist(state.mock, player, state.mock.audioStatus || "已准备连续播放，点击播放后会自动衔接全部音频");
  }
  function decorateTranscriptAudio() {
    app.querySelectorAll("[data-transcript-line]").forEach((line) => {
      if (line.dataset.transcriptClickBound) return;
      line.dataset.transcriptClickBound = "1";
      line.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        seekTranscriptLine(line);
      });
    });
    app.querySelectorAll("#audio-player, #mock-audio-player").forEach((audio) => {
      if (audio.dataset.transcriptBound) return;
      audio.dataset.transcriptBound = "1";
      ["timeupdate", "seeking", "loadedmetadata", "play"].forEach((eventName) => audio.addEventListener(eventName, () => syncTranscriptHighlight(audio)));
      syncTranscriptHighlight(audio);
    });
  }
  function decoratePracticeAudio() {
    if (state.screen !== "practice") return;
    const current = task();
    if (!current || current.audioScope !== "whole-paper") return;
    const audio = app.querySelector("#audio-player");
    if (!audio || audio.parentElement.querySelector(".audio-note")) return;
    const note = document.createElement("p");
    note.className = "audio-note";
    note.textContent = current.audioNote || "本地音频为整套录音；题目与原文已按 Section A / B / C 拆分。";
    audio.parentElement.append(note);
  }
  function decorateMockSetup() {
    if (state.screen !== "mock-setup") return;
    const setup = app.querySelector(".mock-setup");
    if (!setup || setup.querySelector(".mock-scope-note")) return;
    const note = document.createElement("p");
    note.className = "mock-scope-note";
    note.textContent = `\u6bcf\u4e2a\u90e8\u5206\u6309 8 / 7 / 10 \u9898\u968f\u673a\u7ec4\u5377\uff1b\u97f3\u9891\u5df2\u5207\u5206\u4e3a\u72ec\u7acb\u7247\u6bb5\uff0c\u5f00\u59cb\u8003\u8bd5\u540e\u4f1a\u62fc\u63a5\u4e3a\u4e00\u4e2a\u8fde\u7eed\u97f3\u6e90\u3002`;
    note.textContent = "随机组卷使用具有精确分段音频的任务；新增的整套录音试卷仍可在真题练习中按 Section A / B / C 使用。";
    setup.insertBefore(note, setup.querySelector(".mock-source-list"));
    note.textContent = `\u6bcf\u4e2a\u90e8\u5206\u6309 8 / 7 / 10 \u9898\u968f\u673a\u7ec4\u5377\uff1b\u97f3\u9891\u5df2\u5207\u5206\u4e3a\u72ec\u7acb\u7247\u6bb5\uff0c\u5f00\u59cb\u8003\u8bd5\u540e\u4f1a\u62fc\u63a5\u4e3a\u4e00\u4e2a\u8fde\u7eed\u97f3\u6e90\u3002`;
    const summary = setup.querySelector(".mock-setup-title p");
    if (summary) summary.textContent = `\u5171 ${state.mock.groups.length} \u7ec4\u542c\u529b\u3001\u0032\u0035 \u9053\u9898\uff1b\u8003\u8bd5\u5f00\u59cb\u540e\u53ea\u4fdd\u7559\u4e00\u4e2a\u8fde\u7eed\u97f3\u6e90\u3002`;
  }
  function decoratePracticeNavigation() {
    if (state.screen !== "practice") return;
    const panel = app.querySelector(".question-panel");
    if (!panel || panel.querySelector(".task-nav-bottom")) return;
    const nav = document.createElement("div");
    nav.className = "task-nav-bottom";
    nav.innerHTML = `<button class="button light" data-action="previous" ${state.taskIndex === 0 ? "disabled" : ""}>\u4e0a\u4e00\u7ec4</button><strong>\u7b2c ${state.taskIndex + 1} / ${paper().tasks.length} \u7ec4</strong><button class="button primary" data-action="next" ${state.taskIndex === paper().tasks.length - 1 ? "disabled" : ""}>\u4e0b\u4e00\u7ec4</button>`;
    panel.append(nav);
  }
  function decoratePracticeSidebar() {
    if (state.screen !== "practice") return;
    const layout = app.querySelector(".practice-layout");
    const heading = app.querySelector(".practice-heading");
    if (!layout || !heading) return;
    layout.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
    let tools = heading.querySelector(".practice-tools");
    if (!tools) {
      tools = document.createElement("div");
      tools.className = "practice-tools";
      tools.innerHTML = `<button class="button light sidebar-toggle" data-action="toggle-sidebar" type="button"></button>`;
      heading.append(tools);
    }
    const button = tools.querySelector(".sidebar-toggle");
    button.textContent = state.sidebarCollapsed ? "\u5c55\u5f00\u9898\u5e93" : "\u6536\u8d77\u9898\u5e93";
    button.setAttribute("aria-expanded", String(!state.sidebarCollapsed));
    button.setAttribute("aria-label", state.sidebarCollapsed ? "\u5c55\u5f00\u5386\u5e74\u542c\u529b\u771f\u9898\u4fa7\u680f" : "\u6536\u8d77\u5386\u5e74\u542c\u529b\u771f\u9898\u4fa7\u680f");
  }
  function decorateCloudUi() {
    const status = app.querySelector("[data-cloud-status]");
    const button = app.querySelector("[data-action=\"cloud-auth\"]");
    if (!status || !button) return;
    if (state.cloudUser) {
      status.textContent = state.cloudStatus === "loading" ? "\u4e91\u7aef\u8fde\u63a5\u4e2d" : state.cloudStatus === "error" ? "\u540c\u6b65\u5931\u8d25" : state.cloudStatus === "syncing" ? "\u540c\u6b65\u4e2d" : "\u4e91\u7aef\u5df2\u540c\u6b65";
      button.textContent = "\u9000\u51fa\u540c\u6b65";
      button.title = state.cloudUser.email || "\u9000\u51fa\u4e91\u7aef\u540c\u6b65";
      button.disabled = state.cloudStatus === "loading";
    } else {
      status.textContent = state.cloudStatus === "error" ? "\u4e91\u7aef\u8fde\u63a5\u5931\u8d25" : "\u672c\u673a\u4fdd\u5b58";
      button.textContent = "\u767b\u5f55\u540c\u6b65";
      button.title = "\u4f7f\u7528\u90ae\u7bb1\u548c\u5bc6\u7801\u767b\u5f55\u4e91\u7aef\u540c\u6b65";
      button.disabled = false;
    }
  }
  function render() {
    if (state.screen === "mock-setup") app.innerHTML = mockSetupTemplate();
    else if (state.screen === "mock") app.innerHTML = mockTemplate();
    else if (state.screen === "wrong") app.innerHTML = wrongTemplate();
    else if (state.screen === "practice") app.innerHTML = practiceTemplate();
    else app.innerHTML = homeTemplate();
    decoratePracticeAudio();
    decorateMockSetup();
    decoratePracticeNavigation();
    decoratePracticeSidebar();
    decorateCloudUi();
    decorateMockAudio();
    decorateTranscriptAudio();
  }
  app.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "start-mock") startMock();
  });
  function transcriptTemplate(current, id, mock = false) {
    const action = mock ? "focus-mock-transcript" : "focus-transcript";
    const audioAttr = mock ? `data-mock-audio-id="${current.mockId}"` : "";
    const containerAudioAttr = mock ? ` data-transcript-audio-id="${esc(current.mockId)}"` : "";
    return `<div class="transcript ${mock ? "mock-transcript" : ""}" id="${id}"${containerAudioAttr}><button class="transcript-heading" data-action="${action}" ${audioAttr}><span>听力原文 · TRANSCRIPT</span><small>点击句子跳到这里并继续播放</small></button>${transcriptLinesTemplate(current, mock)}</div>`;
  }
  app.addEventListener("click", (event) => {
    if (!event.target.closest('[data-action="toggle-transcript"]')) return;
    state.showTranscript = !state.showTranscript;
    render();
  });
  app.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "export-data") exportProgressData();
    if (action === "restore-data") app.querySelector("[data-restore-file]")?.click();
  });
  let wrongLongPressTimer = 0;
  let wrongLongPressCard = null;
  let wrongLongPressPoint = null;
  app.addEventListener("touchstart", (event) => {
    const card = event.target.closest(".wrong-set-card, .wrong-item-card, .mock-history-wrong-item");
    if (state.screen !== "wrong" || !card || event.touches.length !== 1) return;
    const touch = event.touches[0];
    wrongLongPressCard = card;
    wrongLongPressPoint = { clientX: touch.clientX, clientY: touch.clientY };
    wrongLongPressTimer = window.setTimeout(() => {
      if (!wrongLongPressCard || !wrongLongPressPoint) return;
      showWrongMenu({
        clientX: wrongLongPressPoint.clientX,
        clientY: wrongLongPressPoint.clientY,
        preventDefault() {}
      }, wrongLongPressCard);
      wrongLongPressCard.dataset.longPressed = "1";
    }, 650);
  }, { passive: true });
  const cancelWrongLongPress = () => {
    if (wrongLongPressTimer) window.clearTimeout(wrongLongPressTimer);
    wrongLongPressTimer = 0;
    wrongLongPressCard = null;
    wrongLongPressPoint = null;
  };
  app.addEventListener("touchmove", cancelWrongLongPress, { passive: true });
  app.addEventListener("touchend", cancelWrongLongPress, { passive: true });
  app.addEventListener("touchcancel", cancelWrongLongPress, { passive: true });
  app.addEventListener("click", (event) => {
    const card = event.target.closest(".wrong-set-card, .wrong-item-card, .mock-history-wrong-item");
    if (card?.dataset.longPressed !== "1") return;
    event.preventDefault();
    delete card.dataset.longPressed;
  }, true);

  app.addEventListener("touchend", (event) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
    const anchor = selection.anchorNode;
    const element = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
    if (!element?.closest?.(".option")) return;
    if (markOptionSelection(selection)) {
      event.preventDefault();
      state.suppressOptionClick = true;
    }
  }, { passive: false });

  window.addEventListener("cet-firebase-ready", bindCloudSync);
  bindCloudSync();
  render();
})();
