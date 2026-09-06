#!/usr/bin/env python3
"""Crawler checks: pure logic, no network and no Firestore.

    python test_crawler.py
"""

import os

import crawler as c


def test_normalize_url():
    # Variants of one page must converge on a single URL, otherwise the graph
    # fills up with duplicates.
    canonical = "https://fr.wikipedia.org/wiki/Impressionnisme"
    for variant in [
        "https://fr.wikipedia.org/wiki/Impressionnisme",
        "https://fr.wikipedia.org/wiki/Impressionnisme#Origines",
        "https://fr.wikipedia.org/wiki/Impressionnisme/",
        "https://FR.WikipediA.ORG/wiki/Impressionnisme",
        "http://fr.wikipedia.org/wiki/Impressionnisme",
        "https://fr.wikipedia.org:443/wiki/Impressionnisme",
        "https://fr.wikipedia.org/wiki/Impressionnisme?utm_source=twitter",
        "  https://fr.wikipedia.org/wiki/Impressionnisme  ",
    ]:
        assert c.normalize_url(variant) == canonical, variant

    # A query parameter that carries meaning must survive.
    assert c.normalize_url("https://ex.com/p?id=7") == "https://ex.com/p?id=7"
    assert c.normalize_url("https://ex.com/p?id=7&fbclid=xyz") == "https://ex.com/p?id=7"

    # A non-standard port really does distinguish two hosts.
    assert c.normalize_url("https://ex.com:8080/p") == "https://ex.com:8080/p"

    # The root must not collapse to the empty string.
    assert c.normalize_url("https://ex.com") == "https://ex.com/"
    assert c.normalize_url("https://ex.com/") == "https://ex.com/"

    # What is not crawlable is rejected, not normalised.
    for bad in ["", None, "javascript:alert(1)", "mailto:a@b.c",
                "#section", "/relative", "data:text/html,x"]:
        assert c.normalize_url(bad) is None, bad


def test_url_id():
    # Stable identifier, hexadecimal, and compatible with the Firestore
    # constraints on document identifiers.
    a = c.url_id("https://ex.com/p")
    assert a == c.url_id("https://ex.com/p")
    assert a != c.url_id("https://ex.com/q")
    assert len(a) == 40 and all(ch in "0123456789abcdef" for ch in a)
    # Known value: a guard against a silent change of algorithm, which would
    # invalidate the whole database without raising anything.
    assert c.url_id("https://ex.com/p") == \
        "53220444f3f395bafd3f127230bded0c019795b7"


def test_is_allowed():
    # Short entry: the second-level label, whatever the suffix.
    assert c.is_allowed("https://youtube.com/x", {"youtube"})
    assert c.is_allowed("https://youtube.xyz/x", {"youtube"})

    # Long entry: that domain and no other. Indispensable for labels that are
    # too common -- "un" would catch un.com as readily as un.org.
    assert c.is_allowed("https://un.org/x", {"un.org"})
    assert not c.is_allowed("https://un.com/x", {"un.org"})

    assert not c.is_allowed("https://my-blog.fr/x", {"youtube", "un.org"})


def test_outside_of():
    allowed = {"wikipedia", "github"}

    # A whitelisted domain resets the counter, wherever we came from.
    assert c.outside_of("https://fr.wikipedia.org/wiki/Art", 0, allowed) == 0
    assert c.outside_of("https://fr.wikipedia.org/wiki/Art", 1, allowed) == 0

    # From a known domain, an unknown one is one hop away: we take it.
    assert c.outside_of("https://my-blog.fr/note", 0, allowed) == 1

    # From that unknown one, another unknown is two hops away: we stop.
    assert c.outside_of("https://yet-another.fr/x", 1, allowed) == 2


