(function () {
  var root = document.querySelector(".smart-brief-page");
  if (!root) return;

  var STORAGE_KEY = "smartBriefSession.v1";
  var LIMITS = {
    maxMessageChars: 4000,
    maxHistoryItems: 24,
    // Slightly above Worker provider timeout (50s) so mapped provider_timeout
    // wins over a blind AbortError when upstream is slow. Rare longer spikes
    // fail fast with a clear message — user may send again; no chained provider calls.
    clientTimeoutMs: 58000,
    /** Voice Input V1 — sync SpeechKit STT ceiling with headroom under 30s. */
    voiceMaxSec: 28,
    voiceSampleRateHz: 16000,
    voiceSttTimeoutMs: 15000
  };

  var config = window.SMART_BRIEF_CONFIG || {};
  var apiUrl = typeof config.apiUrl === "string" ? config.apiUrl.trim() : "";
  var transcribeUrl =
    typeof config.transcribeUrl === "string" ? config.transcribeUrl.trim() : "";

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
  var micButtons = root.querySelectorAll("[data-sb-mic]");
  var voiceStatusNodes = root.querySelectorAll("[data-sb-voice-status]");

  var activeStage = "intro";
  var transitioning = false;
  var loading = false;
  var sessionId = null;
  var history = [];
  var phase = "clarify";
  var done = false;
  var briefState = null;

  // Voice Input V1 — fill textarea only; never auto-send to /api/chat.
  var voiceState = "idle";
  var voiceFieldKey = null;
  var voiceTargetEl = null;
  var voiceStatusEl = null;
  var voiceMediaStream = null;
  var voiceAudioCtx = null;
  var voiceProcessor = null;
  var voiceSource = null;
  var voiceMute = null;
  var voiceChunks = [];
  var voiceTimer = null;
  var voiceStartedAt = 0;
  var voiceNativeRate = 48000;
  var voiceSttController = null;
  var voiceSkipTranscribe = false;

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

  function showStage(name, focusSelector, afterShow) {
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

      if (typeof afterShow === "function") {
        afterShow();
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
    if (isBusy) {
      abortVoiceSession({ silent: true });
    }
    syncMicButtons();
  }

  function setErrorVisible(visible, code) {
    if (!errorEl) return;
    if (visible) {
      errorEl.textContent = errorMessageForCode(code);
      errorEl.hidden = false;
    } else {
      errorEl.hidden = true;
    }
  }

  function errorMessageForCode(code) {
    if (code === "client_timeout" || code === "provider_timeout") {
      // Continuity comes from last successful history/briefState only.
      return "Ответ занял больше времени, чем обычно. Можно отправить сообщение ещё раз — продолжим с уже сказанного.";
    }
    if (code === "rate_limited") {
      return "Слишком много запросов подряд. Подождите немного и попробуйте снова.";
    }
    if (code === "provider_upstream") {
      return "Временный сбой внешнего сервиса ответа. Попробуйте ещё раз.";
    }
    if (code === "validation_error") {
      return "Не удалось отправить сообщение. Проверьте текст и попробуйте снова.";
    }
    return "Не удалось получить ответ. Попробуйте ещё раз.";
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

  /** Pure helper: append STT transcript without wiping existing text. */
  function appendTranscriptToValue(existing, transcript) {
    var next = typeof transcript === "string" ? transcript.trim() : "";
    if (!next) return typeof existing === "string" ? existing : "";
    var cur = typeof existing === "string" ? existing : "";
    if (!cur.trim()) return next;
    if (/\s$/.test(cur)) return cur + next;
    return cur + " " + next;
  }

  function voiceMessageForCode(code) {
    if (code === "permission_denied") {
      return "Нет доступа к микрофону. Разрешите запись в настройках браузера.";
    }
    if (code === "microphone_unavailable") {
      return "Микрофон недоступен. Проверьте устройство и попробуйте снова.";
    }
    if (code === "unsupported_audio") {
      return "Этот браузер не поддерживает нужную запись звука.";
    }
    if (code === "recording_too_long") {
      return "Запись получилась слишком длинной. Остановитесь раньше — до 28 секунд.";
    }
    if (code === "rate_limited") {
      return "Слишком много голосовых запросов. Подождите немного и попробуйте снова.";
    }
    if (code === "stt_timeout") {
      return "Распознавание речи заняло слишком много времени. Попробуйте ещё раз.";
    }
    if (code === "stt_upstream") {
      return "Временный сбой распознавания речи. Попробуйте ещё раз.";
    }
    if (code === "unavailable") {
      return "Голосовой ввод сейчас недоступен.";
    }
    if (code === "network" || code === "client_timeout") {
      return "Не удалось связаться с сервисом распознавания. Проверьте сеть и попробуйте снова.";
    }
    return "Не удалось распознать речь. Попробуйте ещё раз.";
  }

  function voiceStatusLabel(state) {
    if (state === "requesting_permission") return "Запрос доступа к микрофону…";
    if (state === "recording") return "Идёт запись. Нажмите микрофон ещё раз, чтобы остановить.";
    if (state === "processing") return "Распознаю речь…";
    if (state === "ready") return "Текст добавлен в поле. При необходимости отредактируйте и отправьте сами.";
    return "";
  }

  function setVoiceStatus(state, code) {
    var text = "";
    if (state === "error") text = voiceMessageForCode(code);
    else if (state !== "idle") text = voiceStatusLabel(state);

    for (var i = 0; i < voiceStatusNodes.length; i += 1) {
      var node = voiceStatusNodes[i];
      var isActive =
        Boolean(voiceFieldKey) &&
        node.getAttribute("data-sb-voice-status") === voiceFieldKey;

      if (state === "idle" || !text) {
        node.textContent = "";
        node.hidden = true;
        node.removeAttribute("data-voice-state");
        continue;
      }

      if (isActive) {
        node.textContent = text;
        node.hidden = false;
        node.setAttribute("data-voice-state", state);
      } else {
        node.textContent = "";
        node.hidden = true;
        node.removeAttribute("data-voice-state");
      }
    }
  }

  function syncMicButtons() {
    var busyVoice =
      voiceState === "requesting_permission" ||
      voiceState === "recording" ||
      voiceState === "processing";
    for (var i = 0; i < micButtons.length; i += 1) {
      var btn = micButtons[i];
      var key = btn.getAttribute("data-sb-mic");
      var isActiveTarget = busyVoice && key === voiceFieldKey;
      var disableOther = busyVoice && key !== voiceFieldKey;
      var disableAll = loading || !transcribeUrl;
      btn.disabled = Boolean(disableAll || disableOther || voiceState === "processing");
      btn.classList.toggle("is-recording", voiceState === "recording" && isActiveTarget);
      btn.classList.toggle("is-processing", voiceState === "processing" && isActiveTarget);
      btn.setAttribute(
        "aria-pressed",
        voiceState === "recording" && isActiveTarget ? "true" : "false"
      );
      if (voiceState === "recording" && isActiveTarget) {
        btn.setAttribute("aria-label", "Остановить запись");
        btn.setAttribute("title", "Остановить запись");
      } else if (key === "brief") {
        btn.setAttribute("aria-label", "Голосовой ввод для описания проекта");
        btn.setAttribute("title", "Голосовой ввод");
      } else {
        btn.setAttribute("aria-label", "Голосовой ввод для ответа");
        btn.setAttribute("title", "Голосовой ввод");
      }
    }
  }

  function resolveVoiceTarget(fieldKey) {
    if (fieldKey === "brief") {
      return {
        key: "brief",
        textarea: textarea,
        status: root.querySelector('[data-sb-voice-status="brief"]')
      };
    }
    if (fieldKey === "reply") {
      return {
        key: "reply",
        textarea: replyArea,
        status: root.querySelector('[data-sb-voice-status="reply"]')
      };
    }
    return null;
  }

  function releaseVoiceGraph() {
    if (voiceTimer) {
      window.clearInterval(voiceTimer);
      voiceTimer = null;
    }
    try {
      if (voiceProcessor) {
        voiceProcessor.onaudioprocess = null;
        voiceProcessor.disconnect();
      }
    } catch (_err) {
      /* ignore */
    }
    try {
      if (voiceSource) voiceSource.disconnect();
    } catch (_err2) {
      /* ignore */
    }
    try {
      if (voiceMute) voiceMute.disconnect();
    } catch (_err3) {
      /* ignore */
    }
    try {
      if (voiceAudioCtx && voiceAudioCtx.state !== "closed") {
        voiceAudioCtx.close();
      }
    } catch (_err4) {
      /* ignore */
    }
    if (voiceMediaStream) {
      var tracks = voiceMediaStream.getTracks();
      for (var i = 0; i < tracks.length; i += 1) {
        try {
          tracks[i].stop();
        } catch (_err5) {
          /* ignore */
        }
      }
    }
    voiceMediaStream = null;
    voiceAudioCtx = null;
    voiceProcessor = null;
    voiceSource = null;
    voiceMute = null;
    voiceChunks = [];
  }

  function abortSttFetch() {
    if (voiceSttController) {
      try {
        voiceSttController.abort();
      } catch (_err) {
        /* ignore */
      }
      voiceSttController = null;
    }
  }

  function abortVoiceSession(options) {
    var opts = options || {};
    var wasActive =
      voiceState === "requesting_permission" ||
      voiceState === "recording" ||
      voiceState === "processing";
    voiceSkipTranscribe = true;
    abortSttFetch();
    releaseVoiceGraph();
    voiceState = "idle";
    voiceFieldKey = null;
    voiceTargetEl = null;
    voiceStatusEl = null;
    voiceSkipTranscribe = false;
    if (!opts.silent || wasActive) {
      setVoiceStatus("idle");
    } else {
      setVoiceStatus("idle");
    }
    syncMicButtons();
  }

  function floatTo16BitPCM(float32) {
    var out = new Int16Array(float32.length);
    for (var i = 0; i < float32.length; i += 1) {
      var s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function resampleLinear(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    var ratio = fromRate / toRate;
    var outLen = Math.max(1, Math.floor(input.length / ratio));
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i += 1) {
      var pos = i * ratio;
      var i0 = Math.floor(pos);
      var i1 = Math.min(i0 + 1, input.length - 1);
      var t = pos - i0;
      out[i] = input[i0] * (1 - t) + input[i1] * t;
    }
    return out;
  }

  function mergeFloatChunks(list) {
    var total = 0;
    for (var i = 0; i < list.length; i += 1) total += list[i].length;
    var merged = new Float32Array(total);
    var offset = 0;
    for (var j = 0; j < list.length; j += 1) {
      merged.set(list[j], offset);
      offset += list[j].length;
    }
    return merged;
  }

  function buildLpcmFromChunks(chunks, nativeRate) {
    var merged = mergeFloatChunks(chunks);
    var resampled = resampleLinear(merged, nativeRate || 48000, LIMITS.voiceSampleRateHz);
    var pcm16 = floatTo16BitPCM(resampled);
    return new Uint8Array(pcm16.buffer);
  }

  function insertTranscriptIntoField(target, transcript) {
    if (!target) return;
    var before = target.value;
    target.value = appendTranscriptToValue(before, transcript).slice(0, LIMITS.maxMessageChars);
    if (target === textarea && target.value.trim()) setWriteValidity(true);
    if (target === replyArea && target.value.trim()) setReplyValidity(true);
    try {
      target.focus({ preventScroll: true });
    } catch (_err) {
      target.focus();
    }
  }

  function requestTranscribe(lpcmBytes) {
    if (!transcribeUrl) {
      return Promise.reject(Object.assign(new Error("unavailable"), { code: "unavailable" }));
    }
    if (!lpcmBytes || !lpcmBytes.byteLength) {
      return Promise.reject(Object.assign(new Error("unavailable"), { code: "unavailable" }));
    }

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    voiceSttController = controller;
    var timer = null;
    if (controller) {
      timer = window.setTimeout(function () {
        controller.abort();
      }, LIMITS.voiceSttTimeoutMs);
    }

    return fetch(transcribeUrl, {
      method: "POST",
      headers: { "Content-Type": "audio/lpcm" },
      body: lpcmBytes,
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
            return typeof payload.text === "string" ? payload.text : "";
          });
      })
      .catch(function (err) {
        if (err && (err.name === "AbortError" || err.code === 20)) {
          throw Object.assign(new Error("stt_timeout"), { code: "stt_timeout" });
        }
        if (err && err.code) throw err;
        throw Object.assign(new Error("network"), { code: "network" });
      })
      .finally(function () {
        if (timer) window.clearTimeout(timer);
        if (voiceSttController === controller) voiceSttController = null;
      });
  }

  function finishRecordingAndMaybeTranscribe() {
    if (voiceState !== "recording") return;

    var target = voiceTargetEl;
    var fieldKey = voiceFieldKey;
    var skip = voiceSkipTranscribe || loading;
    var chunks = voiceChunks.slice();
    var nativeRate = voiceNativeRate;

    voiceState = "processing";
    syncMicButtons();
    releaseVoiceGraph();

    if (skip || !target || !fieldKey) {
      voiceState = "idle";
      voiceFieldKey = null;
      voiceTargetEl = null;
      voiceStatusEl = null;
      setVoiceStatus("idle");
      syncMicButtons();
      return;
    }

    var lpcm = buildLpcmFromChunks(chunks, nativeRate);
    if (!lpcm.byteLength) {
      voiceFieldKey = fieldKey;
      voiceState = "error";
      setVoiceStatus("error", "unavailable");
      voiceFieldKey = null;
      voiceTargetEl = null;
      voiceStatusEl = null;
      voiceState = "idle";
      syncMicButtons();
      return;
    }

    voiceFieldKey = fieldKey;
    voiceTargetEl = target;
    setVoiceStatus("processing");

    // INVARIANT: STT success must NEVER call sendMessage / requestChat.
    requestTranscribe(lpcm)
      .then(function (text) {
        if (loading || voiceSkipTranscribe) return;
        insertTranscriptIntoField(target, text);
        voiceFieldKey = fieldKey;
        voiceState = "ready";
        setVoiceStatus("ready");
        voiceTargetEl = null;
        voiceStatusEl = null;
        voiceFieldKey = null;
        voiceState = "idle";
        syncMicButtons();
      })
      .catch(function (err) {
        if (loading || voiceSkipTranscribe) {
          voiceState = "idle";
          voiceFieldKey = null;
          voiceTargetEl = null;
          voiceStatusEl = null;
          setVoiceStatus("idle");
          syncMicButtons();
          return;
        }
        var code = err && err.code ? err.code : "unavailable";
        voiceFieldKey = fieldKey;
        voiceState = "error";
        setVoiceStatus("error", code);
        voiceTargetEl = null;
        voiceStatusEl = null;
        voiceFieldKey = null;
        voiceState = "idle";
        syncMicButtons();
      });
  }

  function startVoiceRecording(fieldKey) {
    if (loading) return;
    if (!transcribeUrl) {
      voiceFieldKey = fieldKey;
      voiceState = "error";
      setVoiceStatus("error", "unavailable");
      voiceFieldKey = null;
      voiceState = "idle";
      syncMicButtons();
      return;
    }
    if (
      voiceState === "recording" ||
      voiceState === "processing" ||
      voiceState === "requesting_permission"
    ) {
      return;
    }

    var resolved = resolveVoiceTarget(fieldKey);
    if (!resolved || !resolved.textarea) return;

    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function" ||
      !(window.AudioContext || window.webkitAudioContext)
    ) {
      voiceFieldKey = fieldKey;
      voiceState = "error";
      setVoiceStatus("error", "unsupported_audio");
      voiceFieldKey = null;
      voiceState = "idle";
      syncMicButtons();
      return;
    }

    voiceSkipTranscribe = false;
    voiceFieldKey = fieldKey;
    voiceTargetEl = resolved.textarea;
    voiceStatusEl = resolved.status;
    voiceChunks = [];
    voiceState = "requesting_permission";
    setVoiceStatus("requesting_permission");
    syncMicButtons();

    var AudioCtx = window.AudioContext || window.webkitAudioContext;

    navigator.mediaDevices
      .getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      })
      .then(function (stream) {
        if (loading || voiceSkipTranscribe || voiceFieldKey !== fieldKey) {
          var tracks = stream.getTracks();
          for (var i = 0; i < tracks.length; i += 1) tracks[i].stop();
          return;
        }

        voiceMediaStream = stream;
        voiceAudioCtx = new AudioCtx();
        voiceNativeRate = voiceAudioCtx.sampleRate || 48000;
        voiceSource = voiceAudioCtx.createMediaStreamSource(stream);
        voiceProcessor = voiceAudioCtx.createScriptProcessor(4096, 1, 1);
        voiceMute = voiceAudioCtx.createGain();
        voiceMute.gain.value = 0;
        voiceProcessor.onaudioprocess = function (ev) {
          var input = ev.inputBuffer.getChannelData(0);
          voiceChunks.push(new Float32Array(input));
        };
        voiceSource.connect(voiceProcessor);
        voiceProcessor.connect(voiceMute);
        voiceMute.connect(voiceAudioCtx.destination);

        if (voiceAudioCtx.state === "suspended" && typeof voiceAudioCtx.resume === "function") {
          voiceAudioCtx.resume();
        }

        voiceStartedAt = window.performance ? performance.now() : Date.now();
        voiceState = "recording";
        setVoiceStatus("recording");
        syncMicButtons();

        voiceTimer = window.setInterval(function () {
          var now = window.performance ? performance.now() : Date.now();
          var sec = (now - voiceStartedAt) / 1000;
          if (sec >= LIMITS.voiceMaxSec) {
            finishRecordingAndMaybeTranscribe();
          }
        }, 100);
      })
      .catch(function (err) {
        releaseVoiceGraph();
        var code = "microphone_unavailable";
        var name = err && err.name ? String(err.name) : "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          code = "permission_denied";
        } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
          code = "microphone_unavailable";
        } else if (name === "NotSupportedError") {
          code = "unsupported_audio";
        }
        voiceFieldKey = fieldKey;
        voiceState = "error";
        setVoiceStatus("error", code);
        voiceFieldKey = null;
        voiceTargetEl = null;
        voiceStatusEl = null;
        voiceState = "idle";
        syncMicButtons();
      });
  }

  function onMicClick(fieldKey) {
    if (loading) return;
    if (voiceState === "processing" || voiceState === "requesting_permission") return;
    if (voiceState === "recording") {
      if (fieldKey === voiceFieldKey) {
        finishRecordingAndMaybeTranscribe();
      }
      return;
    }
    startVoiceRecording(fieldKey);
  }

  function requestChat(message) {
    if (!apiUrl) {
      return Promise.reject(Object.assign(new Error("unavailable"), { code: "unavailable" }));
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
      .catch(function (err) {
        if (err && (err.name === "AbortError" || err.code === 20)) {
          throw Object.assign(new Error("client_timeout"), { code: "client_timeout" });
        }
        throw err;
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
      .catch(function (err) {
        if (loadingEl && loadingEl.parentNode) {
          loadingEl.parentNode.removeChild(loadingEl);
        }
        if (userEl && userEl.parentNode) {
          userEl.parentNode.removeChild(userEl);
        }
        if (replyArea && !replyArea.value.trim()) {
          replyArea.value = message;
        }
        setErrorVisible(true, err && err.code);
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
    abortVoiceSession({ silent: true });
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
        return;
      }
      if (mode === "speak") {
        // Reuse Voice Input V1 for #sb-brief-text — never auto-send.
        showStage("write", "#sb-brief-text", function () {
          startVoiceRecording("brief");
        });
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

  for (var micIdx = 0; micIdx < micButtons.length; micIdx += 1) {
    (function (button) {
      button.addEventListener("click", function () {
        var key = button.getAttribute("data-sb-mic");
        if (key === "brief" || key === "reply") onMicClick(key);
      });
    })(micButtons[micIdx]);
  }
  syncMicButtons();

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
