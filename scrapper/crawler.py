#!/usr/bin/env python3
"""NetNebula crawler.

Walks a whitelist of domains and writes the link graph to Firestore. A crawl
can be interrupted and resumed at any point: the work queue lives in the
`frontier` collection, not on local disk. There is no resume file to manage --
stopping the process and starting it again is enough.

Usage:
    python crawler.py                 # crawl, or resume an interrupted crawl
    python crawler.py --status        # report the database state, writes nothing
    python crawler.py --place         # recompute the layout of every page
    python crawler.py --purge         # erase everything (asks for confirmation)
    python crawler.py --fast          # bulk local seeding (emulator required)

Every quota guard is set through an environment variable; see `.env.example`
for the full list with its defaults.
"""

import argparse
import asyncio
from collections import Counter, namedtuple
from concurrent.futures import ThreadPoolExecutor
import hashlib
import math
import os
import signal
import sys
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser
# --- new imports ----------------------------------------------------------
from pathlib import Path
import json
import random
from loguru import logger

# Configure timestamped console logging.
logger.remove()
logger.add(sys.stderr, format="{time:YYYY-MM-DD HH:mm:ss} | {level} | {message}")

# --------------------------------------------------------------------------
# Batch Firestore writes, up to 500 operations.
class WriteBatcher:
    """Collect Firestore write operations and commit them in batches.
    The maximum number of operations per batch is 500, matching the Firebase limit.
    """

    def __init__(self, db, max_batch=500):
        self.db = db
        self.max_batch = max_batch
        self._ops = []  # list of (doc_ref, data)
        self._lock = asyncio.Lock()

    async def add_set(self, doc_ref, data, merge=False):
        async with self._lock:
            self._ops.append((doc_ref, data))
            if len(self._ops) >= self.max_batch:
                await self.commit()

    async def commit(self):
        async with self._lock:
            if not self._ops:
                return
            batch = self.db.batch()
            for ref, d in self._ops:
                batch.set(ref, d)
            # Firestore batch commit is synchronous; run it in a thread to avoid blocking the loop.
            await asyncio.to_thread(batch.commit)
            self._ops.clear()

    async def flush(self):
        """Force a commit of any remaining operations."""
        await self.commit()

    # Synchronous wrappers for use in threaded contexts
    def add_set_sync(self, doc_ref, data, merge=False):
        asyncio.run(self.add_set(doc_ref, data, merge))

    def commit_sync(self):
        asyncio.run(self.commit())

# Cache frontier state across runs.
FRONTIER_CACHE = Path(".frontier_cache.pkl")


HERE = os.path.dirname(os.path.realpath(__file__))

# ---------------------------------------------------------------- configuration

# Settings come from the environment, so a run can be tuned without touching
# the source. A `.env` file next to this script is loaded first when
# python-dotenv is installed -- a convenience, never a requirement, so a
# missing package must not break the crawler.
try:
    from dotenv import load_dotenv

    load_dotenv(os.path.join(HERE, ".env"))
except ImportError:
    pass


def _env_int(name, default):
    return int(os.environ.get(name, default))