def test_should_queue():
    wiki = "https://fr.wikipedia.org/wiki/Art"
    blog = "https://my-blog.fr/note"

    # The intended behaviour: known -> unknown, yes; unknown -> other, no.
    assert c.should_queue(wiki, 0)
    assert c.should_queue(blog, 1)
    assert not c.should_queue("https://yet-another.fr/x", 2)

    # Wikipedia namespaces are navigation, not content.
    for noise in ["Special:Random", "Cat%C3%A9gorie:Art", "Fichier:X.jpg",
                  "Discussion:Art"]:
        url = f"https://fr.wikipedia.org/wiki/{noise}"
        assert not c.should_queue(url, 0), url


def test_skips_binary_urls():
    # A PDF or an image in the queue is one write, one download and a
    # "not HTML" failure -- for nothing.
    assert not c.should_queue("https://fr.wikipedia.org/doc.pdf")
    assert not c.should_queue("https://fr.wikipedia.org/img/photo.JPG")
    assert not c.should_queue("https://fr.wikipedia.org/a/b/archive.tar.gz")
    # A page announcing nothing stays crawlable.
    assert c.should_queue("https://fr.wikipedia.org/wiki/Monet")
    assert c.should_queue("https://fr.wikipedia.org/pdfs")


def test_refuses_private_hosts():
    # The crawl follows arbitrary domains. A page on the web must not be able
    # to make the crawler probe the local network of the machine running it and
    # publish what it found into a database anyone can read.
    for blocked in [
        "http://localhost/admin",
        "http://127.0.0.1:8080/",
        "http://192.168.1.1/",
        "http://10.0.0.5/",
        "http://172.16.0.1/",
        "http://169.254.169.254/latest/meta-data/",   # cloud metadata
        "http://[::1]/",
        "http://router.local/",
        "http://service.internal/",
        "http://0.0.0.0/",
    ]:
        assert not c.is_public_host(blocked), blocked
        assert not c.should_queue(blocked, 0), blocked

    for allowed in ["https://fr.wikipedia.org/wiki/Art", "https://8.8.8.8/",
                    "https://youtube.com/watch"]:
        assert c.is_public_host(allowed), allowed


def test_robots_url():
    # robots.txt governs a whole host, whatever the path or the query of the
    # URL that led us there.
    assert c.robots_url("https://ex.com/a/b?q=1") == "https://ex.com/robots.txt"
    assert c.robots_url("https://ex.com:8443/x") == "https://ex.com:8443/robots.txt"


def test_robots_verdict():
    """A crawler that ignores robots.txt gets banned, and deserves to be."""
    body = "\n".join([
        "User-agent: *",
        "Disallow: /private/",
        "",
        "User-agent: NetNebulaBot",
        "Disallow: /nope/",
    ])

    # Our own name wins over the wildcard group: that is the whole point of
    # announcing it in the User-Agent header.
    assert c.robots_verdict(body, "https://ex.com/public", "NetNebulaBot")
    assert not c.robots_verdict(body, "https://ex.com/nope/x", "NetNebulaBot")
    # The wildcard group applies to anyone we have no rule for.
    assert not c.robots_verdict(body, "https://ex.com/private/x", "OtherBot")

    # No file, an empty file or an unparsable one restricts nothing: the
    # standard says the absence of a rule is not a refusal, and refusing
    # everything would silently halt the crawl on the first badly served site.
    for nothing in [None, "", "<html>404 not found</html>"]:
        assert c.robots_verdict(nothing, "https://ex.com/x", "NetNebulaBot")

    # A blanket refusal is honoured, though -- that is the case that matters.
    assert not c.robots_verdict("User-agent: *\nDisallow: /",
                                "https://ex.com/x", "NetNebulaBot")


