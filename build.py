#!/usr/bin/env python3
"""Render content.json + templates/ into a fully static site in dist/.

This is the entire "backend": GitHub is the database (content.json + media/),
this script is the render layer, GitHub Actions is the deploy pipeline.
"""

import hashlib
import json
import re
import shutil
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import bleach
import markdown
from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

ROOT = Path(__file__).parent.resolve()
DIST = ROOT / "dist"

# Tags/attributes allowed to survive markdown rendering. Anything else —
# notably <script>, <style>, event handlers — is stripped by bleach.
ALLOWED_TAGS = [
    "p", "br", "strong", "em", "a", "ul", "ol", "li",
    "code", "pre", "blockquote", "h3", "h4", "hr",
]
ALLOWED_ATTRS = {"a": ["href", "title", "rel", "target"]}
ALLOWED_PROTOCOLS = ["http", "https", "mailto"]


SCRIPTISH = re.compile(r"(?is)<(script|style)\b.*?</\1\s*>")


def md(text):
    """Markdown -> sanitized HTML. Safe against injected markup in content.json.

    bleach is the security layer (drops every disallowed tag/attribute/protocol);
    the regex just removes script/style *content* too, so nothing inert leaks
    into the page as stray text.
    """
    html = markdown.markdown(
        SCRIPTISH.sub("", text or ""), extensions=["smarty"], output_format="html5"
    )
    clean = bleach.clean(
        html,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRS,
        protocols=ALLOWED_PROTOCOLS,
        strip=True,
    )
    return Markup(clean)


def asset_hash(path):
    """Short content hash for cache-busting query strings."""
    return hashlib.sha1(path.read_bytes()).hexdigest()[:10]


def load_content():
    path = ROOT / "content.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        sys.exit("build.py: content.json not found — it must live next to build.py")
    except json.JSONDecodeError as e:
        sys.exit(f"build.py: content.json is not valid JSON — {e}")
    for key in ("site", "profile", "projects", "links", "experience"):
        if key not in data:
            sys.exit(f"build.py: content.json is missing required key: {key!r}")
    return data


def published_sorted(items):
    return sorted(
        (i for i in items if i.get("published")),
        key=lambda i: i.get("sort_order", 0),
    )


def build():
    content = load_content()
    profile = content["profile"]

    projects = published_sorted(content["projects"])
    experience = published_sorted(content["experience"])
    links = {
        loc: [l for l in published_sorted(content["links"]) if l.get("location") == loc]
        for loc in ("nav", "hero", "footer")
    }
    # The nav "resume" item is only shown once a resume actually exists.
    if not profile.get("resume"):
        links["nav"] = [l for l in links["nav"] if l.get("url") != "media/resume.pdf"]

    # Pre-render markdown fields once, sanitized.
    for p in projects:
        p["case_study_html"] = md(p.get("case_study"))
    for e in experience:
        e["description_html"] = md(e.get("description"))
    about_html = md(profile.get("about_text"))

    boot_lines = [
        "$ initializing subhan.dev",
        "▸ loading models........ ok",
        "▸ guardrails............ active",
        "▸ tracing............... enabled",
        "▸ status................ "
        + ("open to work" if profile.get("open_to_work") else "heads down, building"),
    ]

    env = Environment(
        loader=FileSystemLoader(ROOT / "templates"),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()

    # Static assets + media + admin are copied through verbatim.
    shutil.copytree(ROOT / "static", DIST / "static")
    shutil.copytree(ROOT / "admin", DIST / "admin")
    media_src = ROOT / "media"
    if media_src.is_dir():
        shutil.copytree(media_src, DIST / "media")
    else:
        (DIST / "media").mkdir()

    ctx = {
        "site": content["site"],
        "profile": profile,
        "projects": projects,
        "experience": experience,
        "links": links,
        "about_html": about_html,
        "boot_lines": boot_lines,
        "css_v": asset_hash(ROOT / "static" / "styles.css"),
        "js_v": asset_hash(ROOT / "static" / "script.js"),
        "build_year": datetime.now(timezone.utc).year,
    }
    (DIST / "index.html").write_text(
        env.get_template("index.html").render(**ctx), encoding="utf-8"
    )

    canonical = content["site"]["canonical_url"].rstrip("/") + "/"
    (DIST / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemap.org/schemas/sitemap/0.9" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
        f"  <url><loc>{canonical}</loc><lastmod>{date.today().isoformat()}</lastmod></url>\n"
        "</urlset>\n".replace(
            "http://www.sitemap.org/schemas/sitemap/0.9",
            "http://www.sitemaps.org/schemas/sitemap/0.9",
        ),
        encoding="utf-8",
    )
    (DIST / "robots.txt").write_text(
        "User-agent: *\n"
        "Disallow: /admin/\n"
        "Allow: /\n\n"
        f"Sitemap: {canonical}sitemap.xml\n",
        encoding="utf-8",
    )

    n_files = sum(1 for f in DIST.rglob("*") if f.is_file())
    print(f"built dist/ — {len(projects)} projects, {n_files} files")


if __name__ == "__main__":
    build()
