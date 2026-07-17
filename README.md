# subhan.dev — git-backed portfolio

A personal portfolio that costs $0 to run and has a real admin portal.

- **The database is this repo.** `content.json` holds every word on the site; `media/` holds the profile picture and resume.
- **The backend is a build script.** `build.py` renders `content.json` through Jinja2 templates into pure static HTML in `dist/` (markdown case studies are sanitized with bleach — injected HTML cannot survive the build).
- **The deploy pipeline is a GitHub Action.** Every push to `main` rebuilds and publishes via the official Pages actions.
- **The admin is a static page.** `/admin/` edits `content.json` and uploads media by committing through the GitHub Contents API with a token that never leaves your browser.

No server, no database bill, no cold starts. The one trade-off: a publish takes ~60–90 seconds to appear (the admin tells you this after every publish).

## 1 · Put it on GitHub Pages

```bash
# 1. Create a repo named exactly:  Mrup1.github.io   (public, empty — no README)
# 2. From this folder:
git init -b main
git add .
git commit -m "initial site"
git remote add origin https://github.com/Mrup1/Mrup1.github.io.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Build and deployment → Source: “GitHub Actions.”**
The `build & deploy` workflow runs on that first push; when it finishes, the site is live at **https://mrup1.github.io/**.

## 2 · Create the admin token (fine-grained PAT)

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Repository access:** *Only select repositories* → `Mrup1/Mrup1.github.io`.
3. **Permissions → Repository permissions → Contents: Read and write.** Nothing else.
4. **Set an expiration** (90 days is sensible — when it expires, the admin shows a clear “invalid or expired” message and you just paste a new one).
5. Copy the token, open **https://mrup1.github.io/admin/**, paste it, done.

The token is stored in that browser's `localStorage` only. It is never committed, never put in a URL, never sent anywhere except `api.github.com`. “Forget this device” wipes it. The admin page itself is public HTML but inert without a token, carries `noindex`, and is excluded from the sitemap and disallowed in robots.txt.

## 3 · Using the admin

- **Projects / Links / Experience** — add, edit, reorder (↑↓), publish/unpublish, delete (with confirm). New projects land at the top.
- **Profile** — name, headline, hero text, about (markdown with live preview), skills block, email, open-to-work toggle (drives the status dot *and* the last boot-sequence line), profile picture (resized/compressed in your browser to ≤800px before committing), resume PDF (≤10 MB → `media/resume.pdf`; the nav's `resume` item only exists while a resume is uploaded).
- Every edit is staged locally first; **save & publish** commits media files, then `content.json`, and links you to the Action run. Live in ~1 minute.
- **Safety:** drafts autosave to the browser so a closed tab loses nothing; leaving with unpublished changes warns you; if `content.json` changed on GitHub since you loaded it (another device, a direct edit), the publish is refused with a “reload latest & re-apply” prompt — never a silent overwrite.

## 4 · Backup & undo

`content.json` + `media/` **are** the backup. Every publish is a commit, so git history is a full undo trail — revert any commit on GitHub to roll the site back. Deleting a project in the admin only deletes it from the current version; history keeps it forever.

## 5 · Local development

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python build.py
python3 -m http.server -d dist 8000     # http://localhost:8000
```

## 6 · Decisions that weren't in the spec

1. **The social/OG card ships as `og.svg`.** The build stack is deliberately tiny (jinja2 + markdown + bleach — no Pillow), so no raster rendering happens at build time. GitHub/Slack render SVG og-images; a few scrapers (notably LinkedIn) prefer PNG — if that ever matters, export `static/og.svg` to `static/og.png` once and swap the two `og.svg` references in `templates/index.html`.
2. **The nav `resume` item is a normal link row that `build.py` suppresses** whenever `profile.resume` is null (matched by its `media/resume.pdf` URL). This keeps “links” fully data-driven in the admin while still guaranteeing no dead resume link can ever render.
3. **Site-level meta lives in a small `site` block in `content.json`** (title, description, canonical URL, footer line) rather than being hardcoded in the template — the schema in the spec didn't place it, and the contract stays “everything on the page comes from content.json.”
4. **Removing the profile picture unlinks it rather than deleting the file** — the monogram fallback renders immediately, and the old image stays in git history (consistent with the backup philosophy above).