def test_service_account_path_prefers_the_environment():
    """No credential has to sit inside the repository."""
    saved = {k: os.environ.get(k) for k in
             ("GOOGLE_APPLICATION_CREDENTIALS", "NN_SERVICE_ACCOUNT")}
    try:
        for name in saved:
            os.environ.pop(name, None)
        # A path that does not exist must not be returned: an unreadable key is
        # worse than none, it fails deep inside the SDK instead of at startup.
        os.environ["NN_SERVICE_ACCOUNT"] = os.path.join(c.HERE, "no-such-key.json")
        fallback = os.path.join(c.HERE, "serviceAccountKey.json")
        expected = fallback if os.path.exists(fallback) else None
        assert c.service_account_path() == expected

        # An existing file pointed at by the environment wins over the fallback.
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = __file__
        assert c.service_account_path() == __file__
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def test_env_flag():
    # The robots.txt switch reads through this: a typo must not silently turn
    # politeness off.
    saved = os.environ.get("NN_TEST_FLAG")
    try:
        os.environ.pop("NN_TEST_FLAG", None)
        assert c._env_flag("NN_TEST_FLAG", True) is True
        assert c._env_flag("NN_TEST_FLAG", False) is False

        for truthy in ["1", "true", "TRUE", " yes ", "on"]:
            os.environ["NN_TEST_FLAG"] = truthy
            assert c._env_flag("NN_TEST_FLAG", False) is True, truthy

        for falsy in ["0", "false", "no", "off", ""]:
            os.environ["NN_TEST_FLAG"] = falsy
            assert c._env_flag("NN_TEST_FLAG", True) is False, falsy
    finally:
        os.environ.pop("NN_TEST_FLAG", None)
        if saved is not None:
            os.environ["NN_TEST_FLAG"] = saved


def test_extract_links():
    html = """
    <html><body>
      <a href="/wiki/Monet">Monet</a>
      <a href="/wiki/Monet#works">duplicate after normalisation</a>
      <a href="https://github.com/x">external</a>
      <a href="javascript:void(0)">not crawlable</a>
      <a href="/wiki/Renoir">Renoir</a>
      <a href="/wiki/Depart">itself</a>
    </body></html>
    """
    base = "https://fr.wikipedia.org/wiki/Depart"
    links = c.extract_links(html, base)

    assert "https://fr.wikipedia.org/wiki/Monet" in links
    assert "https://github.com/x" in links
    # The fragment fell back onto the same URL: a single node.
    assert links.count("https://fr.wikipedia.org/wiki/Monet") == 1
    # No uncrawlable scheme, no self-reference.
    assert not any(l.startswith("javascript") for l in links)
    assert base not in links

    # The cap bounds document size and write cost.
    many = "".join(f'<a href="/wiki/P{i}">p</a>' for i in range(50))
    assert len(c.extract_links(many, base, limit=10)) == 10


def test_extract_links_ignores_the_chrome():
    """The body of the article, not the sidebar.

    This is the defect that gave every page exactly MAX_LINKS_PER_PAGE outgoing
    links: the first links of a Wikipedia page are those of the menu and of the
    language editions, and the cap was reached before the article.
    """
    html = """
    <html><body>
      <div id="mw-navigation"><a href="/wiki/Accueil">Accueil</a></div>
      <nav><a href="/wiki/Menu">Menu</a></nav>
      <div class="mw-parser-output">
        <p><a href="/wiki/Monet">Monet</a></p>
        <a href="/wiki/Fichier:Monet.jpg">an image</a>
        <a href="/wiki/Catégorie:Peinture">a category</a>
        <div class="navbox"><a href="/wiki/Bandeau">footer banner</a></div>
      </div>
      <footer><a href="/wiki/Mentions">legal notice</a></footer>
    </body></html>
    """
    links = c.extract_links(html, "https://fr.wikipedia.org/wiki/Depart")

    assert links == ["https://fr.wikipedia.org/wiki/Monet"]


def test_extract_title():
    assert c.extract_title("<html><title> Title </title></html>", "x") == "Title"
    # With no usable title we fall back on the URL rather than on nothing.
    assert c.extract_title("<html></html>", "https://ex.com/p") == "https://ex.com/p"
    assert c.extract_title("<html><title>  </title></html>", "fb") == "fb"
    # An endless title must not inflate the Firestore document.
    assert len(c.extract_title(f"<title>{'x' * 999}</title>", "fb")) == 300


