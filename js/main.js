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
      .map(function (project) {
        var title = project.title || project.type;
        var media;

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
          done +
          detail +
          link +
          "</div>";

        var mediaBlock = '<div class="' + mediaClass + '">' + media + "</div>";

        if (project.noLink) {
          return '<article class="project-card">' + mediaBlock + body + "</article>";
        }

        return (
          '<a class="project-card" href="' +
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

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
