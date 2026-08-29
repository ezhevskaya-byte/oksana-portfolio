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

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        toggle.click();
      }
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
        var media = project.image
          ? '<img src="' +
            project.image +
            '" alt="' +
            escapeHtml(project.imageLabel || title) +
            '">'
          : '<div class="media-placeholder" aria-hidden="true"></div>';

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

        return (
          '<a class="project-card" href="' +
          project.href +
          '">' +
          '<div class="project-card__media media-frame">' +
          media +
          "</div>" +
          '<div class="project-card__body">' +
          meta +
          "<h3>" +
          escapeHtml(title) +
          "</h3>" +
          description +
          '<span class="project-card__link">' +
          escapeHtml(project.linkLabel || "Подробнее") +
          "</span>" +
          "</div></a>"
        );
      })
      .join("");

    grid.innerHTML = cards;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