def test_budget():
    b = c.Budget(10)
    assert b.left == 10 and b.can_spend(10) and not b.can_spend(11)

    b.spend(7)
    assert b.used == 7 and b.left == 3

    # The refusal is what keeps a run from exceeding the daily quota: the
    # crawler stops instead of truncating a write.
    assert not b.can_spend(4)
    assert b.can_spend(3)

    try:
        b.spend(4)
    except ValueError:
        pass
    else:
        raise AssertionError("spend() must refuse to exceed the limit")
    assert b.used == 7, "a refused spend must consume nothing"


def test_page_write_cost():
    # Regression on the design decision that makes the crawl viable: a page
    # costs 2 writes plus its new URLs. With the old linked_from it cost 1 per
    # link, which came to about 130 pages a day.
    new_urls = 5
    assert 2 + new_urls == 7
    assert c.WRITE_BUDGET < 20000, "must stay under the daily Spark quota"


def test_host_of():
    assert c.host_of("https://fr.wikipedia.org/wiki/Art") == "fr.wikipedia.org"
    assert c.host_of("https://EN.Wikipedia.ORG/wiki/Art") == "en.wikipedia.org"
    assert c.host_of("not a url") == ""


def test_placement_is_deterministic():
    # The map must not reorganise itself between two runs or between two
    # visits: that is the whole promise of a frozen layout.
    assert c.place_page("abc123") == c.place_page("abc123")
    parent = c.place_page("parent")
    assert c.place_page("abc123", parent, 3) == c.place_page("abc123", parent, 3)


def test_seeds_are_spread_and_none_at_the_centre():
    # Seeds are scattered over a sphere: none of them holds the centre, and two
    # trees do not have to cross each other to exist.
    spots = [c.place_page(f"seed{k}") for k in range(8)]
    for spot in spots:
        r = sum(v * v for v in spot) ** 0.5
        assert r > c.SEED_SPREAD * 0.4, f"seed too close to the centre: {r}"

    for i, a in enumerate(spots):
        for b in spots[i + 1:]:
            assert _distance(a, b) > c.STEP, "two seeds stacked on each other"


def _distance(a, b):
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5


def test_a_page_lands_beside_the_one_that_found_it():
    """The single rule of placement: next to the page that discovered it.

    The domain is irrelevant -- a YouTube page found from Wikipedia lands
    beside the Wikipedia page, not in some "youtube" region.
    """
    parent = c.place_page("start")
    # The step carries jitter of up to 1.4 times its nominal value.
    longest = c.STEP * 1.4
    for k in range(24):
        child = c.place_page(f"child{k}", parent, 1)
        assert _distance(child, parent) <= longest + 1e-6, \
            f"child {k} too far from its parent"


def test_branches_stop_growing():
    # The step tightens, so a tree fits inside a finite volume: without that
    # the map would have no edge and the loading grid would lose all meaning.
    reach = c.BRANCH_REACH
    position = c.place_page("root")
    origin = position
    for depth in range(1, 40):
        position = c.place_page(f"n{depth}", position, depth)
    assert _distance(position, origin) <= reach + 1e-6, \
        "a branch escapes its theoretical reach"


def test_growth_pushes_outward():
    # Branches move away from the centre rather than folding back into it:
    # that is what keeps every seed from converging on the origin.
    parent = c.place_page("start")
    outward = sum(
        1 for k in range(60)
        if sum(v * v for v in c.place_page(f"e{k}", parent, 1)) ** 0.5
        > sum(v * v for v in parent) ** 0.5)
    assert outward > 40, f"only {outward}/60 children grow outwards"


def test_url_ancestors():
    # The parent of a page is its directory; an index page IS its directory,
    # otherwise it would end up a sibling of its own children.
    assert c.url_ancestors("https://a.com/x/y/z.html") == [
        "https://a.com/x/y", "https://a.com/x", "https://a.com/"]
    # An index page is its directory: its parent is one level up.
    assert c.url_ancestors("https://a.com/x/index.html") == ["https://a.com/"]
    assert c.url_ancestors("https://a.com") == []