def _env_flag(name, default):
    """Boolean read from the environment. Accepts 0/1, true/false, yes/no, on/off."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def quota_exhausted(error):
    """Recognize Firestore quota failures."""
    return error.__class__.__name__ == "ResourceExhausted"


# Seed domains, crawled without restriction. Links they carry to other domains
# are followed too, but for a single hop: from Wikipedia we take the personal
# blog it points at, and stop there -- whatever that blog points at next is not
# explored. The graph therefore spills one step beyond the known domains
# without wandering off into the whole web.
#
# Two forms are accepted. "youtube" matches the second-level label whatever the
# suffix -- so youtube.com, but also youtube.xyz. "un.org" matches that domain
# and nothing else. Prefer the long form as soon as the short label is
# ambiguous: "un", "data" or "science" are words too common to name a site.
# Note that "gov" alone matches nothing: usa.gov has "usa" as its label, and
# gov.uk is a public suffix.
ALLOWED_DOMAINS = {
    # Documentation / web
    "wikipedia",
    "mozilla",
    "w3",
    "ietf",
    "whatwg",

    # Development
    "github",
    "gitlab",
    "stackoverflow",
    "npmjs",       # npmjs.com, not "npm"
    "pypi",
    "python",
    "rust-lang",   # rust.org does not exist: doc.rust-lang.org has label "rust-lang"
    "go",
    "nodejs",
    "docker",
    "kubernetes",

    # Research / science
    "arxiv",
    "doi",
    "nature",
    "science",
    "pubmed",
    "semanticscholar",

    # Education
    "mit",
    "stanford",
    "harvard",
    "berkeley",
    "coursera",
    "edx",

    # News / information
    "reuters",
    "bbc",
    "theguardian",
    "nytimes",
    "lemonde",

    # Data / standards
    "data",
    "usa.gov",     # "gov" alone matches nothing: usa.gov has label "usa",
                   # and gov.uk is a public suffix
    "europa",
    "un.org",      # long form: "un" would also match un.com, un.xyz...

    # Video / content
    "youtube",
    "vimeo",

    # Open source / software
    "apache",
    "linux",
    "kernel",      # kernel.org, which "linux" does not match
    "gnu",
    "debian",
    "ubuntu",
}

# Hops allowed outside the whitelist. 1: we take the direct neighbour of a
# known domain, not the neighbour of that neighbour.
MAX_OUTSIDE = _env_int("NN_MAX_OUTSIDE", 1)

# Several entry points, spread across the families of the whitelist.
#
# Starting from a single point of Wikipedia led nowhere: a breadth-first walk
# never exhausts a site of several million pages, and the graph stayed
# single-domain. Measured on the first run: 2484 pages, 1 domain. With several
# starting points, the workers attack the map from several edges at once.
START_URLS = [
    "https://fr.wikipedia.org/wiki/Eugénie_Desjobert",
    "https://github.com/explore",
    "https://developer.mozilla.org/fr/docs/Web",
    "https://stackoverflow.com/questions",
    "https://arxiv.org/list/cs.CL/recent",
    "https://www.python.org/",
    "https://doc.rust-lang.org/book/",
    "https://nodejs.org/en/learn",
    "https://kubernetes.io/docs/home/",
    "https://www.gnu.org/software/",
    "https://www.debian.org/doc/",
    "https://www.w3.org/standards/",
    "https://www.bbc.com/news",
    "https://www.lemonde.fr/",
    "https://www.nature.com/",
    "https://www.un.org/fr/",
    "https://ocw.mit.edu/",
    "https://www.youtube.com/",
]

# Query parameters that name the same page and only add noise.
TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src",
}


# Daily quota and placement limit.
FIRESTORE_WRITE_QUOTA = _env_int("NN_FIRESTORE_WRITE_QUOTA", 20000)
PLACE_WRITE_LIMIT = _env_int(
    "NN_PLACE_WRITE_LIMIT", FIRESTORE_WRITE_QUOTA - 1)
WRITE_BUDGET = _env_int("NN_WRITE_BUDGET", 18000)
MAX_PAGES = _env_int("NN_MAX_PAGES", 500000)

# Maximum size of the frontier: every URL *discovered*, taken or not. This is a
# separate ceiling from MAX_PAGES, and it has to be -- a page carries dozens of
# links, so the frontier grows far faster than the number of crawled pages.
#
# Conflating the two deadlocked the crawl: as soon as the frontier reached
# MAX_PAGES no new URL could enter, the queue drained and the run stopped on
# "empty queue" while thousands of pages were still waiting.
#
# What has to be bounded here is not the graph but the cost of resuming: the
# frontier is read in full at startup, one Firestore read per entry. The Spark
# plan allows 50000 per day.
MAX_FRONTIER = _env_int("NN_MAX_FRONTIER", 30000)
FIRESTORE_READ_QUOTA = _env_int("NN_FIRESTORE_READ_QUOTA", 50000)
PLACE_READ_LIMIT = _env_int(
    "NN_PLACE_READ_LIMIT",
    max(0, FIRESTORE_READ_QUOTA - MAX_FRONTIER - 1000),
)
AUTO_PLACE = _env_flag("NN_AUTO_PLACE", False)
# A Wikipedia article carries three to four hundred content links. Keeping them
# all yields a clump where no edge can be read any more; we keep the first
# ones, which are those of the body text, and the graph becomes legible again.
MAX_LINKS_PER_PAGE = _env_int("NN_MAX_LINKS_PER_PAGE", 60)
WORKERS = _env_int("NN_WORKERS", 16)
# Simultaneous connections to a single host. This is politeness, but also a
# second concurrency ceiling: real throughput is
# min(WORKERS, PER_HOST x distinct hosts in flight). Setting it too low
# throttles the crawl well before WORKERS -- the progress line prints both.
PER_HOST = _env_int("NN_PER_HOST", 8)
# Pages taken from one domain before it yields, the way a scheduler hands out a
# quantum. At 1, we are back to strict round-robin: a hundred domains grazed,
# none legible. Too high, and a single large site monopolises the run.
#
# The grain is the domain, not the host: fr.wikipedia.org and en.wikipedia.org
# share the same block, just as they already share the same meta/stats entry
# and the same whitelist rule.
DOMAIN_BLOCK = _env_int("NN_DOMAIN_BLOCK", 50)
FETCH_TIMEOUT = _env_int("NN_FETCH_TIMEOUT", 15)
MAX_ATTEMPTS = _env_int("NN_MAX_ATTEMPTS", 3)

# robots.txt is honoured by default. The switch exists for crawling a host you
# own, not as a way around a refusal.
OBEY_ROBOTS = _env_flag("NN_OBEY_ROBOTS", True)

# TLS verification is only lifted in --fast mode, against the emulator.
VERIFY_TLS = True


def apply_fast_preset():
    """Lift the ceilings and push concurrency, to seed a throwaway database.

    These settings would drain a day of Spark quota in minutes: we refuse to
    apply them anywhere but against the emulator. `_env_int` still has the last
    word -- a variable set explicitly overrides the preset.

    robots.txt stays out of the preset on purpose: the emulator only replaces
    the database, the pages still come from the real web.
    """
    global WORKERS, WRITE_BUDGET, MAX_PAGES, MAX_FRONTIER
    global PER_HOST, DOMAIN_BLOCK, FETCH_TIMEOUT, MAX_ATTEMPTS, VERIFY_TLS

    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        sys.exit(
            "--fast requires the emulator: FIRESTORE_EMULATOR_HOST is not set.\n"
            "Against the real database this mode would burn a day of quota in "
            "minutes.\n"
            "\n"
            "  netnebula-local\n"
            "  export FIRESTORE_EMULATOR_HOST=127.0.0.1:8088"
        )

    # 128 and no more: now that a page is parsed only once, the crawl is bound
    # by the global interpreter lock, not by network wait. Adding workers no
    # longer adds throughput, but it does add simultaneous writes -- at 256 the
    # emulator returned "Transaction lock timeout" in bursts and the lost pages
    # had to be taken again. Measured over 45 s: 64 workers 7.0 pages/s,
    # 128 workers 7.8, 256 workers 10.8 but with continuous write failures.
    WORKERS = _env_int("NN_WORKERS", 128)
    WRITE_BUDGET = _env_int("NN_WRITE_BUDGET", 100_000_000)
    MAX_PAGES = _env_int("NN_MAX_PAGES", 1_000_000)
    MAX_FRONTIER = _env_int("NN_MAX_FRONTIER", 2_000_000)
    # 256 workers spread over the dozen hosts that carry the queue is 8 per
    # host: the politeness ceiling would become the only ceiling. The large
    # whitelist domains absorb 32 without trouble.
    PER_HOST = _env_int("NN_PER_HOST", 32)
    # A test database exists to show what a mapped site looks like: ten
    # complete domains beat a hundred stumps.
    DOMAIN_BLOCK = _env_int("NN_DOMAIN_BLOCK", 200)
    # A dead host cost up to 45 seconds of a worker (15 s x 3 attempts). On a
    # seeding run it is better to drop it at once: thousands of other URLs are
    # waiting.
    FETCH_TIMEOUT = _env_int("NN_FETCH_TIMEOUT", 5)
    MAX_ATTEMPTS = _env_int("NN_MAX_ATTEMPTS", 1)
    # A dozen whitelist domains serve incomplete certificate chains. To fill a
    # test database their HTML is worth more than their certificate -- and that
    # database is throwaway.
    VERIFY_TLS = False


try:
    import lxml  # noqa: F401  (presence alone: BeautifulSoup is what uses it)

    # About 20% faster than html.parser on a large page. Both build the same
    # tree from well-formed HTML; on broken HTML they can diverge, hence the
    # fallback rather than a hard dependency.
    PARSER = "lxml"
except ImportError:
    PARSER = "html.parser"

# Identifies the crawler to the sites it visits, and is the name robots.txt
# rules are matched against. Keep the contact URL: it is what lets an operator
# reach someone rather than ban an anonymous agent.
USER_AGENT = os.environ.get(
    "NN_USER_AGENT",
    "NetNebulaBot/1.0 (+https://github.com/SPTApyo/NetNebula)",
)

# ---------------------------------------------------------------- pure helpers
# Everything below is covered by test_crawler.py without touching the network
# or Firestore.


def url_id(url):
    """Firestore identifier of a URL.

    A hexadecimal sha1 rather than the escaped URL: a fixed length of 40
    characters (the Firestore limit is 1500 bytes), and above all a value that
    can be computed identically in Python and in JavaScript, which `quote_plus`
    cannot.
    """
    return hashlib.sha1(url.encode("utf-8")).hexdigest()


def normalize_url(url):
    """Collapse the variants of one page into a single canonical URL.

    Without this, `/wiki/X`, `/wiki/X#refs` and `/wiki/X?utm_source=...` become
    three distinct nodes. Returns None when the URL is not crawlable.
    """
    if not url:
        return None

    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https"):
        return None
    if not parts.hostname:
        return None

    host = parts.hostname.lower()
    # The default port is implicit: keeping it would create a duplicate.
    if parts.port and parts.port not in (80, 443):
        host = f"{host}:{parts.port}"

    query = urlencode([
        (k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if k.lower() not in TRACKING_PARAMS
    ])

    path = parts.path.rstrip("/") or "/"

    # The scheme is forced to https: on the whitelist domains http redirects
    # anyway, and merging them avoids one duplicate per page.
    return urlunsplit(("https", host, path, query, ""))


_tld_extract = None


def domain_of(url):
    """Main domain of a URL: fr.wikipedia.org -> "wikipedia"."""
    global _tld_extract
    if _tld_extract is None:
        import tldextract

        # suffix_list_urls=() forces the bundled snapshot: without it,
        # tldextract fetches the public suffix list over the network on the
        # first call, which makes the tests fail offline.
        _tld_extract = tldextract.TLDExtract(suffix_list_urls=())
    return _tld_extract(url).domain


def is_allowed(url, allowed=None):
    """True when the URL belongs to a whitelisted domain.

    Accepts the short entry ("youtube", the second-level label) as well as the
    full form ("un.org"), so that ambiguous labels can be tightened without
    changing the mechanism.
    """
    allowed = ALLOWED_DOMAINS if allowed is None else allowed
    if not _tld_extract:
        domain_of(url)  # primes the extractor
    ext = _tld_extract(url)
    return ext.domain in allowed or f"{ext.domain}.{ext.suffix}" in allowed


def outside_of(url, parent_outside, allowed=None):
    """Number of hops taken outside the whitelist.

    A whitelisted domain resets the counter; any other one increments it. This
    counter, and not the crawl depth, is what bounds exploration beyond the
    known domains.
    """
    return 0 if is_allowed(url, allowed) else parent_outside + 1


def is_public_host(url):
    """False for anything that is not a public Internet address.

    The crawl follows arbitrary domains. Without this filter, a page on the web
    could make the crawler probe the local network of the machine running it --
    router, development service, cloud instance metadata -- and publish what it
    found into a database anyone can read.
    """
    import ipaddress

    host = (urlsplit(url).hostname or "").lower()
    if not host or host == "localhost" or host.endswith((".local", ".internal")):
        return False

    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return True  # a domain name; resolution is out of reach here

    return address.is_global


def robots_url(url):
    """Address of the robots.txt that governs this URL."""
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, "/robots.txt", "", ""))


def robots_verdict(body, url, user_agent=None):
    """True when `body`, the text of a robots.txt, allows fetching `url`.

    Kept apart from any network access so that the rule itself stays testable.
    An unreadable file counts as no file at all: the standard says a robots.txt
    that cannot be parsed restricts nothing, and refusing everything would
    silently halt the crawl on the first badly served site.
    """
    parser = RobotFileParser()
    try:
        parser.parse((body or "").splitlines())
    except Exception:
        return True
    return parser.can_fetch(user_agent or USER_AGENT, url)


# Extensions that never return HTML. Queueing them costs a write, a download
# and a "not HTML" failure -- for nothing.
BINARY_SUFFIXES = (
    ".pdf", ".zip", ".gz", ".tar", ".bz2", ".xz", ".7z", ".rar",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".tiff",
    ".mp3", ".mp4", ".webm", ".ogg", ".ogv", ".wav", ".flac", ".avi", ".mov",
    ".css", ".js", ".json", ".xml", ".rss", ".atom", ".csv", ".txt",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods",
    ".exe", ".dmg", ".deb", ".rpm", ".apk", ".iso",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
)


def is_probably_html(url):
    """False when the extension of the URL announces something other than HTML."""
    return not urlsplit(url).path.lower().endswith(BINARY_SUFFIXES)


def should_queue(url, outside=0, allowed=None):
    """True when the URL is worth downloading, not merely recording.

    `outside` is the value already computed by `outside_of` for this URL.
    """
    if outside > MAX_OUTSIDE:
        return False
    if not is_public_host(url):
        return False
    if not is_probably_html(url):
        return False

    return not is_wiki_namespace(url)


# Containers that never carry content: navigation bars, footers, banners,
# category lists, and above all the interlanguage links of Wikipedia -- those
# were what filled the graph with two hundred language editions instead of
# articles.
CHROME_TAGS = {"nav", "header", "footer", "aside", "script", "style", "noscript"}
CHROME_CLASSES = {
    "navbox", "vertical-navbox", "navbox-styles", "catlinks", "mw-editsection",
    "mw-jump-link", "mw-portlet", "vector-menu", "sidebar", "sistersitebox",
    "hatnote", "metadata", "navigation-only", "printfooter", "mw-footer",
    "interlanguage-link", "mw-references-wrap", "reflist", "toc", "infobox",
}
CHROME_IDS = {
    "mw-navigation", "mw-panel", "p-lang", "footer", "siteSub", "toc",
    "catlinks", "mw-head", "vector-page-tools", "vector-toc",
}

# Content roots, in order of preference. Looking for the content rather than
# subtracting the chrome is safer: an unknown page is likelier to have a <main>
# or an <article> than to use our class names.
CONTENT_SELECTORS = [
    ".mw-parser-output",   # body of a Wikipedia article
    "#mw-content-text",
    "main",
    "article",
    "[role=main]",
]


def is_wiki_namespace(url):
    """True for File:, Category:, Special:... -- plumbing, not text."""
    path = urlsplit(url).path
    return "/wiki/" in path and ":" in path.split("/wiki/", 1)[1]


def content_root(soup):
    """The part of the page that carries the text, or the whole page."""
    for selector in CONTENT_SELECTORS:
        found = soup.select_one(selector)
        if found is not None:
            return found
    return soup


def _is_chrome(anchor):
    """True when this link lives inside navigation plumbing."""
    for parent in anchor.parents:
        name = getattr(parent, "name", None)
        if name is None:
            continue
        if name in CHROME_TAGS:
            return True
        attrs = getattr(parent, "attrs", None) or {}
        if attrs.get("id") in CHROME_IDS:
            return True
        classes = attrs.get("class") or []
        if CHROME_CLASSES.intersection(classes):
            return True
        if attrs.get("role") in {"navigation", "banner", "contentinfo"}:
            return True
    return False


def extract_links(html, base_url, limit=None):
    """Content links of a page: normalised, deduplicated and capped.

    Taking the first links of the document gave the sidebar, the banners and
    the interlanguage links -- never the article. Every page hit the cap before
    the first content link, hence a graph where each page carried exactly a
    hundred and fifty outgoing links to language editions, and almost no
    incoming ones.
    """
    limit = MAX_LINKS_PER_PAGE if limit is None else limit
    root = content_root(soup_of(html))

    links = []
    seen = set()
    self_url = normalize_url(base_url)

    for anchor in root.find_all("a", href=True):
        if _is_chrome(anchor):
            continue
        url = normalize_url(urljoin(base_url, anchor["href"]))
        if not url or url == self_url or url in seen:
            continue
        # File:, Category:, Talk:... are never content, and they will never be
        # crawled: recording them would only pad the document with edges that
        # resolve to no node.
        if is_wiki_namespace(url):
            continue
        seen.add(url)
        links.append(url)
        if len(links) >= limit:
            break

    return links


# ------------------------------------------------------------------ placement
#
# A page is laid down next to the one that found it. That is the whole rule.
#
# There is no shell per domain or per host any more: the map is the weave of
# links, not a ranking of sites. If a Wikipedia page points at a YouTube page,
# the two are neighbours and connected -- the domain no longer enters the
# geometry, only the colour.
#
# Everything derives from the identifiers, never from ranks: the map does not
# reorganise itself as the database grows, and visitors' caches stay valid.

# Radius over which the start URLs are scattered.
#
# Deliberately small next to the reach of a branch: the trees intermingle,
# which is the truth of the graph -- the seeds point at one another. Spreading
# them further gave eighteen separate balls of yarn, each too tight to make
# anything out.
SEED_SPREAD = 150

# Distance from a page to the one that found it, and how the step tightens per
# level.
#
# Without tightening the map would have no edge; tighten too much and a whole
# tree fits in one grain, making the weave of links invisible again. At 0.94
# over sixteen levels a branch reaches about five hundred units -- enough for a
# path from page to page to be followed by eye.
STEP = 34.0
STEP_DECAY = 0.94

# Past this level the step stops tightening: the sum of the steps is then
# finite and known, which the loading grid and the viewer scale both depend on.
STEP_LEVELS = 16

# Reach of a branch, jitter included, and the resulting world radius.
# `WORLD_SPAN` must match `WORLD_RADIUS` in public/app.js.
BRANCH_REACH = 1.4 * STEP * sum(STEP_DECAY ** d for d in range(STEP_LEVELS + 1))
WORLD_SPAN = SEED_SPREAD + BRANCH_REACH

# Aperture of the growth cone, in radians. Children spread away from the
# direction that runs from the centre of the map to their parent: a branch
# grows outwards instead of folding back on itself.
BRANCH = 1.5

# Side of one cell of the loading grid. The viewer asks for the 27 cells around
# the camera in a single query -- the Firestore limit on `in` is 30 values.
#
# NOTE: fixed size, so a cell gets denser as the database grows. At the scale
# where that would hurt (hundreds of thousands of pages), the grid will have to
# become one grid per level.
CELL_SIZE = 64


def _noise(seed):
    """mulberry32 -- the same draw on every run, for a given seed."""
    t = (seed + 0x6D2B79F5) & 0xFFFFFFFF
    t = (t ^ (t >> 15)) * (t | 1) & 0xFFFFFFFF
    t ^= (t + (t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF
    return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296


def _seed_of(key, salt=0):
    """Stable integer seed drawn from an arbitrary string."""
    return int(hashlib.sha1(key.encode("utf-8")).hexdigest()[:8], 16) ^ salt


def _normalize(vector):
    length = math.sqrt(sum(c * c for c in vector)) or 1.0
    return tuple(c / length for c in vector)


def _scatter(key, salt=0):
    """Uniform direction on the sphere, drawn from a string."""
    z = 2 * _noise(_seed_of(key, salt)) - 1
    theta = 2 * math.pi * _noise(_seed_of(key, salt ^ 0x5BF03635))
    ring = math.sqrt(max(0.0, 1 - z * z))
    return (math.cos(theta) * ring, z, math.sin(theta) * ring)


def _cone(direction, key, spread=BRANCH):
    """Direction drawn on the cone of angle `spread` around `direction`."""
    d = _normalize(direction)

    # Local orthonormal basis: any non-collinear vector starts the cross
    # product off.
    up = (0.0, 1.0, 0.0) if abs(d[1]) < 0.9 else (1.0, 0.0, 0.0)
    t = _normalize((
        up[1] * d[2] - up[2] * d[1],
        up[2] * d[0] - up[0] * d[2],
        up[0] * d[1] - up[1] * d[0],
    ))
    b = (
        d[1] * t[2] - d[2] * t[1],
        d[2] * t[0] - d[0] * t[2],
        d[0] * t[1] - d[1] * t[0],
    )

    phi = 2 * math.pi * _noise(_seed_of(key))
    angle = spread * (0.35 + 0.65 * _noise(_seed_of(key, 0x27D4EB2F)))
    s, c = math.sin(angle), math.cos(angle)
    cp, sp = math.cos(phi), math.sin(phi)

    return _normalize(tuple(
        d[i] * c + (t[i] * cp + b[i] * sp) * s for i in range(3)
    ))


def host_of(url):
    """Host of a URL: the middle level of the map."""
    return (urlsplit(url).hostname or "").lower()


def place_page(page_id, parent_position=None, depth=0):
    """Position of a page: right next to the one that found it.

    With no parent -- a start URL -- the page is scattered over the seed
    sphere. Otherwise it is laid one step away from its parent, in a cone
    pointing away from the centre of the map.

    The step tightens with depth. At a constant step every level would add the
    same distance and the map would have no edge; dividing it keeps the tree
    grown from one seed inside a finite volume, and long links stay legible
    from end to end.
    """
    if parent_position is None:
        jitter = 0.55 + 0.45 * _noise(_seed_of(page_id, 0x2545F491))
        return tuple(c * SEED_SPREAD * jitter for c in _scatter(page_id))

    # Growth direction: outwards, away from the centre. A cone around the
    # parent itself is enough, since its position already is its direction from
    # the origin.
    outward = parent_position if any(parent_position) else _scatter(page_id)
    direction = _cone(outward, page_id, BRANCH)

    step = STEP * (STEP_DECAY ** min(depth, STEP_LEVELS))
    step *= 0.6 + 0.8 * _noise(_seed_of(page_id, 0x2545F491))
    return tuple(parent_position[i] + direction[i] * step for i in range(3))


# ------------------------------------------------------- whole-graph layout ---
#
# The placement done while crawling (above) is provisional: the parent of a
# page there is whichever worker stumbled on it first, which has nothing to do
# with the structure of the site. The result is a uniform cloud.
#
# `--place` recomputes everything at once, following the method of H3 (Munzner,
# "Laying Out Large Directed Graphs in 3D Hyperbolic Space"), designed for
# mapping web links specifically:
#
#   1. the tree comes from the structure of the URLs, not from the order of
#      discovery -- the parent of a page is its directory, and an index page IS
#      its directory;
#   2. upward pass: the radius of a node follows from the area its children
#      take up;
#   3. downward pass: children are laid on the sphere of their parent, the
#      largest subtree at the pole, space allocated in proportion to the number
#      of descendants.
#
# Point 3 was the missing one: without it, a page carrying five hundred
# descendants gets the same room as a leaf, and no hierarchy can be read.

# Radius of a leaf, and the clearance left between the discs of one sphere. The
# absolute value does not matter: everything is renormalised onto WORLD_SPAN at
# the end.
LEAF_RADIUS = 1.0
PACK = 1.15

# Golden angle: two consecutive children land far apart in azimuth, without any
# alignment appearing.
GOLDEN_ANGLE = math.pi * (3 - math.sqrt(5))

# Files that are the index of their directory: the page is then the directory
# itself, and its siblings are its children.
INDEX_NAMES = {"index", "index.html", "index.htm", "index.php", "default.html",
               "default.htm", "home", "accueil", "main"}


def url_ancestors(url):
    """URLs of the parent directories, nearest first."""
    parts = urlsplit(url)
    segments = [seg for seg in parts.path.split("/") if seg]
    if segments and segments[-1].lower() in INDEX_NAMES:
        segments.pop()

    out = []
    while segments:
        segments.pop()
        path = "/" + "/".join(segments)
        out.append(urlunsplit(("https", parts.netloc, path, "", "")))
    return out


def url_tree(pages):
    """Tree of the URLs, missing directories included.

    Returns `{id: parent_id}`. The path of a page climbs up to the root of its
    site, and directories absent from the database appear all the same: without
    them, the thousands of articles under a `/wiki/` that was never crawled
    would all be roots and end up flat on one sphere. Those virtual nodes are
    neither stored nor displayed -- they exist only to give the tree its shape.

    The relation is acyclic by construction: a parent always has a strictly
    shorter path.
    """
    parents = {}
    for page in pages.values():
        chain = [url_id(page["url"])]
        for candidate in url_ancestors(page["url"]):
            normalized = normalize_url(candidate)
            if not normalized:
                continue
            ancestor = url_id(normalized)
            if ancestor != chain[-1]:
                chain.append(ancestor)

        for child, parent in zip(chain, chain[1:]):
            parents.setdefault(child, parent)
    return parents


def _frame(direction):
    """Orthonormal basis whose third axis is `direction`."""
    d = _normalize(direction)
    up = (0.0, 1.0, 0.0) if abs(d[1]) < 0.9 else (1.0, 0.0, 0.0)
    t = _normalize((
        up[1] * d[2] - up[2] * d[1],
        up[2] * d[0] - up[0] * d[2],
        up[0] * d[1] - up[1] * d[0],
    ))
    b = (
        d[1] * t[2] - d[2] * t[1],
        d[2] * t[0] - d[0] * t[2],
        d[0] * t[1] - d[1] * t[0],
    )
    return t, b, d


def hierarchy_layout(real_ids, parents):
    """H3 positions: area allocated to the subtree, largest subtree at the pole.

    `real_ids` are the pages held in the database; `parents` may additionally
    contain virtual nodes, the directories nobody crawled. Roots hang off a
    virtual node at the origin, which is neither stored nor displayed: it gives
    the sites a common sphere, each receiving a share matching its size.

    Returns `(positions, weights, tiers)` for every node, virtual ones
    included; the caller writes only what concerns real pages.

    The weight is the number of pages in the subtree -- that is what sizes a
    node on screen, a stable measure independent of what happens to be loaded.
    The tier is the depth in the URL tree: the viewer uses it to load the top of
    the hierarchy first, so the first screen holds together.
    """
    nodes = set(real_ids) | set(parents) | set(parents.values())
    children = {node: [] for node in nodes}
    roots = []
    for node in nodes:
        parent = parents.get(node)
        if parent is None:
            roots.append(node)
        else:
            children[parent].append(node)

    # Explicit post-order: recursion would overflow on a deep tree, and the web
    # produces those.
    ordered = []
    stack = [(node, False) for node in roots]
    while stack:
        node, done = stack.pop()
        if done:
            ordered.append(node)
            continue
        stack.append((node, True))
        for child in children[node]:
            stack.append((child, False))

    # Upward pass: weight and radius. A virtual node does not count for itself,
    # only for what it carries.
    weight = {}
    radius = {}
    for node in ordered:
        kids = children[node]
        own = 1 if node in real_ids else 0
        weight[node] = own + sum(weight[k] for k in kids)
        if kids:
            radius[node] = PACK * math.sqrt(sum(radius[k] ** 2 for k in kids))
        else:
            radius[node] = LEAF_RADIUS

    for node in children:
        children[node].sort(key=lambda k: (-weight[k], k))

    roots.sort(key=lambda r: (-weight[r], r))
    root_weight = sum(weight[r] for r in roots) or 1
    root_radius = PACK * math.sqrt(sum(radius[r] ** 2 for r in roots) or 1)

    position = {}

    def spread(kids, center, sphere, pole, total, full):
        """Lay `kids` on the sphere of radius `sphere` around `center`.

        A child's share of the sphere is proportional to its number of
        descendants, and the descending order puts the large subtrees at the
        pole, where the room is most generous. `full` opens the whole sphere
        rather than a hemisphere -- the case of the virtual origin node, which
        has no parent to lean away from.
        """
        t, b, d = _frame(pole)
        span = 2.0 if full else 1.0
        seen = 0
        for index, kid in enumerate(kids):
            share = (seen + max(weight[kid], 1) / 2) / total
            seen += max(weight[kid], 1)
            cos_phi = max(-1.0, min(1.0, 1 - span * share))
            sin_phi = math.sqrt(max(0.0, 1 - cos_phi * cos_phi))
            azimuth = GOLDEN_ANGLE * index
            ca, sa = math.cos(azimuth), math.sin(azimuth)
            direction = tuple(
                (t[i] * ca + b[i] * sa) * sin_phi + d[i] * cos_phi
                for i in range(3))
            position[kid] = tuple(center[i] + direction[i] * sphere
                                  for i in range(3))

    spread(roots, (0.0, 0.0, 0.0), root_radius, (0.0, 0.0, 1.0),
           root_weight, True)

    queue = list(roots)
    head = 0
    while head < len(queue):
        node = queue[head]
        head += 1
        kids = children[node]
        if not kids:
            continue
        center = position[node]
        # The pole looks away from the parent: a branch grows outwards instead
        # of doubling back over itself.
        parent = parents.get(node)
        pole = center if parent is None else tuple(
            center[i] - position[parent][i] for i in range(3))
        if not any(pole):
            pole = (0.0, 0.0, 1.0)
        total = sum(max(weight[k], 1) for k in kids)
        spread(kids, center, radius[node], pole, total, False)
        queue.extend(kids)

    # Renormalisation: the map always occupies the same volume whatever the
    # size of the database, so the viewer keeps a fixed scale.
    reach = max((sum(c * c for c in p) ** 0.5 for p in position.values()),
                default=1.0)
    scale = WORLD_SPAN / (reach or 1.0)
    placed = {k: tuple(c * scale for c in v) for k, v in position.items()}

    tier = {}
    for node in roots:
        tier[node] = 0
    walk = list(roots)
    head = 0
    while head < len(walk):
        node = walk[head]
        head += 1
        for kid in children[node]:
            tier[kid] = tier[node] + 1
            walk.append(kid)

    return placed, weight, tier


def cell_of(position):
    """Key of the cell holding this position, as stored and as queried."""
    return "_".join(str(math.floor(c / CELL_SIZE)) for c in position)


def soup_of(html):
    """Tree of a page. Returns what is already one unchanged.

    Title and links each built their own: two full parses per page. Measured on
    a 978 KB Wikipedia article, 254 ms instead of 126.

    This is not a comfort detail. Parsing is pure Python, so it holds the
    global interpreter lock: at 256 workers it took 0.81 of a core on its own
    and everything else queued behind it -- Firestore writes took 22 seconds
    while the emulator absorbs 500 batches per second. The crawl was bound
    neither by the network nor by the database, but by that double parse.
    """
    from bs4 import BeautifulSoup

    # A soup is recognised by its API: rebuilding it from itself would cost
    # exactly what we are trying to save.
    if hasattr(html, "find_all"):
        return html
    return BeautifulSoup(html, PARSER)


def extract_title(html, fallback):
    soup = soup_of(html)
    if soup.title and soup.title.string:
        title = soup.title.string.strip()
        if title:
            return title[:300]
    return fallback


class Budget:
    """Counts Firestore writes so a run stops before the quota does.

    The crawler reserves before writing: if the batch does not fit in what is
    left, the URL stays `pending` and the run ends cleanly.
    """

    def __init__(self, limit):
        self.limit = limit
        self.used = 0

    def can_spend(self, n):
        return self.used + n <= self.limit

    def spend(self, n):
        if not self.can_spend(n):
            raise ValueError(f"budget exceeded: {self.used} + {n} > {self.limit}")
        self.used += n

    @property
    def left(self):
        return self.limit - self.used


# A pending URL, carrying everything needed to process it without reading the
# database again: its depth, its hops outside the whitelist, and the position
# already fixed for it.
Task = namedtuple("Task", "url depth outside position host")


# ---------------------------------------------------------------- politeness


class RobotsGate:
    """robots.txt for every host visited, fetched once and kept in memory.

    A crawler that ignores robots.txt gets banned, and deserves to be. The file
    is fetched on the first URL of a host and reused for all the others: the
    cost is one extra request per host, not per page.

    A file that is missing, unreachable or unparsable allows everything, which
    is what the standard prescribes -- the absence of a rule is not a refusal.
    A host answering 5xx is treated the same way rather than blocking the crawl
    on a transient outage.
    """

    def __init__(self, session, user_agent=None, enabled=True):
        self.session = session
        self.user_agent = user_agent or USER_AGENT
        self.enabled = enabled
        # host -> body of its robots.txt, or None when there is nothing usable.
        self._bodies = {}
        # One lock per host: without it, the first hundred URLs of a site all
        # fetch the same robots.txt at once.
        self._locks = {}

    async def allows(self, url):
        if not self.enabled:
            return True
        body = await self._body_for(url)
        if body is None:
            return True
        return robots_verdict(body, url, self.user_agent)

    async def _body_for(self, url):
        host = urlsplit(url).netloc.lower()
        lock = self._locks.setdefault(host, asyncio.Lock())
        async with lock:
            if host not in self._bodies:
                self._bodies[host] = await self._fetch(robots_url(url))
            return self._bodies[host]

    async def _fetch(self, address):
        import aiohttp

        try:
            async with self.session.get(
                    address,
                    timeout=aiohttp.ClientTimeout(total=FETCH_TIMEOUT)) as response:
                if response.status != 200:
                    return None
                # Some hosts serve their robots.txt with an HTML content type,
                # or none at all; the body is what matters, so it is not
                # checked here.
                return await response.text()
        except Exception:
            return None


# ------------------------------------------------------------------ Firestore


def service_account_path():
    """Path to the service account key, or None when there is none.

    Read from the environment first, so no credential has to sit inside the
    repository. GOOGLE_APPLICATION_CREDENTIALS comes first because it is the
    variable the Google libraries already use; NN_SERVICE_ACCOUNT exists to
    point this crawler at another key without disturbing the rest of the
    toolchain. The file next to the script stays as a last resort, and
    .gitignore keeps it out of version control.
    """
    for name in ("GOOGLE_APPLICATION_CREDENTIALS", "NN_SERVICE_ACCOUNT"):
        candidate = os.environ.get(name)
        if candidate and os.path.exists(candidate):
            return candidate

    fallback = os.path.join(HERE, "serviceAccountKey.json")
    return fallback if os.path.exists(fallback) else None


def open_db():
    """Open Firestore, real or emulated.

    With FIRESTORE_EMULATOR_HOST set, the Admin SDK talks to the local
    emulator: no service account, no quota, a throwaway database that can be
    purged and recrawled at will. The rest of the code sees no difference.
    """
    from firebase_admin import credentials, firestore, initialize_app

    emulator = os.environ.get("FIRESTORE_EMULATOR_HOST")
    if emulator:
        project = os.environ.get("GOOGLE_CLOUD_PROJECT", "netnebula-local")
        print(f"Firestore emulated on {emulator} (project {project}).")
        # The emulator authenticates nobody, but the Admin SDK still insists on
        # being handed an identity: we give it an empty one.
        from google.auth.credentials import AnonymousCredentials

        class _Local(credentials.Base):
            def get_credential(self):
                return AnonymousCredentials()

        initialize_app(_Local(), {"projectId": project})
        return firestore.client()

    key_path = service_account_path()
    if not key_path:
        sys.exit(
            "No service account key found.\n"
            "Firebase console > Settings > Service accounts > "
            "Generate new private key, then point one of these at the file:\n"
            "  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json\n"
            "  NN_SERVICE_ACCOUNT=/path/to/key.json\n"
            "or drop it in scrapper/serviceAccountKey.json (git-ignored).\n"
            "\n"
            "Or, to work locally without touching the quota:\n"
            "  nix develop --command netnebula-local"
        )
    initialize_app(credentials.Certificate(key_path))
    return firestore.client()


def commit(batch):
    """Commit a batch of writes, retrying what is worth retrying.

    Firestore returns `Aborted` when two writes contend for the same documents,
    and `DeadlineExceeded` when the server buckles under load. Two hundred and
    fifty workers and a `--place` running together produced both in bursts, and
    the SDK classes neither as transient: it gave up on the first conflict, in
    the middle of rewriting the database.

    Both ask for the same thing -- wait and start again. Exponential backoff
    handles that, and the backoff is the point: retrying immediately would only
    add to the congestion that caused the failure.

    A batch is rewritten identically and `set` overwrites, so replaying one has
    no consequence.
    """
    batch.commit(retry=commit_retry())


def commit_retry():
    """Retry policy for commits. Kept separate so it can be checked."""
    from google.api_core import exceptions, retry

    return retry.Retry(
        predicate=retry.if_exception_type(exceptions.Aborted,
                                          exceptions.DeadlineExceeded,
                                          exceptions.ServiceUnavailable),
        initial=0.5, maximum=8.0, timeout=120.0)


class Crawler:
    def __init__(self, db, budget):
        from firebase_admin import firestore

        self._firestore = firestore
        self.db = db
        self.pages = db.collection("pages")
        self.frontier = db.collection("frontier")
        self.budget = budget

        # Batcher for Firestore writes
        self.batcher = WriteBatcher(db)

        # A plain boolean rather than an asyncio.Event: it is read from the
        # threads of `to_thread`, where an Event would not be safe.
        self._stopped = False
        # Priority queue: the least explored domain goes first.
        #
        # A plain queue takes URLs in discovery order, so it exhausts Wikipedia
        # before looking anywhere else -- which never happens. Ordering by the
        # number of pages already taken from a domain puts an unknown domain
        # (zero pages) ahead of one sitting at five thousand, and the graph
        # widens instead of digging.
        self.queue = asyncio.PriorityQueue()
        self.known = Counter()
        self._tick = 0
        # Identifiers of every URL already known (queued or processed). Rebuilt
        # from Firestore at startup: this is the resume state.
        #
        # NOTE: deduplication happens in memory, so one crawler process at a
        # time. Two machines running in parallel would redo the same work
        # without corrupting the database. Move to a lease (`lease_until`) on
        # the frontier documents if the crawl ever has to be distributed.
        self.seen = set()
        self.in_flight = 0
        # Number of fetches in flight per host. Diagnostic: real concurrency is
        # min(WORKERS, PER_HOST x distinct hosts), and without this counter
        # there is no telling which of the two ceilings is biting.
        self.hosts_in_flight = Counter()
        self.page_count = 0
        self.crawled = 0
        self.failed = 0
        # Failure reasons, for the end-of-run summary.
        self.failures = Counter()
        self.domains_touched = set()
        self.crawled_by_domain = Counter()
        self.stop_reason = "empty queue"
        # Set once the HTTP session exists, in `run`.
        self.robots = None

    # -- resume -------------------------------------------------------------

    def load_state(self):
        """Rebuild the resume state from Firestore or cache.

        Load frontier data from a local pickle cache if available to avoid a full
        Firestore read. On fallback, perform the original Firestore scan and then
        persist the state for future runs.
        """
        pending = []
        cache_loaded = False
        # Attempt to load cached state first
        if FRONTIER_CACHE.exists():
            try:
                with open(FRONTIER_CACHE, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                self.seen = set(data.get('seen', []))
                pending = [Task(**t) for t in data.get('pending', [])]
                logger.info(f"Loaded frontier cache: {len(self.seen)} known URLs, {len(pending)} pending.")
                cache_loaded = True
            except Exception:
                logger.warning("Failed to load frontier cache; falling back to Firestore read.")
        if not cache_loaded:
            fields = ["url", "depth", "status", "outside", "host", "x", "y", "z"]
            for doc in self.frontier.select(fields).stream():
                self.seen.add(doc.id)
                data = doc.to_dict() or {}
                if data.get("status") == "pending" and data.get("url"):
                    pending.append(Task(
                        data["url"],
                        data.get("depth", 0),
                        data.get("outside", 0),
                        (data.get("x", 0.0), data.get("y", 0.0), data.get("z", 0.0)),
                        data.get("host", host_of(data["url"])),
                    ))

        self.page_count = self._count(self.pages)

        # Pages already taken count towards priority: without this, on restart,
        # Wikipedia would start level with a brand new domain. The tally lives
        # in meta/stats, a document already written on every run -- a dedicated
        # collection would cost writes for nothing.
        stats = (self.db.document("meta/stats").get().to_dict() or {})
        for domain, count in (stats.get("domain_pages") or {}).items():
            self.known[domain] = count

        # Missing seeds are added on every run, not only against an empty
        # database: adding an entry to START_URLS must take effect without
        # purging everything.
        fresh = []
        for url in START_URLS:
            normalized = normalize_url(url)
            if not normalized or url_id(normalized) in self.seen:
                continue
            host = host_of(normalized)
            position = place_page(url_id(normalized))
            task = Task(normalized, 0, 0, position, host)
            fresh.append(task)
            pending.append(task)
            self.seen.add(url_id(normalized))

        if fresh:
            logger.info(f"Seeding: {len(fresh)} new start URLs.")
            self._seed(fresh)

        # Persist cache for next run
        try:
            with open(FRONTIER_CACHE, 'w', encoding='utf-8') as f:
                json.dump({"seen": list(self.seen), "pending": [t._asdict() for t in pending]}, f)
        except Exception:
            logger.warning("Failed to write frontier cache.")

        logger.info(f"Resuming: {self.page_count} pages stored, {len(pending)} URLs pending, {len(self.seen)} URLs known.")
        return pending

    def priority(self, task):
        """Rank of a URL in the queue. Lower goes first.

        The ordering works by *block* of pages, not page by page. One rank per
        page gave strict round-robin between domains: the crawl took one page
        here, one page there, and returned a hundred grazed domains instead of
        ten mapped ones. A site is only legible on the map once enough of its
        pages have been taken in a row for its tree to appear.

        The block does not shut the door on outside domains: a new domain sits
        at zero pages, hence block 0, hence ahead of everyone. What is lost is
        constant alternation; what is kept is the preference for the unexplored.

        The rank is frozen on insertion, and that is what produces the
        coherence we are after: links found while a domain fills its block
        inherit that block and are handled together. Those discovered later
        fall into a higher block and let the others through.

        The counter breaks ties within a block and, above all, guarantees that
        two tasks are never compared with each other: a namedtuple has no
        defined ordering, and the queue would raise while trying to settle it.
        """
        self._tick += 1
        # `known` counts pages *crawled* per domain, never URLs discovered: one
        # page queues up to MAX_LINKS_PER_PAGE of them, and a block counted in
        # links would mean nothing. It is incremented in `save`, to the unit
        # that `meta/stats` reads back at startup.
        return (self.known[domain_of(task.url)] // DOMAIN_BLOCK,
                task.depth, self._tick)

    def enqueue(self, task):
        self.queue.put_nowait((self.priority(task), task))

    def _seed(self, pending):
        batch = self.db.batch()
        for task in pending:
            batch.set(self.frontier.document(url_id(task.url)), {
                "url": task.url,
                "domain": domain_of(task.url),
                "depth": task.depth,
                "outside": task.outside,
                "host": task.host,
                "status": "pending",
                "attempts": 0,
                "x": task.position[0],
                "y": task.position[1],
                "z": task.position[2],
            })
        commit(batch)
        self.budget.spend(len(pending))

    def _count(self, collection):
        # An aggregation query costs far less than streaming the collection.
        return collection.count().get()[0][0].value

    # -- processing ---------------------------------------------------------

    async def fetch(self, session, url):
        """HTML of a page, or None. The reason for a failure is counted.

        Counting by reason is what distinguishes a web answering badly -- 404,
        403, PDF -- from a defect in the crawler. Without it, a 40% failure
        rate says nothing at all.
        """
        import aiohttp

        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=FETCH_TIMEOUT)) as response:
                if response.status != 200:
                    self.failures[f"http {response.status}"] += 1
                    return None
                if "text/html" not in response.headers.get("Content-Type", ""):
                    self.failures["not HTML"] += 1
                    return None
                return await response.text()
        except asyncio.TimeoutError:
            self.failures["timeout"] += 1
            return None
        except Exception as exc:
            self.failures[type(exc).__name__] += 1
            print(f"[fetch] {url}: {exc}", file=sys.stderr)
            return None

    async def process(self, session, task):
        url = task.url
        if self.robots is not None and not await self.robots.allows(url):
            self.failures["robots.txt"] += 1
            await asyncio.to_thread(self.record_blocked, url)
            return

        html = await self.fetch(session, url)
        if html is None:
            await asyncio.to_thread(self.record_failure, url)
            return

        # HTML parsing and Firestore writes are synchronous and blocking: they
        # go off the event loop, otherwise they freeze every other worker.
        title, links = await asyncio.to_thread(self.parse, html, url)
        queued = await asyncio.to_thread(self.save, task, title, links)

        # Queueing happens here, on the event loop: asyncio.Queue is not
        # thread-safe.
        for child in queued:
            self.enqueue(child)

    def parse(self, html, url):
        # One parse for both extractions: neither of them modifies the tree, so
        # they can share it.
        soup = soup_of(html)
        return extract_title(soup, url), extract_links(soup, url)

    def record_blocked(self, url):
        """Close a URL that robots.txt refuses. It is never retried.

        Marked `done` rather than left pending: the refusal will not change on
        the next run, and a pending URL would be fetched again every time.
        """
        if not self.budget.can_spend(1):
            self.request_stop("budget exhausted")
            return

        self.frontier.document(url_id(url)).set(
            {"status": "done", "robots": True}, merge=True)
        self.budget.spend(1)
        self.failed += 1

    def record_failure(self, url):
        """A failing URL is retried, then dropped after N attempts."""
        doc = self.frontier.document(url_id(url))
        snapshot = doc.get(["attempts"])
        attempts = (snapshot.to_dict() or {}).get("attempts", 0) + 1

        if not self.budget.can_spend(1):
            self.request_stop("budget exhausted")
            return

        if attempts >= MAX_ATTEMPTS:
            doc.set({"status": "done", "attempts": attempts, "error": True}, merge=True)
        else:
            doc.set({"attempts": attempts}, merge=True)
        self.budget.spend(1)
        self.failed += 1

    def save(self, task, title, links):
        url, depth, position = task.url, task.depth, task.position
        page_id = url_id(url)
        domain = domain_of(url)

        # Room left in the frontier -- not in the graph: what is bounded here
        # is the number of known URLs, hence the startup reads of the next run.
        room = MAX_FRONTIER - len(self.seen)
        new_urls = []
        if room > 0:
            for link in links:
                if len(new_urls) >= room:
                    break
                if url_id(link) in self.seen:
                    continue
                outside = outside_of(link, task.outside)
                if should_queue(link, outside):
                    new_urls.append((link, outside))

        ops = 2 + len(new_urls)  # page + frontier status + new URLs
        if not self.budget.can_spend(ops):
            # The URL stays "pending": the next run will pick it up.
            self.request_stop("budget exhausted")
            return []

        # Reserved before the commit, so two concurrent workers do not queue
        # the same URL twice. If the commit fails, these URLs are lost for this
        # run but rediscovered on the next, `seen` being rebuilt from Firestore.
        for link, _ in new_urls:
            self.seen.add(url_id(link))

        batch = self.db.batch()
        batch.set(self.pages.document(page_id), {
            "url": url,
            "domain": domain,
            "host": task.host,
            "title": title,
            "linked_to": [url_id(link) for link in links],
            # The position is fixed at discovery and does not move. `cell` and
            # `depth` are the two keys the viewer slices its loading on: the
            # region around the camera, and the skeleton of the shallowest
            # pages.
            "x": position[0], "y": position[1], "z": position[2],
            "cell": cell_of(position),
            "depth": depth,
            "fetched_at": self._firestore.SERVER_TIMESTAMP,
        })
        batch.set(self.frontier.document(page_id), {"status": "done"}, merge=True)

        placed = []
        for link, outside in new_urls:
            child_host = host_of(link)
            child = place_page(url_id(link), position, depth + 1)
            placed.append(Task(link, depth + 1, outside, child, child_host))
            batch.set(self.frontier.document(url_id(link)), {
                "url": link,
                "domain": domain_of(link),
                "host": child_host,
                "depth": depth + 1,
                "outside": outside,
                "status": "pending",
                "attempts": 0,
                "x": child[0], "y": child[1], "z": child[2],
            })

        commit(batch)
        self.budget.spend(ops)

        self.page_count += 1
        self.crawled += 1
        self.domains_touched.add(domain)
        self.crawled_by_domain[domain] += 1
        # `crawled_by_domain` is this run's delta, folded into meta/stats at the
        # end; `known` is the total across all runs, the one the queue orders on.
        self.known[domain] += 1

        if self.crawled % 25 == 0:
            logger.info(f"{self.crawled} pages | queue {self.queue.qsize()} | {self.in_flight} in flight over {len(self.hosts_in_flight)} hosts | budget left {self.budget.left}")

        if self.page_count >= MAX_PAGES:
            self.request_stop(f"ceiling of {MAX_PAGES} pages reached")

        return placed

    def request_stop(self, reason):
        """Ask the run to stop. Workers stop claiming work.

        Downloads already in flight when the stop lands are lost: their URL
        stays "pending" and will be fetched again on the next run. The waste is
        bounded by WORKERS per interruption, and costs only bandwidth -- no
        Firestore write is consumed for nothing.
        """
        if not self._stopped:
            self.stop_reason = reason
            self._stopped = True

    # -- loop ---------------------------------------------------------------

    async def worker(self, session):
        while not self._stopped:
            # We only stop when nothing is queued *and* nothing is in flight: a
            # busy worker can still feed the queue.
            if self.queue.empty() and self.in_flight == 0:
                return
            try:
                _, task = await asyncio.wait_for(self.queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue

            self.in_flight += 1
            self.hosts_in_flight[task.host] += 1
            try:
                await self.process(session, task)
            except Exception as exc:
                print(f"[worker] {task.url}: {exc}", file=sys.stderr)
            finally:
                self.in_flight -= 1
                if self.hosts_in_flight[task.host] > 1:
                    self.hosts_in_flight[task.host] -= 1
                else:
                    del self.hosts_in_flight[task.host]
                self.queue.task_done()

    async def run(self):
        import aiohttp

        pending = await asyncio.to_thread(self.load_state)
        if not pending:
            logger.info("Nothing to do: the frontier holds no pending URL.")
            return
        for task in pending:
            self.enqueue(task)

        loop = asyncio.get_running_loop()
        try:
            loop.add_signal_handler(
                signal.SIGINT, lambda: self.request_stop("interrupted (SIGINT)"))
        except NotImplementedError:
            pass  # Windows: Ctrl-C surfaces as a KeyboardInterrupt instead.

        # The `to_thread` calls -- parsing, Firestore commits -- and the DNS
        # resolution done by aiohttp share the default executor, capped at
        # min(32, cpu+4) threads. Past thirty or so workers that executor is
        # the bottleneck, not the network. `asyncio.run` closes it on the way
        # out. Windows copes badly past a few hundred threads, hence the cap.
        loop.set_default_executor(ThreadPoolExecutor(
            max_workers=min(WORKERS + 8, 200), thread_name_prefix="crawler"))

        logger.info(f"Starting: {WORKERS} workers ({PER_HOST} max per host), budget {self.budget.left} writes, robots.txt {'honoured' if OBEY_ROBOTS else 'ignored'}.")
        # Without an explicit connector, aiohttp caps at 100 simultaneous
        # connections: past that, raising NN_WORKERS sped nothing up.
        connector = aiohttp.TCPConnector(
            limit=WORKERS, limit_per_host=PER_HOST, ttl_dns_cache=300,
            ssl=VERIFY_TLS)
        async with aiohttp.ClientSession(connector=connector,
                                         headers={"User-Agent": USER_AGENT}) as session:
            self.robots = RobotsGate(session, USER_AGENT, OBEY_ROBOTS)
            await asyncio.gather(*[
                asyncio.create_task(self.worker(session)) for _ in range(WORKERS)
            ])

        await asyncio.to_thread(self.write_stats)
        logger.info(f"\nStopped: {self.stop_reason}.")
        logger.info(f"{self.crawled} pages crawled, {self.failed} failures, {self.budget.used} writes consumed.")
        if self.failures:
            detail = ", ".join(f"{reason} x{count}" for reason, count in self.failures.most_common(6))
            logger.info(f"  failures: {detail}")
        if not self.queue.empty():
            logger.info(f"{self.queue.qsize()} URLs still pending -- running the script again picks them up.")

    def write_stats(self):
        stats_doc = self.db.document("meta/stats")
        existing = (stats_doc.get().to_dict() or {})
        domains = sorted(set(existing.get("domains", [])) | self.domains_touched)

        if not self.budget.can_spend(1):
            print("[stats] budget exhausted, meta/stats not updated.", file=sys.stderr)
            return

        # Per-domain tally: it primes the priority queue on the next run.
        counts = dict(existing.get("domain_pages") or {})
        for domain, n in self.crawled_by_domain.items():
            counts[domain] = counts.get(domain, 0) + n

        stats_doc.set({
            "domains": domains,
            "domain_pages": counts,
            "page_count": self.page_count,
            "frontier_pending": self._count(
                self.frontier.where(filter=self._pending_filter())),
            "layout_pending": existing.get("layout_pending", False) or bool(self.crawled),
            "updated_at": self._firestore.SERVER_TIMESTAMP,
        })
        self.budget.spend(1)

    def _pending_filter(self):
        from google.cloud.firestore_v1.base_query import FieldFilter

        return FieldFilter("status", "==", "pending")


# --------------------------------------------------------------- subcommands


def show_status(db):
    pages = db.collection("pages").count().get()[0][0].value
    frontier = db.collection("frontier")
    total = frontier.count().get()[0][0].value

    from google.cloud.firestore_v1.base_query import FieldFilter
    pending = frontier.where(
        filter=FieldFilter("status", "==", "pending")).count().get()[0][0].value

    stats = (db.document("meta/stats").get().to_dict() or {})

    logger.info(f"pages crawled    : {pages}")
    logger.info(f"frontier total   : {total}")
    logger.info(f"  pending        : {pending}")
    print(f"  processed      : {total - pending}")
    print(f"domains          : {', '.join(stats.get('domains', [])) or '-'}")
    print(f"last run         : {stats.get('updated_at', '-')}")
    print(f"ceilings         : {MAX_PAGES} pages, {MAX_FRONTIER} known URLs, "
          f"{WRITE_BUDGET} writes/run")


def backfill(db):
    """Recompute position, parent, host and cell for every page.

    This is where the map takes its shape: the URL tree first, then the H3
    layout. The placement done while crawling is only a stand-in.

    Deterministic: running it twice yields exactly the same map. Run it after
    any change to the placement scheme, and now and then once the database has
    grown a lot.

    Costs one write per page.
    """
    logger.info("Reading pages...")
    pages = {}
    for doc in (db.collection("pages")
                .select(["url", "linked_to", "depth"])
                .limit(PLACE_READ_LIMIT + 1).stream()):
        data = doc.to_dict() or {}
        url = data.get("url", "")
        if not url:
            continue
        pages[doc.id] = {
            "url": url,
            "host": host_of(url),
            "domain": domain_of(url),
            "linked_to": data.get("linked_to", []),
            "depth": data.get("depth", 9),
        }
        if len(pages) > PLACE_READ_LIMIT:
            raise SystemExit(
                f"Placement needs at most {PLACE_READ_LIMIT} page reads; "
                f"found more. Run --place separately after the crawl."
            )
    if not pages:
        logger.info("No page to place.")
        return 0
    if len(pages) + 1 > PLACE_WRITE_LIMIT:
        raise SystemExit(
            f"Placement needs {len(pages) + 1} writes, but only "
            f"{PLACE_WRITE_LIMIT} are allowed. Increase the limit "
            "or run --place on a separate quota window."
        )
    print(f"{len(pages)} pages.")

    parents = url_tree(pages)
    virtual = (set(parents) | set(parents.values())) - set(pages)
    print(f"URL tree: {len(pages) - sum(1 for i in pages if i in parents)}"
          f" roots, {len(virtual)} directories rebuilt.")

    position, weight, tier = hierarchy_layout(set(pages), parents)

    batch = db.batch()
    written = 0

    def flush(n):
        nonlocal batch
        if n % 400 == 0:
            commit(batch)
            batch = db.batch()

    for page_id, page in pages.items():
        p = position[page_id]
        batch.set(db.collection("pages").document(page_id), {
            "host": page["host"],
            "x": p[0], "y": p[1], "z": p[2],
            "cell": cell_of(p),
            "depth": page["depth"],
            # The parent in the URL tree: this is the edge that carries the
            # structure, and the viewer draws it first. It may be a virtual
            # directory, absent from the database -- the viewer ignores those.
            "parent": parents.get(page_id),
            # Pages in the subtree, and depth in the tree. The size of a node
            # comes from the first, the loading order from the second: the top
            # of the hierarchy arrives first.
            "weight": weight.get(page_id, 1),
            "tier": tier.get(page_id, 0),
        }, merge=True)
        written += 1
        flush(written)

    commit(batch)

    # The viewer keeps the skeleton in cache under a fingerprint drawn from
    # `updated_at` and `page_count`. Replacing the layout changes neither:
    # without this line the browser served the old layout forever -- and, on
    # the very first placement, an empty cache, the pages not yet carrying the
    # `tier` field it sorts on.
    from firebase_admin import firestore

    db.document("meta/stats").set(
        {"layout_pending": False,
         "updated_at": firestore.SERVER_TIMESTAMP}, merge=True)

    print(f"{written} documents written.")
    return written


def purge(db):
    """Erase everything. Deliberately off the normal path: purging before every
    run was the exact opposite of a resumable crawl."""
    answer = input(
        "Erase ALL pages and the frontier? "
        "The crawl will start over from nothing. Type 'yes': "
    )
    if answer.strip().lower() != "yes":
        print("Cancelled.")
        return

    for name in ("pages", "frontier"):
        collection = db.collection(name)
        deleted = 0
        while True:
            docs = list(collection.limit(400).stream())
            if not docs:
                break
            batch = db.batch()
            for doc in docs:
                batch.delete(doc.reference)
            commit(batch)
            deleted += len(docs)
        print(f"{name}: {deleted} documents deleted.")

    db.document("meta/stats").delete()
    print("Purge complete.")


def run_automatic(db):
    """Place pending pages, then spend the remaining quota crawling."""
    stats = (db.document("meta/stats").get().to_dict() or {})
    placement_writes = 0
    if stats.get("layout_pending", True):
        logger.info("Pending layout takes priority over crawling.")
        placed = backfill(db)
        placement_writes = placed + 1 if placed else 0

    db.document("meta/stats").set({"layout_pending": True}, merge=True)
    placement_writes += 1
    remaining = max(0, FIRESTORE_WRITE_QUOTA - placement_writes)
    budget_limit = min(WRITE_BUDGET, remaining)
    if not budget_limit:
        logger.info("No write quota remains for crawling today.")
        return

    asyncio.run(Crawler(db, Budget(budget_limit)).run())


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--status", action="store_true",
                        help="report the database state without writing anything")
    parser.add_argument("--purge", action="store_true",
                        help="erase pages and frontier (asks for confirmation)")
    parser.add_argument("--place", action="store_true",
                        help="recompute the layout of every page "
                             "(one write per page)")
    parser.add_argument("--fast", action="store_true",
                        help="local seeding: ceilings lifted, "
                             "hundreds of workers (emulator required)")
    args = parser.parse_args()

    if args.fast:
        apply_fast_preset()

    db = open_db()

    try:
        if args.status:
            show_status(db)
        elif args.place:
            backfill(db)
        elif args.purge:
            purge(db)
        elif AUTO_PLACE:
            run_automatic(db)
        else:
            asyncio.run(Crawler(db, Budget(WRITE_BUDGET)).run())
    except Exception as error:
        if quota_exhausted(error):
            logger.warning("Firestore quota exhausted; retrying next run.")
            return
        raise


if __name__ == "__main__":
    main()
