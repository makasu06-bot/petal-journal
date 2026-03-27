#!/usr/bin/env python3
"""
yjff — JustForFans downloader
Saves to: /Volumes/Marcus Ext/New Downloads/

Usage:
  yjff https://justfor.fans/CreatorName            # first 10 videos
  yjff https://justfor.fans/CreatorName --all      # all videos
  yjff https://justfor.fans/CreatorName --limit 25 # first 25 videos
  yjff "https://justfor.fans/CreatorName?Post=..."  # single post
"""

import argparse
import asyncio
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

SAVE_DIR   = Path("/Volumes/Marcus Ext/New Downloads")
OPERA_DIR  = Path.home() / "Library/Application Support/com.operasoftware.Opera"
DEFAULT_LIMIT = 10

# helpers

def log(msg: str):
    print(msg, flush=True)

def sanitize(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip()

# Opera cookie loader

def load_opera_cookies() -> dict:
    """Read JFF cookies from Opera Cookies SQLite DB."""
    log("Loading Opera cookies...")
    cookie_db = OPERA_DIR / "Default" / "Cookies"
    if not cookie_db.exists():
        cookie_db = OPERA_DIR / "Cookies"
    if not cookie_db.exists():
        log("ERROR: Opera Cookies DB not found. Log into JFF in Opera first.")
        sys.exit(1)

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    shutil.copy2(cookie_db, tmp_path)

    cookies = {}
    try:
        conn = sqlite3.connect(tmp_path)
        rows = conn.execute(
            "SELECT name, value FROM cookies WHERE host_key LIKE '%justfor.fans%'"
        ).fetchall()
        conn.close()
        for name, value in rows:
            if value and not value.startswith("v10"):
                cookies[name] = value
    finally:
        tmp_path.unlink(missing_ok=True)

    log(f"  Loaded {len(cookies)} JFF cookies from Opera")
    return cookies

# Playwright network interceptor

async def intercept_profile(profile_url: str, limit: int) -> list:
    """
    Load the JFF profile page in a real browser with Opera session.
    Intercept every API response and extract post/video data.
    This approach works regardless of JFF API endpoint changes.
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        log("ERROR: Playwright not installed.")
        log("  Run: pip3 install playwright && python3 -m playwright install chromium")
        sys.exit(1)

    posts = []
    seen_ids = set()

    async with async_playwright() as p:
        log(f"Loading profile: {profile_url}")
        browser = await p.chromium.launch_persistent_context(
            user_data_dir=str(OPERA_DIR),
            headless=True,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        )
        page = await browser.new_page()

        async def on_response(response):
            try:
                if "justfor.fans" not in response.url:
                    return
                ct = response.headers.get("content-type", "")
                if "json" not in ct:
                    return
                data = await response.json()
                _extract_posts(data, posts, seen_ids)
            except Exception:
                pass

        page.on("response", on_response)

        log("  Scrolling to load posts...")
        try:
            await page.goto(profile_url, wait_until="networkidle", timeout=60000)
        except Exception:
            await page.goto(profile_url, timeout=60000)

        await asyncio.sleep(3)

        prev_count = -1
        scrolls = 0
        max_scrolls = max(6, (limit // 5) + 2)
        while len(posts) < limit and scrolls < max_scrolls:
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await asyncio.sleep(2.5)
            scrolls += 1
            if len(posts) == prev_count:
                break
            prev_count = len(posts)
            if len(posts) > 0:
                log(f"  {len(posts)} post(s) found...")

        await browser.close()

    log(f"  Total posts intercepted: {len(posts)}")
    return posts[:limit]


def _extract_posts(data, posts: list, seen_ids: set):
    if isinstance(data, list):
        for item in data:
            _extract_posts(item, posts, seen_ids)
        return
    if not isinstance(data, dict):
        return

    post_id = (data.get("postID") or data.get("id") or
               data.get("PostID") or data.get("post_id"))
    video_url = _find_video_url(data)

    if post_id and video_url and post_id not in seen_ids:
        seen_ids.add(post_id)
        title = sanitize(str(
            data.get("postTitle") or data.get("title") or
            data.get("caption") or f"post_{post_id}"
        ))
        page_url = data.get("postURL", "")
        if page_url and not page_url.startswith("http"):
            page_url = "https://justfor.fans" + page_url
        posts.append({
            "postID":   str(post_id),
            "title":    title,
            "videoURL": video_url,
            "pageURL":  page_url or f"https://justfor.fans/?post={post_id}",
        })
        return

    for v in data.values():
        if isinstance(v, (dict, list)):
            _extract_posts(v, posts, seen_ids)


def _find_video_url(d: dict):
    # All known JFF field names for video URLs, HLS streams preferred
    for key in (
        "hlsURL", "hls_url", "hlsUrl", "streamURL", "stream_url", "streamUrl",
        "videoURL", "video_url", "videoUrl", "videoHLS", "video_hls",
        "mediaURL", "media_url", "encodedVideoURL", "encoded_video_url",
        "playbackURL", "playback_url", "manifestURL", "manifest_url",
    ):
        val = d.get(key)
        if val and isinstance(val, str) and val.startswith("http"):
            return val

    for key in ("video", "media", "content", "attachment", "stream"):
        nested = d.get(key)
        if isinstance(nested, dict):
            result = _find_video_url(nested)
            if result:
                return result

    return None

# yt-dlp downloader

def ytdlp_download(url: str, title: str, output_dir: Path) -> bool:
    """
    Download video via yt-dlp with Opera cookies.
    Format selector always picks separate video+audio streams so
    audio is never missing.
    """
    out_tmpl = str(output_dir / (sanitize(title) + ".%(ext)s"))

    cmd = [
        "yt-dlp",
        "--cookies-from-browser", "opera",
        "--format",
        # Drop [ext=m4a] -- JFF serves audio as AAC in HLS .ts segments, not .m4a.
        # bestvideo*+bestaudio* picks best V + best A regardless of container.
        "bestvideo[height<=1080][ext=mp4]+bestaudio"
        "/bestvideo[height<=1080]+bestaudio"
        "/bestvideo*[height<=1080]+bestaudio*"
        "/best[height<=1080]",
        "--merge-output-format", "mp4",
        # Regenerate timestamps + resync audio -- fixes A/V drift from
        # encrypted HLS segments with discontinuous DTS/PTS.
        "--postprocessor-args", "ffmpeg:-fflags +genpts -async 1 -vsync 1",
        "--output", out_tmpl,
        "--no-playlist",
        "--retries", "5",
        "--fragment-retries", "10",
        "--concurrent-fragments", "4",
        url,
    ]

    log(f"  Downloading: {title}")
    result = subprocess.run(cmd)
    if result.returncode != 0:
        log(f"  yt-dlp failed for: {url}")
    return result.returncode == 0

# profile download

def download_profile(profile_url: str, output_dir: Path, limit: int):
    log(f"\nFetching up to {limit} video(s) from: {profile_url}\n")
    posts = asyncio.run(intercept_profile(profile_url, limit))

    if not posts:
        log("\nNo videos found. Check that:")
        log("  * You are subscribed to (or friends with) this creator")
        log("  * You are logged into JFF in Opera")
        log("  * The username is spelled correctly")
        sys.exit(1)

    log(f"\nStarting downloads for {len(posts)} video(s)...\n")
    ok = fail = 0
    for i, post in enumerate(posts, 1):
        log(f"[{i}/{len(posts)}] {post['title']}")
        if ytdlp_download(post["videoURL"], post["title"], output_dir):
            ok += 1
        else:
            fail += 1

    log(f"\nDone -- {ok} downloaded, {fail} failed.")

# single post download

def download_post(url: str, output_dir: Path):
    log(f"\nDownloading single post: {url}\n")

    # Try yt-dlp directly first
    result = subprocess.run([
        "yt-dlp",
        "--cookies-from-browser", "opera",
        "--format",
        "bestvideo[height<=1080][ext=mp4]+bestaudio"
        "/bestvideo[height<=1080]+bestaudio"
        "/bestvideo*[height<=1080]+bestaudio*"
        "/best[height<=1080]",
        "--merge-output-format", "mp4",
        "--postprocessor-args", "ffmpeg:-fflags +genpts -async 1 -vsync 1",
        "--output", str(output_dir / "%(title)s.%(ext)s"),
        url,
    ])
    if result.returncode == 0:
        log("Done")
        return

    # Fallback: intercept the post page
    log("yt-dlp direct failed -- intercepting post page...")
    posts = asyncio.run(intercept_profile(url, limit=1))
    if posts:
        ytdlp_download(posts[0]["videoURL"], posts[0]["title"], output_dir)
    else:
        log("Could not find video URL. Make sure you are subscribed.")

# main

def main():
    parser = argparse.ArgumentParser(
        prog="yjff",
        description="Download videos from JustForFans using Opera session",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Usage: yjff https://justfor.fans/USERNAME [--all] [--limit N]",
    )
    parser.add_argument("url",   help="JFF profile URL or individual post URL")
    parser.add_argument("--all", dest="all", action="store_true",
                        help="Download ALL videos from profile")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                        help=f"Max videos to download (default: {DEFAULT_LIMIT})")
    args = parser.parse_args()

    SAVE_DIR.mkdir(parents=True, exist_ok=True)
    is_single_post = "?Post=" in args.url or "OnlyShowOnePost" in args.url

    if is_single_post:
        download_post(args.url, SAVE_DIR)
    else:
        limit = 999_999 if args.all else args.limit
        download_profile(args.url, SAVE_DIR, limit)


if __name__ == "__main__":
    main()
