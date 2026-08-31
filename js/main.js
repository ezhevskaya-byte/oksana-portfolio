(function () {
  document.documentElement.classList.add("js-ready");

  var header = document.querySelector(".header");
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.querySelector(".nav");

  function onScroll() {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 8);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      nav.classList.toggle("is-open", !open);
      document.body.style.overflow = open ? "" : "hidden";
      var label = toggle.querySelector(".sr-only");
      if (label) label.textContent = open ? "Открыть меню" : "Закрыть меню";
    });

    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        var label = toggle.querySelector(".sr-only");
        if (label) label.textContent = "Открыть меню";
        toggle.setAttribute("aria-expanded", "false");
        nav.classList.remove("is-open");
        document.body.style.overflow = "";
      });
    });
  }

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.querySelectorAll("[data-site-shot]").forEach(function (figure) {
    var img = figure.querySelector("img");
    if (!img) return;

    var queue = [img.getAttribute("src")]
      .concat((img.getAttribute("data-fallbacks") || "").split(","))
      .map(function (item) {
        return item.trim();
      })
      .filter(Boolean);
    var unique = [];
    queue.forEach(function (item) {
      if (unique.indexOf(item) === -1) unique.push(item);
    });

    var index = 1;
    function succeed() {
      figure.classList.add("is-ready");
      figure.classList.remove("is-missing");
    }
    function fail() {
      if (index < unique.length) {
        img.src = unique[index++];
        return;
      }
      figure.classList.add("is-missing");
      figure.classList.remove("is-ready");
    }

    img.addEventListener("load", succeed);
    img.addEventListener("error", fail);
    if (img.complete) {
      if (img.naturalWidth) succeed();
      else fail();
    }
  });

  var grid = document.querySelector("[data-project-grid]");
  if (grid && Array.isArray(window.PROJECTS)) {
    var cards = window.PROJECTS.filter(function (project) {
      return !project.featured;
    })
      .map(function (project, cardIndex) {
        var title = project.title || project.type;
        var media;
        var revealClass =
          "project-card scroll-reveal scroll-reveal--d" + Math.min(cardIndex, 4);

        if (
          (project.mediaLayout === "pair" ||
            project.mediaLayout === "bot" ||
            project.mediaLayout === "budget") &&
          project.image &&
          project.imageSecondary
        ) {
          media =
            '<div class="project-pair">' +
            '<img class="project-pair__main js-lightbox" src="' +
            project.image +
            '" alt="' +
            escapeHtml(project.imageLabel || title) +
            '">' +
            '<img class="project-pair__secondary js-lightbox" src="' +
            project.imageSecondary +
            '" alt="' +
            escapeHtml(project.imageSecondaryLabel || title) +
            '">' +
            "</div>";
        } else if (project.image) {
          media =
            '<img class="js-lightbox" src="' +
            project.image +
            '" alt="' +
            escapeHtml(project.imageLabel || title) +
            '">';
        } else {
          media = '<div class="media-placeholder" aria-hidden="true"></div>';
        }

        var meta = "";
        if (project.type && project.title) {
          meta =
            '<div class="project-card__meta"><span>' +
            escapeHtml(project.type) +
            "</span></div>";
        }

        var description = project.description
          ? "<p>" + escapeHtml(project.description) + "</p>"
          : "";

        var devStatus = "";
        if (project.devStatus) {
          devStatus =
            '<p class="project-card__status">' + escapeHtml(project.devStatus) + "</p>";
        }

        var done = "";
        if (project.doneLabel && project.doneText) {
          done =
            '<div class="project-card__done">' +
            '<span class="project-card__done-label">' +
            escapeHtml(project.doneLabel) +
            "</span>" +
            "<p>" +
            escapeHtml(project.doneText) +
            "</p>" +
            "</div>";
        }

        var link = "";
        if (project.linkLabel && !project.noLink) {
          link =
            '<span class="project-card__link">' +
            escapeHtml(project.linkLabel) +
            "</span>";
        }

        var detail = "";
        if (project.detailHref && project.detailLabel) {
          detail =
            '<a class="project-card__more" href="' +
            escapeHtml(project.detailHref) +
            '">' +
            escapeHtml(project.detailLabel) +
            ' <span class="project-card__more-arrow" aria-hidden="true">→</span></a>';
        }

        var mediaClass = "project-card__media media-frame";
        if (project.imageFit === "full") mediaClass += " project-card__media--full";
        if (project.imageFit === "satin") mediaClass += " project-card__media--satin";
        if (project.mediaLayout === "pair") mediaClass += " project-card__media--bukvomore";
        if (project.mediaLayout === "bot") mediaClass += " project-card__media--bot";
        if (project.mediaLayout === "budget") mediaClass += " project-card__media--budget";

        var body =
          '<div class="project-card__body">' +
          meta +
          "<h3>" +
          escapeHtml(title) +
          "</h3>" +
          description +
          devStatus +
          done +
          detail +
          link +
          "</div>";

        var mediaBlock = '<div class="' + mediaClass + '">' + media + "</div>";
        var cardClass = revealClass;
        if (project.devStatus) cardClass += " project-card--in-dev";

        if (project.noLink) {
          return '<article class="' + cardClass + '">' + mediaBlock + body + "</article>";
        }

        return (
          '<a class="' +
          revealClass +
          '" href="' +
          project.href +
          '">' +
          mediaBlock +
          body +
          "</a>"
        );
      })
      .join("");

    grid.innerHTML = cards;
  }

  if (!reduceMotion && "IntersectionObserver" in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.14, rootMargin: "0px 0px -8% 0px" }
    );

    document.querySelectorAll(".scroll-reveal").forEach(function (el) {
      observer.observe(el);
    });
  } else {
    document.querySelectorAll(".scroll-reveal").forEach(function (el) {
      el.classList.add("is-visible");
    });
  }

  initHeroTypewriter(reduceMotion);
  initExpertiseTypewriter(reduceMotion);

  var lightbox = document.getElementById("lightbox");
  var lightboxImage = lightbox ? lightbox.querySelector(".lightbox__image") : null;
  var lightboxClose = lightbox ? lightbox.querySelector(".lightbox__close") : null;

  function isLightboxOpen() {
    return Boolean(lightbox && !lightbox.hasAttribute("hidden"));
  }

  function openLightbox(source) {
    if (!lightbox || !lightboxImage || !source || !source.src) return;
    lightboxImage.src = source.currentSrc || source.src;
    lightboxImage.alt = source.alt || "";
    lightbox.removeAttribute("hidden");
    lightbox.setAttribute("aria-hidden", "false");
    document.body.classList.add("is-lightbox-open");
    if (lightboxClose) lightboxClose.focus();
  }

  function closeLightbox() {
    if (!lightbox || !lightboxImage || !isLightboxOpen()) return;
    lightbox.setAttribute("hidden", "");
    lightbox.setAttribute("aria-hidden", "true");
    lightboxImage.removeAttribute("src");
    lightboxImage.alt = "";
    document.body.classList.remove("is-lightbox-open");
  }

  document.addEventListener("click", function (event) {
    var trigger = event.target.closest("img.js-lightbox");
    if (trigger) {
      event.preventDefault();
      event.stopPropagation();
      openLightbox(trigger);
      return;
    }

    if (!isLightboxOpen()) return;

    if (event.target === lightbox || event.target === lightbox.querySelector(".lightbox__figure")) {
      closeLightbox();
    }
  });

  if (lightboxClose) {
    lightboxClose.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      closeLightbox();
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (isLightboxOpen()) {
      closeLightbox();
      return;
    }
    if (toggle && toggle.getAttribute("aria-expanded") === "true") {
      toggle.click();
    }
  });

  function initHeroTypewriter(preferReduce) {
    var root = document.querySelector(".hero__type");
    if (!root) return;

    var textEl = root.querySelector("[data-typewriter]");
    var live = root.querySelector(".hero__type-live");
    var staticEl = root.querySelector(".hero__type-static");
    var cursor = root.querySelector(".hero__type-cursor");

    if (!textEl || textEl.dataset.typewriterReady === "1") return;
    textEl.dataset.typewriterReady = "1";

    var fullText = (textEl.getAttribute("data-text") || textEl.textContent || "").trim();
    if (!fullText) return;

    if (preferReduce) {
      if (staticEl) staticEl.hidden = false;
      if (live) live.hidden = true;
      return;
    }

    if (staticEl) staticEl.hidden = true;
    if (live) {
      live.hidden = false;
      live.classList.remove("is-fading");
      live.style.opacity = "";
    }

    var charIndex = 0;
    var timer = null;
    var charDelay = 55;
    var holdDelay = 4000;
    var pauseDelay = 2000;
    var fadeDuration = 600;
    var phase = "typing";

    function clearTimer() {
      if (timer) {
        window.clearTimeout(timer);
        timer = null;
      }
    }

    function setCursorVisible(visible) {
      if (cursor) cursor.hidden = !visible;
    }

    function startCycle() {
      phase = "typing";
      charIndex = 0;
      textEl.textContent = "";
      if (live) {
        live.classList.remove("is-fading");
        live.style.opacity = "1";
      }
      setCursorVisible(true);
      typeNext();
    }

    function typeNext() {
      charIndex += 1;
      textEl.textContent = fullText.slice(0, charIndex);
      if (charIndex < fullText.length) {
        timer = window.setTimeout(typeNext, charDelay);
        return;
      }

      phase = "hold";
      setCursorVisible(false);
      timer = window.setTimeout(beginFade, holdDelay);
    }

    function beginFade() {
      phase = "fade";
      if (live) live.classList.add("is-fading");
      timer = window.setTimeout(afterFade, fadeDuration);
    }

    function afterFade() {
      phase = "pause";
      textEl.textContent = "";
      if (live) {
        live.classList.remove("is-fading");
        live.style.opacity = "0";
      }
      timer = window.setTimeout(function () {
        if (live) live.style.opacity = "1";
        startCycle();
      }, pauseDelay);
    }

    startCycle();

    document.addEventListener(
      "visibilitychange",
      function () {
        if (document.hidden) {
          clearTimer();
          return;
        }
        if (phase === "typing") {
          timer = window.setTimeout(typeNext, charDelay);
        } else if (phase === "hold") {
          timer = window.setTimeout(beginFade, holdDelay);
        } else if (phase === "fade") {
          timer = window.setTimeout(afterFade, fadeDuration);
        } else if (phase === "pause") {
          timer = window.setTimeout(function () {
            if (live) live.style.opacity = "1";
            startCycle();
          }, pauseDelay);
        }
      },
      false
    );
  }

  function initExpertiseTypewriter(preferReduce) {
    var root = document.querySelector("[data-expertise-typewriter]");
    if (!root || root.dataset.expertiseTypewriterReady === "1") return;
    root.dataset.expertiseTypewriterReady = "1";

    var measure = root.querySelector(".pullquote__text-measure");
    var live = root.querySelector(".pullquote__text-live");
    if (!measure || !live) return;

    var desktopLead = "Работа начинается\nне с шаблона и дизайна,";
    var desktopAccent = "а с понимания бизнеса,\nаудитории и задачи\nбудущего продукта.";
    var mobileLead = "Работа начинается не с шаблона и дизайна,";
    var mobileAccent = " а с понимания бизнеса, аудитории и задачи будущего продукта.";
    var mobileMql = window.matchMedia("(max-width: 767px)");

    function getCopy() {
      if (mobileMql.matches) {
        return {
          lead: mobileLead,
          accent: mobileAccent,
          multiline: false
        };
      }

      return {
        lead: desktopLead,
        accent: desktopAccent,
        multiline: true
      };
    }

    function linesHtml(text, tone, appendCursor) {
      if (!text) return "";

      var lines = text.split("\n");

      return lines
        .map(function (line, index) {
          var isLast = index === lines.length - 1;
          var inner = escapeHtml(line);
          if (isLast && appendCursor) {
            inner += '<span class="pullquote__cursor" aria-hidden="true"></span>';
          }
          return (
            '<span class="pullquote__line pullquote__' +
            tone +
            '">' +
            inner +
            "</span>"
          );
        })
        .join("");
    }

    function renderSlice(slice, copy, showCursor) {
      var leadLen = copy.lead.length;
      var leadPart = slice.slice(0, Math.min(slice.length, leadLen));
      var accentPart = slice.slice(leadLen);
      var hasAccent = accentPart.length > 0;

      if (!copy.multiline) {
        var flatHtml =
          '<span class="pullquote__lead">' +
          escapeHtml(leadPart) +
          '</span><span class="pullquote__accent">' +
          escapeHtml(accentPart) +
          "</span>";
        if (showCursor) {
          flatHtml += '<span class="pullquote__cursor" aria-hidden="true"></span>';
        }
        return flatHtml;
      }

      return (
        linesHtml(leadPart, "lead", showCursor && !hasAccent) +
        linesHtml(accentPart, "accent", showCursor && hasAccent)
      );
    }

    function showStatic() {
      root.classList.add("is-static");
      live.innerHTML = measure.innerHTML;
    }

    if (preferReduce || !("IntersectionObserver" in window)) {
      showStatic();
      return;
    }

    var started = false;
    var timer = null;
    var charIndex = 0;
    var charDelay = 52;
    var activeCopy = getCopy();
    var text = activeCopy.lead + activeCopy.accent;
    var scrollHost = root.closest(".scroll-reveal");

    function readyToAnimate() {
      return !scrollHost || scrollHost.classList.contains("is-visible");
    }

    function tryStart() {
      if (started || !readyToAnimate()) return;
      observer.disconnect();
      if (revealWatcher) revealWatcher.disconnect();
      startTyping();
    }

    function finish() {
      root.classList.add("is-complete");
      live.innerHTML = renderSlice(text, activeCopy, false);
    }

    function tick() {
      charIndex += 1;
      live.innerHTML = renderSlice(text.slice(0, charIndex), activeCopy, true);
      if (charIndex >= text.length) {
        finish();
        return;
      }
      timer = window.setTimeout(tick, charDelay);
    }

    function startTyping() {
      if (started) return;
      started = true;
      activeCopy = getCopy();
      text = activeCopy.lead + activeCopy.accent;
      charIndex = 0;
      live.innerHTML = "";
      tick();
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          tryStart();
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -4% 0px" }
    );

    observer.observe(root);

    var revealWatcher = null;
    if (scrollHost) {
      revealWatcher = new MutationObserver(tryStart);
      revealWatcher.observe(scrollHost, {
        attributes: true,
        attributeFilter: ["class"]
      });
    }

    tryStart();

    document.addEventListener(
      "visibilitychange",
      function () {
        if (!started || charIndex >= text.length) return;
        if (document.hidden) {
          if (timer) window.clearTimeout(timer);
          return;
        }
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(tick, 180);
      },
      false
    );
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
