(function () {
  var root = document.querySelector(".smart-brief-page");
  if (!root) return;

  var section = root.querySelector(".sb-hero");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var stages = {
    intro: root.querySelector('[data-sb-stage="intro"]'),
    write: root.querySelector('[data-sb-stage="write"]'),
    result: root.querySelector('[data-sb-stage="result"]')
  };

  if (!stages.intro || !stages.write || !stages.result) return;

  var stageLabels = {
    intro: "sb-title",
    write: "sb-write-title",
    result: "sb-result-title"
  };

  var modes = root.querySelectorAll("[data-sb-mode]");
  var textarea = root.querySelector("#sb-brief-text");
  var writeNote = root.querySelector("[data-sb-write-note]");
  var submitWrite = root.querySelector("[data-sb-submit-write]");
  var activeStage = "intro";
  var transitioning = false;

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

  modes.forEach(function (button) {
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", function () {
      setModePressed(button);
      var mode = button.getAttribute("data-sb-mode");
      if (mode === "write") {
        showStage("write", "#sb-brief-text");
      }
    });
  });

  if (submitWrite) {
    submitWrite.addEventListener("click", function () {
      var value = textarea ? textarea.value.trim() : "";
      if (!value) {
        setWriteValidity(false);
        if (textarea) textarea.focus();
        return;
      }

      setWriteValidity(true);
      showStage("result", ".btn-primary");
    });
  }

  if (textarea) {
    textarea.addEventListener("input", function () {
      if (textarea.value.trim()) {
        setWriteValidity(true);
      }
    });
  }

  root.querySelectorAll("[data-sb-back-intro]").forEach(function (button) {
    button.addEventListener("click", function () {
      if (textarea) textarea.value = "";
      setWriteValidity(true);
      if (writeNote) writeNote.hidden = true;
      setModePressed(null);
      showStage("intro", '[data-sb-mode="write"]');
    });
  });

  stages.intro.classList.add("is-visible");
  setStageLabel("intro");
})();
