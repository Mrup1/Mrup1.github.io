/* admin — git-backed CMS over the GitHub Contents API.
   The token lives in localStorage on this device only; every write is a
   commit to Mrup1/Mrup1.github.io and the Pages Action rebuilds the site. */
(function () {
  "use strict";

  var OWNER = "Mrup1";
  var REPO = "Mrup1.github.io";
  var BRANCH = "main";
  var API = "https://api.github.com/repos/" + OWNER + "/" + REPO;
  var ACTIONS_URL = "https://github.com/" + OWNER + "/" + REPO + "/actions";
  var TOKEN_KEY = "sr_admin_token";
  var DRAFT_KEY = "sr_admin_draft";
  var BACKUP_KEY = "sr_admin_conflict_backup";

  var token = null;
  var content = null;      // working copy of content.json
  var contentSha = null;   // sha of content.json when last read — sent on write
  var pendingMedia = [];   // [{path, base64, message, dataUrl}] committed before content.json
  var dirty = false;
  var view = "dashboard";
  var editing = null;      // id of item being edited, or "new"
  var draftTimer = null;

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
  }

  function uid(title) {
    var r = new Uint8Array(2);
    crypto.getRandomValues(r);
    return slug(title) + "-" + Array.prototype.map.call(r, function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
  }

  function byOrder(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); }

  function relTime(iso) {
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    if (mins < 48 * 60) return Math.round(mins / 60) + " h ago";
    return Math.round(mins / 1440) + " d ago";
  }

  /* tiny markdown preview: escape everything first, then re-introduce a
     whitelisted subset. Never inserts raw input into the DOM. */
  function mdPreview(src) {
    var t = esc(src);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t.split(/\n{2,}/).map(function (p) {
      return "<p>" + p.replace(/\n/g, "<br>") + "</p>";
    }).join("");
  }

  /* ── GitHub API ─────────────────────────────────────────── */

  function gh(path, opts) {
    opts = opts || {};
    var headers = {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (opts.headers) for (var k in opts.headers) headers[k] = opts.headers[k];
    return fetch(API + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body || undefined
    });
  }

  function apiMessage(res) {
    return res.json().then(function (j) {
      return (j && j.message) ? j.message : ("HTTP " + res.status);
    }, function () { return "HTTP " + res.status; });
  }

  /* ── banner / publish bar ───────────────────────────────── */

  function banner(html, kind) {
    var b = $("#banner");
    if (!html) { b.hidden = true; b.innerHTML = ""; return; }
    b.className = "banner" + (kind ? " " + kind : "");
    b.innerHTML = html;
    b.hidden = false;
  }

  function updatePublishBar() {
    $("#publishbar").hidden = !(dirty || pendingMedia.length);
  }

  function markDirty() {
    dirty = true;
    updatePublishBar();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(content)); } catch (e) { /* full */ }
    }, 400);
  }

  function clearDraft() {
    localStorage.removeItem(DRAFT_KEY);
  }

  window.addEventListener("beforeunload", function (e) {
    if (dirty || pendingMedia.length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  /* ── auth ───────────────────────────────────────────────── */

  function authError(status) {
    if (status === 401) return "Token is invalid or expired. Generate a new fine-grained token and try again.";
    if (status === 403) return "GitHub rejected the token (403). Check that it hasn't expired and that it can access " + OWNER + "/" + REPO + ".";
    if (status === 404) return "This token can't see " + OWNER + "/" + REPO + ". Grant it access to that repository with Contents: Read and write.";
    return "GitHub returned HTTP " + status + ". Check your connection and token.";
  }

  function validateToken(candidate) {
    token = candidate;
    return gh("").then(function (res) {
      if (!res.ok) { token = null; throw new Error(authError(res.status)); }
      return res.json();
    }).then(function (repo) {
      if (repo.permissions && repo.permissions.push === false) {
        token = null;
        throw new Error("Token is read-only. It needs Contents: Read and write on " + OWNER + "/" + REPO + ".");
      }
    });
  }

  function showAuth(msg) {
    $("#loading").hidden = true;
    $("#app").hidden = true;
    $("#auth").hidden = false;
    var err = $("#auth-error");
    if (msg) { err.textContent = msg; err.hidden = false; } else { err.hidden = true; }
  }

  function showApp() {
    $("#loading").hidden = true;
    $("#auth").hidden = true;
    $("#app").hidden = false;
    $("#actions-link").href = ACTIONS_URL;
    setView(view);
  }

  /* ── content load / publish ─────────────────────────────── */

  function loadContent() {
    return gh("/contents/content.json?ref=" + BRANCH).then(function (res) {
      if (!res.ok) return apiMessage(res).then(function (m) {
        throw new Error("Couldn't read content.json — " + m);
      });
      return res.json();
    }).then(function (data) {
      contentSha = data.sha;
      content = JSON.parse(b64decode(data.content));
      var draft = localStorage.getItem(DRAFT_KEY);
      if (draft && draft !== JSON.stringify(content)) {
        try {
          content = JSON.parse(draft);
          dirty = true;
          banner('Restored an unsaved draft from this browser. <button class="btn btn-sm btn-ghost" data-act="discard-draft">discard draft</button>', "warn");
        } catch (e) { clearDraft(); }
      }
      updatePublishBar();
    });
  }

  function publish() {
    var btn = $("#publish");
    btn.disabled = true;
    btn.textContent = "publishing…";
    banner("");

    var chain = Promise.resolve();
    pendingMedia.forEach(function (m) {
      chain = chain.then(function () {
        return gh("/contents/" + m.path + "?ref=" + BRANCH).then(function (head) {
          if (head.ok) return head.json().then(function (j) { return j.sha; });
          return undefined;
        }).then(function (sha) {
          var body = { message: m.message, content: m.base64, branch: BRANCH };
          if (sha) body.sha = sha;
          return gh("/contents/" + m.path, { method: "PUT", body: JSON.stringify(body) });
        }).then(function (res) {
          if (!res.ok) return apiMessage(res).then(function (msg) {
            throw new Error("Uploading " + m.path + " failed — " + msg);
          });
        });
      });
    });

    chain.then(function () {
      var body = {
        message: "admin: update site content",
        content: b64encode(JSON.stringify(content, null, 2) + "\n"),
        branch: BRANCH,
        sha: contentSha
      };
      return gh("/contents/content.json", { method: "PUT", body: JSON.stringify(body) });
    }).then(function (res) {
      if (res.status === 409 || res.status === 422) {
        return apiMessage(res).then(function (msg) {
          if (res.status === 409 || /sha|match/i.test(msg)) {
            try { localStorage.setItem(BACKUP_KEY, JSON.stringify(content)); } catch (e) { /* full */ }
            banner(
              "content.json changed on GitHub since you loaded it (another device, or a direct edit). " +
              "Nothing was overwritten. Your unsaved version was backed up in this browser. " +
              '<button class="btn btn-sm btn-ghost" data-act="reload-latest">reload latest & re-apply</button>',
              "warn"
            );
            throw { handled: true };
          }
          throw new Error(msg);
        });
      }
      if (!res.ok) return apiMessage(res).then(function (msg) { throw new Error("Publish failed — " + msg); });
      return res.json().then(function (j) {
        contentSha = j.content.sha;
        pendingMedia = [];
        dirty = false;
        clearDraft();
        updatePublishBar();
        banner('Published. The site rebuilds automatically — <strong>live in ~1 minute</strong>. <a href="' + ACTIONS_URL + '" target="_blank" rel="noopener">watch the Action run ↗</a>');
        render();
      });
    }).catch(function (e) {
      if (!e || !e.handled) banner(esc(e && e.message ? e.message : "Publish failed."), "bad");
    }).then(function () {
      btn.disabled = false;
      btn.textContent = "save & publish";
    });
  }

  function reloadLatest() {
    pendingMedia = [];
    dirty = false;
    clearDraft();
    banner("");
    $("#view").innerHTML = '<p class="label">// loading…</p>';
    loadContent().then(render, function (e) { banner(esc(e.message), "bad"); });
  }

  /* ── views ──────────────────────────────────────────────── */

  function setView(v) {
    view = v;
    editing = null;
    $$(".rail-link[data-view]").forEach(function (b) {
      b.classList.toggle("active", b.dataset.view === v);
    });
    render();
  }

  function render() {
    updatePublishBar();
    var host = $("#view");
    if (view === "dashboard") host.innerHTML = viewDashboard();
    else if (view === "projects") host.innerHTML = viewProjects();
    else if (view === "profile") host.innerHTML = viewProfile();
    else if (view === "links") host.innerHTML = viewLinks();
    else if (view === "experience") host.innerHTML = viewExperience();
    afterRender();
  }

  function viewDashboard() {
    var pub = content.projects.filter(function (p) { return p.published; }).length;
    var drafts = content.projects.length - pub;
    var h = "<h2>dashboard</h2>" +
      '<p class="view-sub">Publishing commits to <code>' + OWNER + "/" + REPO + '</code>; the GitHub Action rebuilds the site in about a minute.</p>' +
      '<div class="stats">' +
      '<div class="stat"><b>' + pub + "</b><span>published projects</span></div>" +
      '<div class="stat"><b>' + drafts + "</b><span>draft projects</span></div>" +
      '<div class="stat"><b>' + content.links.filter(function (l) { return l.published; }).length + "</b><span>live links</span></div>" +
      '<div class="stat"><b>' + (dirty || pendingMedia.length ? "yes" : "no") + "</b><span>unpublished changes</span></div>" +
      "</div>" +
      '<p class="label" id="last-commit">// last commit: …</p>' +
      '<p class="view-sub" style="margin-top:16px">Quick links: <a href="/" target="_blank" rel="noopener">live site ↗</a> · <a href="' + ACTIONS_URL + '" target="_blank" rel="noopener">action runs ↗</a> · <a href="https://github.com/' + OWNER + "/" + REPO + '" target="_blank" rel="noopener">repository ↗</a></p>';
    return h;
  }

  function loadLastCommit() {
    var elc = $("#last-commit");
    if (!elc) return;
    gh("/commits?sha=" + BRANCH + "&per_page=1").then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (list) {
      if (list && list[0]) {
        var c = list[0].commit;
        elc.textContent = "// last commit: " + relTime(c.committer.date) + ' — "' + c.message.split("\n")[0] + '"';
      } else {
        elc.textContent = "// last commit: unavailable";
      }
    }).catch(function () { elc.textContent = "// last commit: unavailable"; });
  }

  /* ── projects ── */

  function viewProjects() {
    var list = content.projects.slice().sort(byOrder);
    if (editing !== null) return projectForm(editing === "new" ? null : list.find(function (p) { return p.id === editing; }));
    var rows = list.map(function (p, i) {
      return '<div class="row' + (p.published ? "" : " unpub") + '">' +
        '<div class="row-actions">' +
        '<button class="btn btn-sm" data-act="up" data-kind="projects" data-id="' + esc(p.id) + '"' + (i === 0 ? " disabled" : "") + ">↑</button>" +
        '<button class="btn btn-sm" data-act="down" data-kind="projects" data-id="' + esc(p.id) + '"' + (i === list.length - 1 ? " disabled" : "") + ">↓</button>" +
        "</div>" +
        '<div class="row-main"><div class="row-title">' + esc(p.title) + "</div>" +
        '<div class="row-sub">' + esc(p.meta_tags) + (p.badge ? " · [" + esc(p.badge.text) + "]" : "") + (p.published ? "" : " · DRAFT") + "</div></div>" +
        '<div class="row-actions">' +
        '<button class="btn btn-sm" data-act="toggle" data-kind="projects" data-id="' + esc(p.id) + '">' + (p.published ? "unpublish" : "publish") + "</button>" +
        '<button class="btn btn-sm" data-act="edit" data-id="' + esc(p.id) + '">edit</button>' +
        '<button class="btn btn-sm btn-danger" data-act="del" data-kind="projects" data-id="' + esc(p.id) + '">delete</button>' +
        "</div></div>";
    }).join("");
    return "<h2>projects</h2>" +
      '<p class="view-sub">Order here is the order on the site. New projects land on top.</p>' +
      '<div class="rows">' + (rows || '<p class="view-sub">No projects yet.</p>') + "</div>" +
      '<button class="btn" data-act="new">+ new project</button>';
  }

  function projectForm(p) {
    var isNew = !p;
    p = p || { title: "", meta_tags: "", badge: null, one_liner: "", case_study: "", stack_line: "", repo_url: "", live_url: "", published: true };
    return "<h2>" + (isNew ? "new project" : "edit project") + "</h2>" +
      '<form class="form" data-form="project" data-id="' + esc(isNew ? "" : p.id) + '"><div class="form-grid">' +
      '<div class="full"><label class="label" for="f-title">title</label>' +
      '<input id="f-title" name="title" required value="' + esc(p.title) + '"></div>' +
      '<div><label class="label" for="f-meta">meta tags (e.g. RAG · FAISS · MMR)</label>' +
      '<input id="f-meta" name="meta_tags" value="' + esc(p.meta_tags) + '"></div>' +
      '<div><label class="label" for="f-badge">badge text (empty = no badge)</label>' +
      '<input id="f-badge" name="badge_text" value="' + esc(p.badge ? p.badge.text : "") + '"></div>' +
      '<div><label class="label" for="f-badge-color">badge color</label>' +
      '<select id="f-badge-color" name="badge_color">' +
      '<option value="amber"' + (!p.badge || p.badge.color === "amber" ? " selected" : "") + ">amber</option>" +
      '<option value="green"' + (p.badge && p.badge.color === "green" ? " selected" : "") + ">green</option>" +
      "</select></div>" +
      '<div><label class="label" for="f-stack">stack line</label>' +
      '<input id="f-stack" name="stack_line" value="' + esc(p.stack_line) + '"></div>' +
      '<div class="full"><label class="label" for="f-one">one-liner</label>' +
      '<input id="f-one" name="one_liner" value="' + esc(p.one_liner) + '"></div>' +
      '<div class="full"><label class="label" for="f-case">case study (markdown)</label>' +
      '<textarea id="f-case" name="case_study" class="tall" data-preview="case-preview">' + esc(p.case_study) + "</textarea>" +
      '<div class="label">preview</div><div class="mono-preview" id="case-preview">' + mdPreview(p.case_study) + "</div></div>" +
      '<div><label class="label" for="f-repo">repo url (empty = private repo line)</label>' +
      '<input id="f-repo" name="repo_url" type="url" placeholder="https://github.com/…" value="' + esc(p.repo_url || "") + '"></div>' +
      '<div><label class="label" for="f-live">live url</label>' +
      '<input id="f-live" name="live_url" type="url" placeholder="https://…" value="' + esc(p.live_url || "") + '"></div>' +
      '<div class="full check"><label><input type="checkbox" name="published"' + (p.published ? " checked" : "") + "> published</label></div>" +
      '</div><div class="form-actions">' +
      '<button type="submit" class="btn btn-primary">apply</button>' +
      '<button type="button" class="btn btn-ghost" data-act="cancel">cancel</button>' +
      "</div></form>";
  }

  /* ── profile ── */

  function viewProfile() {
    var pr = content.profile;
    var pendingImg = pendingMedia.find(function (m) { return m.path === pr.profile_image; });
    var imgSrc = pendingImg ? pendingImg.dataUrl : (pr.profile_image ? "../" + pr.profile_image : null);
    return "<h2>profile</h2>" +
      '<p class="view-sub">Hero, about, skills, and the files behind them.</p>' +
      '<form class="form" data-form="profile"><div class="form-grid">' +
      '<div><label class="label" for="pf-name">name</label><input id="pf-name" name="name" required value="' + esc(pr.name) + '"></div>' +
      '<div><label class="label" for="pf-email">email</label><input id="pf-email" name="email" type="email" required value="' + esc(pr.email) + '"></div>' +
      '<div class="full"><label class="label" for="pf-headline">headline</label><input id="pf-headline" name="headline" value="' + esc(pr.headline) + '"></div>' +
      '<div class="full"><label class="label" for="pf-hero">hero support text</label><textarea id="pf-hero" name="hero_support_text">' + esc(pr.hero_support_text) + "</textarea></div>" +
      '<div class="full"><label class="label" for="pf-about">about text (markdown)</label><textarea id="pf-about" name="about_text" data-preview="about-preview">' + esc(pr.about_text) + "</textarea>" +
      '<div class="label">preview</div><div class="mono-preview" id="about-preview">' + mdPreview(pr.about_text) + "</div></div>" +
      '<div class="full"><label class="label" for="pf-skills">skills block (monospace, preformatted)</label><textarea id="pf-skills" name="skills_block" class="tall" style="font-family:var(--mono);white-space:pre">' + esc(pr.skills_block) + "</textarea></div>" +
      '<div class="full check"><label><input type="checkbox" name="open_to_work"' + (pr.open_to_work ? " checked" : "") + "> open to work (status dot + boot line)</label></div>" +
      "</div>" +
      '<div class="form-grid" style="margin-top:16px">' +
      '<div><div class="label">profile picture</div>' +
      (imgSrc
        ? '<img class="img-preview" id="img-preview" alt="Current profile picture" src="' + esc(imgSrc) + '">'
        : '<div class="img-placeholder">SR</div>') +
      '<input type="file" id="img-file" accept="image/*" aria-label="Upload profile picture">' +
      '<p class="file-note">resized client-side to max 800px before commit</p>' +
      (pr.profile_image ? '<button type="button" class="btn btn-sm btn-danger" data-act="remove-image">remove picture</button>' : "") +
      "</div>" +
      '<div><div class="label">resume (pdf, ≤ 10 MB)</div>' +
      '<p class="file-note" style="margin-top:8px">' + (pr.resume ? "current: " + esc(pr.resume) : "none — the nav hides its resume item until one is uploaded") + "</p>" +
      '<input type="file" id="resume-file" accept="application/pdf" aria-label="Upload resume PDF">' +
      (pr.resume ? '<button type="button" class="btn btn-sm btn-danger" data-act="remove-resume">remove resume</button>' : "") +
      "</div></div>" +
      '<div class="form-actions" style="margin-top:16px">' +
      '<button type="submit" class="btn btn-primary">apply</button>' +
      "</div></form>";
  }

  /* ── links ── */

  function viewLinks() {
    if (editing !== null) {
      var item = editing === "new" ? null : content.links.find(function (l) { return l.id === editing; });
      return linkForm(item);
    }
    var out = "<h2>links</h2><p class=\"view-sub\">Grouped by location; order applies within each group.</p>";
    ["nav", "hero", "footer"].forEach(function (loc) {
      var list = content.links.filter(function (l) { return l.location === loc; }).sort(byOrder);
      out += '<p class="label" style="margin:20px 0 8px">// ' + loc + "</p>" +
        '<div class="rows">' + (list.map(function (l, i) {
          return '<div class="row' + (l.published ? "" : " unpub") + '">' +
            '<div class="row-actions">' +
            '<button class="btn btn-sm" data-act="up" data-kind="links" data-id="' + esc(l.id) + '"' + (i === 0 ? " disabled" : "") + ">↑</button>" +
            '<button class="btn btn-sm" data-act="down" data-kind="links" data-id="' + esc(l.id) + '"' + (i === list.length - 1 ? " disabled" : "") + ">↓</button>" +
            "</div>" +
            '<div class="row-main"><div class="row-title">' + esc(l.label) + "</div>" +
            '<div class="row-sub">' + esc(l.url) + (l.published ? "" : " · DRAFT") + "</div></div>" +
            '<div class="row-actions">' +
            '<button class="btn btn-sm" data-act="toggle" data-kind="links" data-id="' + esc(l.id) + '">' + (l.published ? "unpublish" : "publish") + "</button>" +
            '<button class="btn btn-sm" data-act="edit" data-id="' + esc(l.id) + '">edit</button>' +
            '<button class="btn btn-sm btn-danger" data-act="del" data-kind="links" data-id="' + esc(l.id) + '">delete</button>' +
            "</div></div>";
        }).join("") || '<p class="view-sub">none</p>') + "</div>";
    });
    return out + '<button class="btn" data-act="new">+ new link</button>';
  }

  function linkForm(l) {
    var isNew = !l;
    l = l || { label: "", url: "", location: "nav", published: true };
    return "<h2>" + (isNew ? "new link" : "edit link") + "</h2>" +
      '<form class="form" data-form="link" data-id="' + esc(isNew ? "" : l.id) + '"><div class="form-grid">' +
      '<div><label class="label" for="lf-label">label</label><input id="lf-label" name="label" required value="' + esc(l.label) + '"></div>' +
      '<div><label class="label" for="lf-loc">location</label><select id="lf-loc" name="location">' +
      ["nav", "hero", "footer"].map(function (loc) {
        return '<option value="' + loc + '"' + (l.location === loc ? " selected" : "") + ">" + loc + "</option>";
      }).join("") + "</select></div>" +
      '<div class="full"><label class="label" for="lf-url">url (https://…, mailto:…, or #anchor)</label>' +
      '<input id="lf-url" name="url" required value="' + esc(l.url) + '"></div>' +
      '<div class="full check"><label><input type="checkbox" name="published"' + (l.published ? " checked" : "") + "> published</label></div>" +
      '</div><div class="form-actions">' +
      '<button type="submit" class="btn btn-primary">apply</button>' +
      '<button type="button" class="btn btn-ghost" data-act="cancel">cancel</button>' +
      "</div></form>";
  }

  /* ── experience ── */

  function viewExperience() {
    if (editing !== null) {
      var item = editing === "new" ? null : content.experience.find(function (x) { return x.id === editing; });
      return xpForm(item);
    }
    var list = content.experience.slice().sort(byOrder);
    var rows = list.map(function (x, i) {
      return '<div class="row' + (x.published ? "" : " unpub") + '">' +
        '<div class="row-actions">' +
        '<button class="btn btn-sm" data-act="up" data-kind="experience" data-id="' + esc(x.id) + '"' + (i === 0 ? " disabled" : "") + ">↑</button>" +
        '<button class="btn btn-sm" data-act="down" data-kind="experience" data-id="' + esc(x.id) + '"' + (i === list.length - 1 ? " disabled" : "") + ">↓</button>" +
        "</div>" +
        '<div class="row-main"><div class="row-title">' + esc(x.role) + "</div>" +
        '<div class="row-sub">' + esc(x.organization) + (x.published ? "" : " · DRAFT") + "</div></div>" +
        '<div class="row-actions">' +
        '<button class="btn btn-sm" data-act="toggle" data-kind="experience" data-id="' + esc(x.id) + '">' + (x.published ? "unpublish" : "publish") + "</button>" +
        '<button class="btn btn-sm" data-act="edit" data-id="' + esc(x.id) + '">edit</button>' +
        '<button class="btn btn-sm btn-danger" data-act="del" data-kind="experience" data-id="' + esc(x.id) + '">delete</button>' +
        "</div></div>";
    }).join("");
    return "<h2>experience</h2>" +
      '<div class="rows" style="margin-top:20px">' + (rows || '<p class="view-sub">No entries yet.</p>') + "</div>" +
      '<button class="btn" data-act="new">+ new entry</button>';
  }

  function xpForm(x) {
    var isNew = !x;
    x = x || { role: "", organization: "", org_url: "", sub_label: "", description: "", published: true };
    return "<h2>" + (isNew ? "new experience" : "edit experience") + "</h2>" +
      '<form class="form" data-form="experience" data-id="' + esc(isNew ? "" : x.id) + '"><div class="form-grid">' +
      '<div><label class="label" for="xf-role">role</label><input id="xf-role" name="role" required value="' + esc(x.role) + '"></div>' +
      '<div><label class="label" for="xf-org">organization</label><input id="xf-org" name="organization" required value="' + esc(x.organization) + '"></div>' +
      '<div><label class="label" for="xf-url">organization url</label><input id="xf-url" name="org_url" type="url" value="' + esc(x.org_url || "") + '"></div>' +
      '<div><label class="label" for="xf-sub">sub label (e.g. BACKEND · TEAM MANAGER)</label><input id="xf-sub" name="sub_label" value="' + esc(x.sub_label) + '"></div>' +
      '<div class="full"><label class="label" for="xf-desc">description (markdown)</label>' +
      '<textarea id="xf-desc" name="description" class="tall" data-preview="xp-preview">' + esc(x.description) + "</textarea>" +
      '<div class="label">preview</div><div class="mono-preview" id="xp-preview">' + mdPreview(x.description) + "</div></div>" +
      '<div class="full check"><label><input type="checkbox" name="published"' + (x.published ? " checked" : "") + "> published</label></div>" +
      '</div><div class="form-actions">' +
      '<button type="submit" class="btn btn-primary">apply</button>' +
      '<button type="button" class="btn btn-ghost" data-act="cancel">cancel</button>' +
      "</div></form>";
  }

  /* ── mutations ──────────────────────────────────────────── */

  function collection(kind) { return content[kind]; }

  function reorder(kind, id, dir) {
    var all = collection(kind);
    var item = all.find(function (i) { return i.id === id; });
    if (!item) return;
    var group = kind === "links"
      ? all.filter(function (l) { return l.location === item.location; }).sort(byOrder)
      : all.slice().sort(byOrder);
    var idx = group.indexOf(item);
    var swap = group[idx + dir];
    if (!swap) return;
    group[idx] = swap;
    group[idx + dir] = item;
    group.forEach(function (g, i) { g.sort_order = i + 1; });
    markDirty();
    render();
  }

  function applyForm(form) {
    var kind = form.dataset.form;
    var id = form.dataset.id;
    var fd = new FormData(form);
    var get = function (n) { return String(fd.get(n) || "").trim(); };
    var published = form.querySelector('[name="published"]');

    if (kind === "profile") {
      var pr = content.profile;
      pr.name = get("name");
      pr.email = get("email");
      pr.headline = get("headline");
      pr.hero_support_text = get("hero_support_text");
      pr.about_text = String(fd.get("about_text") || "");
      pr.skills_block = String(fd.get("skills_block") || "");
      pr.open_to_work = form.querySelector('[name="open_to_work"]').checked;
      markDirty();
      banner("Profile changes staged — save &amp; publish when ready.");
      render();
      return;
    }

    if (kind === "project") {
      var badgeText = get("badge_text");
      var data = {
        title: get("title"),
        meta_tags: get("meta_tags"),
        badge: badgeText ? { text: badgeText, color: get("badge_color") === "green" ? "green" : "amber" } : null,
        one_liner: get("one_liner"),
        case_study: String(fd.get("case_study") || ""),
        stack_line: get("stack_line"),
        repo_url: get("repo_url") || null,
        live_url: get("live_url") || null,
        published: published.checked
      };
      if (id) {
        var p = content.projects.find(function (x) { return x.id === id; });
        Object.assign(p, data);
      } else {
        data.id = uid(data.title);
        data.sort_order = 0;
        content.projects.push(data);
        content.projects.sort(byOrder).forEach(function (x, i) { x.sort_order = i + 1; });
      }
    } else if (kind === "link") {
      var ldata = {
        label: get("label"),
        url: get("url"),
        location: get("location"),
        published: published.checked
      };
      if (id) {
        var l = content.links.find(function (x) { return x.id === id; });
        Object.assign(l, ldata);
      } else {
        ldata.id = uid(ldata.label);
        var max = content.links.filter(function (x) { return x.location === ldata.location; })
          .reduce(function (m, x) { return Math.max(m, x.sort_order || 0); }, 0);
        ldata.sort_order = max + 1;
        content.links.push(ldata);
      }
    } else if (kind === "experience") {
      var xdata = {
        role: get("role"),
        organization: get("organization"),
        org_url: get("org_url") || null,
        sub_label: get("sub_label"),
        description: String(fd.get("description") || ""),
        published: published.checked
      };
      if (id) {
        var x = content.experience.find(function (i) { return i.id === id; });
        Object.assign(x, xdata);
      } else {
        xdata.id = uid(xdata.role);
        xdata.sort_order = 0;
        content.experience.push(xdata);
        content.experience.sort(byOrder).forEach(function (i, n) { i.sort_order = n + 1; });
      }
    }
    editing = null;
    markDirty();
    render();
  }

  /* ── media uploads ──────────────────────────────────────── */

  function stageMedia(path, base64, message, dataUrl) {
    pendingMedia = pendingMedia.filter(function (m) { return m.path !== path; });
    pendingMedia.push({ path: path, base64: base64, message: message, dataUrl: dataUrl });
    markDirty();
  }

  function handleImageFile(file) {
    if (!file || !/^image\//.test(file.type)) {
      banner("That doesn't look like an image file.", "bad");
      return;
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, 800 / Math.max(img.width, img.height));
      var w = Math.max(1, Math.round(img.width * scale));
      var h = Math.max(1, Math.round(img.height * scale));
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      var webp = c.toDataURL("image/webp", 0.85);
      var isWebp = webp.indexOf("data:image/webp") === 0;
      var dataUrl = isWebp ? webp : c.toDataURL("image/jpeg", 0.85);
      var path = "media/profile." + (isWebp ? "webp" : "jpg");
      stageMedia(path, dataUrl.split(",")[1], "admin: upload " + path, dataUrl);
      content.profile.profile_image = path;
      banner("Picture staged (" + w + "×" + h + ") — save &amp; publish to make it live.");
      render();
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      banner("Couldn't decode that image.", "bad");
    };
    img.src = url;
  }

  function handleResumeFile(file) {
    if (!file || file.type !== "application/pdf") {
      banner("Resume must be a PDF.", "bad");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      banner("Resume is over 10 MB — export a smaller PDF.", "bad");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var base64 = String(reader.result).split(",")[1];
      stageMedia("media/resume.pdf", base64, "admin: upload media/resume.pdf", null);
      content.profile.resume = "media/resume.pdf";
      banner("Resume staged — save &amp; publish to make it live (nav gains a “resume” item).");
      render();
    };
    reader.onerror = function () { banner("Couldn't read that PDF.", "bad"); };
    reader.readAsDataURL(file);
  }

  /* ── events ─────────────────────────────────────────────── */

  function afterRender() {
    if (view === "dashboard") loadLastCommit();

    $$("#view [data-preview]").forEach(function (ta) {
      var target = document.getElementById(ta.dataset.preview);
      if (!target) return;
      ta.addEventListener("input", function () { target.innerHTML = mdPreview(ta.value); });
    });

    var imgFile = $("#img-file");
    if (imgFile) imgFile.addEventListener("change", function () { handleImageFile(imgFile.files[0]); });
    var resumeFile = $("#resume-file");
    if (resumeFile) resumeFile.addEventListener("change", function () { handleResumeFile(resumeFile.files[0]); });

    var preview = $("#img-preview");
    if (preview) preview.addEventListener("error", function () {
      var ph = document.createElement("div");
      ph.className = "img-placeholder";
      ph.textContent = "SR";
      preview.replaceWith(ph);
    });
  }

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-act]");
    if (!t) return;
    var act = t.dataset.act;
    var kind = t.dataset.kind;
    var id = t.dataset.id;
    if (act === "new") { editing = "new"; render(); }
    else if (act === "edit") { editing = id; render(); }
    else if (act === "cancel") { editing = null; render(); }
    else if (act === "up") reorder(kind, id, -1);
    else if (act === "down") reorder(kind, id, 1);
    else if (act === "toggle") {
      var item = collection(kind).find(function (i) { return i.id === id; });
      if (item) { item.published = !item.published; markDirty(); render(); }
    } else if (act === "del") {
      var victim = collection(kind).find(function (i) { return i.id === id; });
      var name = victim && (victim.title || victim.label || victim.role) || id;
      if (window.confirm('Delete "' + name + '"? This is staged now and becomes permanent when you save & publish (git history still keeps it).')) {
        content[kind] = collection(kind).filter(function (i) { return i.id !== id; });
        markDirty();
        render();
      }
    } else if (act === "remove-image") {
      pendingMedia = pendingMedia.filter(function (m) { return m.path !== content.profile.profile_image; });
      content.profile.profile_image = null;
      markDirty();
      banner("Picture removed — the site falls back to the monogram after publish.");
      render();
    } else if (act === "remove-resume") {
      pendingMedia = pendingMedia.filter(function (m) { return m.path !== "media/resume.pdf"; });
      content.profile.resume = null;
      markDirty();
      banner("Resume unlinked — the nav item disappears after publish.");
      render();
    } else if (act === "discard-draft") {
      reloadLatest();
    } else if (act === "reload-latest") {
      reloadLatest();
    }
  });

  document.addEventListener("submit", function (e) {
    var form = e.target.closest("form[data-form]");
    if (form) { e.preventDefault(); applyForm(form); return; }
    if (e.target.id === "auth-form") {
      e.preventDefault();
      var candidate = $("#token").value.trim();
      var btn = $("#auth-submit");
      btn.disabled = true;
      btn.textContent = "checking…";
      validateToken(candidate).then(function () {
        localStorage.setItem(TOKEN_KEY, candidate);
        $("#loading").hidden = false;
        $("#auth").hidden = true;
        return loadContent().then(showApp);
      }).catch(function (err) {
        showAuth(err.message);
      }).then(function () {
        btn.disabled = false;
        btn.textContent = "unlock admin";
      });
    }
  });

  $$(".rail-link[data-view]").forEach(function (b) {
    b.addEventListener("click", function () {
      if (editing !== null && !window.confirm("Leave this form? Unapplied field edits are lost (applied changes are kept).")) return;
      setView(b.dataset.view);
    });
  });

  $("#forget").addEventListener("click", function () {
    if (!window.confirm("Forget the token and draft on this device?")) return;
    localStorage.removeItem(TOKEN_KEY);
    clearDraft();
    location.reload();
  });

  $("#publish").addEventListener("click", publish);
  $("#discard").addEventListener("click", function () {
    if (window.confirm("Discard all unpublished changes and reload from GitHub?")) reloadLatest();
  });

  /* ── boot ───────────────────────────────────────────────── */

  var saved = localStorage.getItem(TOKEN_KEY);
  if (!saved) {
    showAuth();
  } else {
    validateToken(saved).then(function () {
      return loadContent().then(showApp);
    }).catch(function (err) {
      localStorage.removeItem(TOKEN_KEY);
      showAuth(err.message);
    });
  }
})();
