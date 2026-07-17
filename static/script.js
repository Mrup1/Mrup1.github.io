/* trace viewer — boot sequence, span expansion, copy-to-clipboard */
(function () {
  "use strict";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── hero boot sequence ── */
  var boot = document.getElementById("boot");
  var hero = document.getElementById("hero-main");
  if (boot && hero) {
    var lines = Array.prototype.slice.call(boot.querySelectorAll(".boot-line"));
    var texts = lines.map(function (l) { return l.textContent; });
    var finished = false;
    var timers = [];

    var finish = function () {
      if (finished) return;
      finished = true;
      timers.forEach(clearTimeout);
      lines.forEach(function (l, i) {
        l.textContent = texts[i];
        l.style.visibility = "visible";
      });
      boot.classList.add("boot-done");
      hero.classList.add("on");
    };

    if (reduce) {
      boot.classList.add("boot-static");
      finish();
    } else {
      lines.forEach(function (l) {
        l.textContent = "";
        l.style.visibility = "visible";
      });
      lines.forEach(function (l, i) {
        var text = texts[i];
        timers.push(setTimeout(function () {
          var pos = 0;
          var tick = setInterval(function () {
            if (finished) { clearInterval(tick); return; }
            pos += 2;                       /* two chars per tick keeps it under budget */
            l.textContent = text.slice(0, pos);
            if (pos >= text.length) clearInterval(tick);
          }, 14);
          timers.push(tick);
        }, i * 350));
      });
      timers.push(setTimeout(finish, 350 * lines.length + 500)); /* always < 2.5s */
      var heroSection = boot.closest(".hero") || boot;
      heroSection.addEventListener("click", finish, { once: true });
    }
  }

  /* ── one trace span open at a time ── */
  var cards = Array.prototype.slice.call(document.querySelectorAll(".card"));
  cards.forEach(function (card) {
    var btn = card.querySelector(".card-title button");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var wasOpen = card.classList.contains("open");
      cards.forEach(function (c) {
        c.classList.remove("open");
        var b = c.querySelector(".card-title button");
        if (b) b.setAttribute("aria-expanded", "false");
      });
      if (!wasOpen) {
        card.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });

  /* ── copy email ── */
  Array.prototype.forEach.call(document.querySelectorAll(".copy"), function (btn) {
    btn.addEventListener("click", function () {
      var value = btn.getAttribute("data-copy") || "";
      var flash = function () {
        btn.textContent = "copied";
        btn.classList.add("done");
        setTimeout(function () {
          btn.textContent = "copy";
          btn.classList.remove("done");
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(flash, flash);
      } else {
        var ta = document.createElement("textarea");
        ta.value = value;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) { /* no-op */ }
        document.body.removeChild(ta);
        flash();
      }
    });
  });

  /* eslint-disable-next-line no-console */
  console.log(
    "You opened the console. Good instinct — the interesting stuff is always in the trace. → github.com/Mrup1"
  );
})();