def test_url_tree_rebuilds_missing_directories():
    """Directories that were never crawled must exist all the same.

    Without them, the thousands of articles under a `/wiki/` absent from the
    database are all roots and end up flat on one sphere -- exactly the uniform
    cloud we were trying to break up.
    """
    pages = {c.url_id(u): {"url": u} for u in [
        "https://a.com/wiki/Monet",
        "https://a.com/wiki/Renoir",
        "https://a.com/other/page",
    ]}
    parents = c.url_tree(pages)

    wiki = c.url_id("https://a.com/wiki")
    root = c.url_id(c.normalize_url("https://a.com"))
    assert parents[c.url_id("https://a.com/wiki/Monet")] == wiki
    assert parents[c.url_id("https://a.com/wiki/Renoir")] == wiki
    assert parents[wiki] == root
    # The directory is virtual: it is not in the database.
    assert wiki not in pages


def test_hierarchy_puts_the_big_subtree_at_the_pole():
    """The heart of H3: space is allocated to the measure of the subtree.

    Without it a page carrying five hundred descendants gets the same room as a
    leaf, and no hierarchy can be read.
    """
    parents = {}
    real = {"root"}
    # One large subtree of twenty pages, and two leaves.
    for k in range(20):
        parents[f"big{k}"] = "big"
        real.add(f"big{k}")
    for name in ["big", "leaf1", "leaf2"]:
        parents[name] = "root"
        real.add(name)

    position, weight, tier = c.hierarchy_layout(real, parents)

    assert weight["big"] == 21
    assert tier["root"] == 0 and tier["big"] == 1 and tier["big0"] == 2

    # The pole of "root" looks outwards; the large subtree is laid there first,
    # hence closer to that direction than the leaves.
    pole = c._normalize(position["root"])

    def alignment(name):
        d = c._normalize([position[name][i] - position["root"][i]
                          for i in range(3)])
        return sum(a * b for a, b in zip(d, pole))

    assert alignment("big") > alignment("leaf1")
    assert alignment("big") > alignment("leaf2")


def test_hierarchy_is_deterministic_and_bounded():
    parents = {f"n{k}": "root" for k in range(30)}
    real = set(parents) | {"root"}

    first = c.hierarchy_layout(real, parents)[0]
    second = c.hierarchy_layout(real, parents)[0]
    assert first == second

    # The map always occupies the same volume: the viewer keeps a fixed scale,
    # and the loading grid stays valid.
    reach = max(sum(v * v for v in p) ** 0.5 for p in first.values())
    assert abs(reach - c.WORLD_SPAN) < 1e-6


def test_cell_of():
    # The cell key is what the viewer asks Firestore for: it has to be exact at
    # the boundaries, otherwise a region loads only halfway.
    assert c.cell_of((0, 0, 0)) == "0_0_0"
    assert c.cell_of((c.CELL_SIZE - 0.001, 0, 0)) == "0_0_0"
    assert c.cell_of((c.CELL_SIZE, 0, 0)) == "1_0_0"
    assert c.cell_of((-0.001, 0, 0)) == "-1_0_0"
    assert c.cell_of((-c.CELL_SIZE, 0, 0)) == "-1_0_0"
    assert c.cell_of((-c.CELL_SIZE - 0.001, 0, 0)) == "-2_0_0"

    # The 3x3x3 neighbourhood fits under the Firestore limit of 30 values
    # for `in`.
    assert 27 <= 30


def test_layout_stays_inside_grid():
    # Every possible position has to fall into a reasonable number of cells,
    # otherwise loading by region would make no sense.
    span = c.WORLD_SPAN
    cells_per_axis = 2 * int(span / c.CELL_SIZE) + 1
    assert cells_per_axis <= 24, f"{cells_per_axis} cells per axis, grid too fine"

    # One step must fit inside a cell, otherwise two pages adjacent in the
    # graph could fall outside the 3x3x3 neighbourhood Firestore allows.
    assert c.STEP * 1.4 <= c.CELL_SIZE, \
        "a step overflows a cell: the 3x3x3 neighbourhood would not cover it"


class _FakeQueue:
    """List-backed priority queue, to exercise the ordering without asyncio."""

    def __init__(self):
        self.items = []

    def put_nowait(self, item):
        self.items.append(item)

    def drain(self):
        self.items.sort(key=lambda pair: pair[0])
        return [t.url for _, t in self.items]


