(function () {
  var root = document.querySelector(".smart-brief-page");
  if (!root) return;

  var STORAGE_KEY = "smartBriefSession.v1";
  var LIMITS = {
    maxMessageChars: 4000,
    maxHistoryItems: 24,
    clientTimeoutMs: 55000
  };

  var config = window.SMART_BRIEF_CONFIG || {};
  var apiUrl = typeof config.apiUrl === "string" ? config.apiUrl.trim() : "";

  var section = root.querySelector(".sb-hero");
  var panel = root.querySelector(".sb-panel");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var stages = {
    intro: root.querySelector('[data-sb-stage="intro"]'),
    write: root.querySelector('[data-sb-stage="write"]'),
    dialogue: root.querySelector('[data-sb-stage="dialogue"]')
  };

  if (!stages.intro || !stages.write || !stages.dialogue) return;

  var stageLabels = {
    intro: "sb-title",
    write: "sb-write-title",
    dialogue: "sb-dialogue-title"
  };

  var modes = root.querySelectorAll("[data-sb-mode]");
  var textarea = root.querySelector("#sb-brief-text");
  var replyArea = root.querySelector("#sb-reply-text");
  var writeNote = root.querySelector("[data-sb-write-note]");
  var submitWrite = root.querySelector("[data-sb-submit-write]");
  var sendReply = root.querySelector("[data-sb-send-reply]");
  var chatEl = root.querySelector("[data-sb-chat]");
  var errorEl = root.querySelector("[data-sb-error]");
  var contactLink = root.querySelector("[data-sb-contact]");

  var activeStage = "intro";
  var transitioning = false;
  var loading = false;
  var sessionId = null;
  var history = [];
  var phase = "clarify";
  var done = false;
  var briefState = null;

  function createSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "sb-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function saveSession() {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sessionId: sessionId,
          history: history,
          phase: phase,
          done: done,
          briefState: briefState
        })
      );
    } catch (_err) {
      /* ignore quota / private mode */
    }
  }

  function clearSession() {
    sessionId = null;
    history = [];
    phase = "clarify";
    done = false;
    briefState = null;
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (_err) {
      /* ignore */
    }
  }

  function loadSession() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || typeof data !== "object") return null;
      if (!Array.isArray(data.history) || !data.history.length) return null;

      var nextHistory = [];
      for (var i = 0; i < data.history.length; i += 1) {
        var item = data.history[i];
        if (!item || (item.role !== "user" && item.role !== "assistant")) continue;
        if (typeof item.content !== "string" || !item.content.trim()) continue;
        nextHistory.push({
          role: item.role,
          content: item.content.trim().slice(0, LIMITS.maxMessageChars)
        });
      }

      if (!nextHistory.length) return null;

      return {
        sessionId: typeof data.sessionId === "string" ? data.sessionId : createSessionId(),
        history: nextHistory.slice(-LIMITS.maxHistoryItems),
        phase:
          data.phase === "recommend" || data.phase === "handoff" || data.phase === "clarify"
            ? data.phase
            : "clarify",
        done: Boolean(data.done),
        // Opaque continuum token from server — do not interpret.
        briefState: data.briefState != null ? data.briefState : null
      };
    } catch (_err) {
      return null;
    }
  }

  function setModePressed(selected) {
    modes.forEach(function (item) {
      var on = item === selected;
      item.classList.toggle("is-selected", on);
      item.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function setStageLabel(name) {
    if (!section || !stageLabels[name]) return;
    section.setAttribute("aria-labelledby", stageLabels[name]);
  }

  function clearStageClasses(el) {
    if (!el) return;
    el.classList.remove("is-leaving", "is-entering", "is-visible");
  }

  function showStage(name, focusSelector) {
    if (!stages[name] || transitioning || name === activeStage) return;
    transitioning = true;

    var current = stages[activeStage];
    var next = stages[name];
    var duration = reduceMotion ? 0 : 280;

    if (current) {
      current.classList.add("is-leaving");
    }

    window.setTimeout(function () {
      if (current) {
        current.hidden = true;
        clearStageClasses(current);
      }

      clearStageClasses(next);
      next.hidden = false;
      next.classList.add("is-entering");
      activeStage = name;
      setStageLabel(name);
      transitioning = false;

      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          next.classList.add("is-visible");
          next.classList.remove("is-entering");
        });
      });

      var focusTarget = focusSelector ? next.querySelector(focusSelector) : null;
      if (focusTarget && typeof focusTarget.focus === "function") {
        try {
          focusTarget.focus({ preventScroll: true });
        } catch (err) {
          focusTarget.focus();
        }
      }
    }, duration);
  }

  function setWriteValidity(isValid) {
    if (textarea) {
      textarea.classList.toggle("is-invalid", !isValid);
      textarea.setAttribute("aria-invalid", isValid ? "false" : "true");
    }
    if (writeNote) writeNote.hidden = isValid;
  }

  function setReplyValidity(isValid) {
    if (!replyArea) return;
    replyArea.classList.toggle("is-invalid", !isValid);
    replyArea.setAttribute("aria-invalid", isValid ? "false" : "true");
  }

  function setBusy(isBusy) {
    loading = isBusy;
    if (panel) panel.classList.toggle("is-busy", isBusy);
    if (submitWrite) submitWrite.disabled = isBusy;
    if (sendReply) sendReply.disabled = isBusy;
    if (replyArea) replyArea.disabled = isBusy;
  }

  function setErrorVisible(visible) {
    if (errorEl) errorEl.hidden = !visible;
  }

  function updateContactVisibility() {
    if (!contactLink) return;
    contactLink.hidden = !(phase === "recommend" || phase === "handoff" || done);
  }

  function scrollChatToBottom() {
    if (!chatEl) return;
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function appendMessage(role, content, extraClass) {
    if (!chatEl) return null;
    var el = document.createElement("div");
    el.className = "sb-msg sb-msg--" + role + (extraClass ? " " + extraClass : "");
    el.textContent = content;
    chatEl.appendChild(el);
    scrollChatToBottom();
    return el;
  }

  function renderHistory() {
    if (!chatEl) return;
    chatEl.innerHTML = "";
    for (var i = 0; i < history.length; i += 1) {
      appendMessage(history[i].role, history[i].content);
    }
  }

  function historyForRequest() {
    return history.slice(-LIMITS.maxHistoryItems).map(function (item) {
      return { role: item.role, content: item.content };
    });
  }

  function requestChat(message) {
    if (!apiUrl) {
      return Promise.reject(new Error("unavailable"));
    }

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = null;
    if (controller) {
      timer = window.setTimeout(function () {
        controller.abort();
      }, LIMITS.clientTimeoutMs);
    }

    return fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sessionId,
        message: message,
        history: historyForRequest(),
        briefState: briefState
      }),
      signal: controller ? controller.signal : undefined
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null;
          })
          .then(function (payload) {
            if (!response.ok || !payload || payload.ok !== true) {
              var code =
                payload && typeof payload.error === "string" ? payload.error : "unavailable";
              var err = new Error(code);
              err.code = code;
              throw err;
            }
            return payload;
          });
      })
      .finally(function () {
        if (timer) window.clearTimeout(timer);
      });
  }

  function sendMessage(message, options) {
    var opts = options || {};
    if (loading) return;
    if (!message) return;

    if (message.length > LIMITS.maxMessageChars) {
      if (opts.fromWrite) setWriteValidity(false);
      else setReplyValidity(false);
      return;
    }

    setErrorVisible(false);
    setBusy(true);

    if (!sessionId) sessionId = createSessionId();

    if (opts.switchToDialogue) {
      showStage("dialogue", "#sb-reply-text");
    }

    appendMessage("user", message);
    var userEl = chatEl ? chatEl.lastElementChild : null;
    var loadingEl = appendMessage("assistant", "Думаю над ответом…", "sb-msg--loading");

    requestChat(message)
      .then(function (payload) {
        if (loadingEl && loadingEl.parentNode) {
          loadingEl.parentNode.removeChild(loadingEl);
        }

        var assistantMessage =
          typeof payload.assistantMessage === "string" ? payload.assistantMessage.trim() : "";
        if (!assistantMessage) {
          throw Object.assign(new Error("unavailable"), { code: "unavailable" });
        }

        if (typeof payload.sessionId === "string" && payload.sessionId) {
          sessionId = payload.sessionId;
        }

        // Opaque server continuum — replace local copy only; never interpret.
        if (Object.prototype.hasOwnProperty.call(payload, "briefState")) {
          briefState = payload.briefState != null ? payload.briefState : null;
        }

        history.push({ role: "user", content: message });
        history.push({ role: "assistant", content: assistantMessage });
        if (history.length > LIMITS.maxHistoryItems) {
          history = history.slice(-LIMITS.maxHistoryItems);
        }

        phase =
          payload.phase === "recommend" || payload.phase === "handoff" || payload.phase === "clarify"
            ? payload.phase
            : "clarify";
        done = Boolean(payload.done);

        appendMessage("assistant", assistantMessage);
        saveSession();
        updateContactVisibility();

        if (opts.clearWrite && textarea) textarea.value = "";
        if (replyArea) {
          replyArea.value = "";
          setReplyValidity(true);
        }
      })
      .catch(function () {
        if (loadingEl && loadingEl.parentNode) {
          loadingEl.parentNode.removeChild(loadingEl);
        }
        if (userEl && userEl.parentNode) {
          userEl.parentNode.removeChild(userEl);
        }
        if (replyArea && !replyArea.value.trim()) {
          replyArea.value = message;
        }
        setErrorVisible(true);
      })
      .finally(function () {
        setBusy(false);
        if (replyArea && activeStage === "dialogue") {
          try {
            replyArea.focus({ preventScroll: true });
          } catch (_err) {
            replyArea.focus();
          }
        }
      });
  }

  function resetToIntro() {
    if (loading) return;
    clearSession();
    if (chatEl) chatEl.innerHTML = "";
    if (textarea) textarea.value = "";
    if (replyArea) {
      replyArea.value = "";
      setReplyValidity(true);
    }
    setWriteValidity(true);
    if (writeNote) writeNote.hidden = true;
    setErrorVisible(false);
    updateContactVisibility();
    setModePressed(null);
    showStage("intro", '[data-sb-mode="write"]');
  }

  modes.forEach(function (button) {
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", function () {
      if (loading) return;
      setModePressed(button);
      var mode = button.getAttribute("data-sb-mode");
      if (mode === "write") {
        showStage("write", "#sb-brief-text");
      }
    });
  });

  if (submitWrite) {
    submitWrite.addEventListener("click", function () {
      if (loading) return;
      var value = textarea ? textarea.value.trim() : "";
      if (!value) {
        setWriteValidity(false);
        if (textarea) textarea.focus();
        return;
      }
      if (value.length > LIMITS.maxMessageChars) {
        setWriteValidity(false);
        if (textarea) textarea.focus();
        return;
      }
      setWriteValidity(true);
      sendMessage(value, {
        switchToDialogue: true,
        clearWrite: true,
        fromWrite: true
      });
    });
  }

  if (sendReply) {
    sendReply.addEventListener("click", function () {
      if (loading) return;
      var value = replyArea ? replyArea.value.trim() : "";
      if (!value) {
        setReplyValidity(false);
        if (replyArea) replyArea.focus();
        return;
      }
      if (value.length > LIMITS.maxMessageChars) {
        setReplyValidity(false);
        if (replyArea) replyArea.focus();
        return;
      }
      setReplyValidity(true);
      sendMessage(value);
    });
  }

  if (textarea) {
    textarea.addEventListener("input", function () {
      if (textarea.value.trim()) setWriteValidity(true);
    });
  }

  if (replyArea) {
    replyArea.addEventListener("input", function () {
      if (replyArea.value.trim()) setReplyValidity(true);
      setErrorVisible(false);
    });
    replyArea.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (sendReply) sendReply.click();
      }
    });
  }

  root.querySelectorAll("[data-sb-back-intro]").forEach(function (button) {
    button.addEventListener("click", function () {
      resetToIntro();
    });
  });

  var restored = loadSession();
  if (restored) {
    sessionId = restored.sessionId;
    history = restored.history;
    phase = restored.phase;
    done = restored.done;
    briefState = restored.briefState != null ? restored.briefState : null;
    stages.intro.hidden = true;
    clearStageClasses(stages.intro);
    stages.write.hidden = true;
    clearStageClasses(stages.write);
    stages.dialogue.hidden = false;
    stages.dialogue.classList.add("is-visible");
    activeStage = "dialogue";
    setStageLabel("dialogue");
    renderHistory();
    updateContactVisibility();
  } else {
    stages.intro.classList.add("is-visible");
    setStageLabel("intro");
    updateContactVisibility();
  }
})();