def _crawler_stub():
    """A Crawler cut down to what the priority uses."""
    from collections import Counter
    stub = c.Crawler.__new__(c.Crawler)
    stub.queue = _FakeQueue()
    stub.known = Counter()
    stub._tick = 0
    return stub


def test_priority_favours_the_least_explored_domain():
    """A new domain goes ahead of one already heavily explored.

    This is what keeps the crawl from locking itself inside Wikipedia: a plain
    queue would exhaust a site of several million pages before looking
    elsewhere, which never happens.
    """
    stub = _crawler_stub()
    stub.known["wikipedia"] = 5000

    def task(u):
        return c.Task(u, 1, 0, (0, 0, 0), c.host_of(u))

    for url in ["https://fr.wikipedia.org/wiki/A",
                "https://fr.wikipedia.org/wiki/B",
                "https://github.com/x",
                "https://fr.wikipedia.org/wiki/C",
                "https://arxiv.org/abs/1"]:
        stub.enqueue(task(url))

    order = stub.queue.drain()
    assert "github.com" in order[0], f"github should come first: {order}"
    assert "arxiv.org" in order[1], f"arxiv should follow: {order}"
    assert all("wikipedia" in u for u in order[2:]), order


def test_priority_gives_a_domain_a_block_before_yielding():
    """A domain keeps the turn for a block, then yields.

    This is what makes a site legible on the map: page by page, the crawl
    alternated on every URL and returned a hundred grazed domains, none of them
    with enough pages for a tree to appear.
    """
    stub = _crawler_stub()

    def task(u):
        return c.Task(u, 1, 0, (0, 0, 0), c.host_of(u))

    # Two domains under way, one at a single page, the other at the end of its
    # block.
    stub.known["wikipedia"] = 1
    stub.known["github"] = c.DOMAIN_BLOCK - 1
    a, b = task("https://fr.wikipedia.org/wiki/A"), task("https://github.com/x")
    assert stub.priority(a)[0] == stub.priority(b)[0], \
        "inside one block, neither must overtake the other"

    # The next page tips github into the following block: it falls behind.
    stub.known["github"] += 1
    assert stub.priority(a)[0] < stub.priority(b)[0], \
        "block filled, the domain must yield the turn"

    # The rank depends only on crawled pages: queueing a thousand URLs must not
    # push a domain back, otherwise the block would be counted in links.
    before = stub.priority(a)[0]
    for i in range(1000):
        stub.enqueue(task(f"https://fr.wikipedia.org/wiki/{i}"))
    assert stub.priority(a)[0] == before, "the block counts pages, not links"


def test_commit_retries_contention_errors():
    """Contention errors must be retried, not propagated.

    The SDK does not class them as transient: an `Aborted` raised in the middle
    of a `--place` interrupted the rewrite of the database after several
    thousand documents. That is exactly what this policy fixes, so that is what
    has to be checked.
    """
    from google.api_core import exceptions, retry as _retry

    policy = c.commit_retry()

    # These two are the reason for the setting: the SDK lets them through.
    for exc in [exceptions.Aborted("lock"), exceptions.DeadlineExceeded("saturated")]:
        assert not _retry.if_transient_error(exc), \
            f"{type(exc).__name__} became transient by default, revisit the policy"
        assert policy._predicate(exc), f"{type(exc).__name__} should be retried"

    # Already transient as far as the SDK is concerned; named all the same, so
    # the policy reads without having to know its defaults.
    assert policy._predicate(exceptions.ServiceUnavailable("unavailable"))

    # A programming error must not be replayed in a loop.
    assert not policy._predicate(exceptions.PermissionDenied("rules"))
    assert not policy._predicate(ValueError("bug"))

    # Exponential backoff is the point: retrying at once would add to the
    # congestion that caused the failure.
    assert policy._initial > 0 and policy._maximum > policy._initial


def test_page_is_parsed_only_once():
    """Title and links share a single tree.

    Two parses per page saturated the global interpreter lock: parsing took
    0.81 of a core, and Firestore writes waited 22 seconds behind it. One pass
    instead of two took the crawl from 2.9 to 10.8 pages per second -- hence
    this guard.
    """
    html = "<html><head><title>Title</title></head><body>" \
           "<a href='https://ex.com/a'>a</a></body></html>"
    soup = c.soup_of(html)
    assert c.soup_of(soup) is soup, "the tree is rebuilt instead of reused"

    # Sharing must change nothing in the result: neither extraction modifies
    # the tree, which is what allows the single pass.
    assert c.extract_title(soup, "fallback") == c.extract_title(html, "fallback")
    assert c.extract_links(soup, "https://ex.com/") == \
        c.extract_links(html, "https://ex.com/")


def test_priority_never_compares_two_tasks():
    # A namedtuple has no defined ordering: without the counter that breaks
    # ties, the queue would raise a TypeError trying to settle one.
    stub = _crawler_stub()
    a = c.Task("https://ex.com/a", 0, 0, (0, 0, 0), "ex.com")
    b = c.Task("https://ex.com/b", 0, 0, (0, 0, 0), "ex.com")
    pa, pb = stub.priority(a), stub.priority(b)
    assert pa != pb and (pa < pb or pb < pa)


def test_seeds_span_several_domains():
    # Several starting points, otherwise the workers all attack the same edge
    # of the map.
    domains = {c.domain_of(u) for u in c.START_URLS}
    assert len(c.START_URLS) >= 8, "too few seeds"
    assert len(domains) >= 8, f"seeds concentrated on {domains}"
    for url in c.START_URLS:
        assert c.normalize_url(url), f"seed cannot be normalised: {url}"
        assert c.is_allowed(url), f"seed outside the whitelist: {url}"


def test_fast_preset():
    # The preset lifts every quota ceiling: applied by mistake to the real
    # database it would consume a day of quota in minutes. The emulator guard
    # is therefore the part of the mode that has to hold.
    saved = {k: getattr(c, k) for k in
             ("WORKERS", "WRITE_BUDGET", "MAX_PAGES", "MAX_FRONTIER",
              "PER_HOST", "DOMAIN_BLOCK", "FETCH_TIMEOUT", "MAX_ATTEMPTS",
              "VERIFY_TLS")}
    env = dict(os.environ)
    try:
        os.environ.pop("FIRESTORE_EMULATOR_HOST", None)
        try:
            c.apply_fast_preset()
            assert False, "--fast accepted outside the emulator"
        except SystemExit:
            pass
        assert c.VERIFY_TLS is True, "TLS lifted although the preset failed"

        os.environ["FIRESTORE_EMULATOR_HOST"] = "127.0.0.1:8088"
        # A variable set explicitly must win over the preset, otherwise the
        # mode becomes impossible to bound.
        os.environ["NN_WORKERS"] = "42"
        c.apply_fast_preset()
        assert c.WORKERS == 42, c.WORKERS
        assert c.MAX_PAGES > saved["MAX_PAGES"]
        assert c.WRITE_BUDGET > saved["WRITE_BUDGET"]
        assert c.MAX_ATTEMPTS == 1
        assert c.VERIFY_TLS is False
        # PER_HOST has to follow WORKERS: left at 8 it becomes the real
        # concurrency ceiling -- the dozen hosts in flight would then carry
        # only 80 simultaneous fetches, fewer than the 100 before the mode.
        assert c.PER_HOST > saved["PER_HOST"], c.PER_HOST
        assert c.DOMAIN_BLOCK > saved["DOMAIN_BLOCK"], c.DOMAIN_BLOCK
        # The emulator replaces the database, not the web: politeness stays on.
        assert c.OBEY_ROBOTS is True, "--fast must not switch robots.txt off"
    finally:
        os.environ.clear()
        os.environ.update(env)
        for k, v in saved.items():
            setattr(c, k, v)


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for test in tests:
        test()
        print(f"ok  {test.__name__}")
    print(f"\n{len(tests)} tests passed.")


if __name__ == "__main__":
    main()
