"""Build public/graph.json from the Common Crawl domain-level web graph.

    python pipeline/build_graph.py                  # latest release, 20 000 domains
    python pipeline/build_graph.py --size 2000      # quick local run
    python pipeline/build_graph.py --release cc-main-2026-may-jun-jul

The ranks file is sorted by harmonic centrality, so the top domains come from
its first lines. The vertices file maps them to ids, and one pass over the
edges file keeps the links between them. Nothing is stored between runs.
"""

import argparse
import datetime
import heapq
import json
import random
import subprocess
import sys
import urllib.request
from pathlib import Path

GRAPH_INFO = "https://index.commoncrawl.org/graphinfo.json"
BASE = "https://data.commoncrawl.org/projects/hyperlinkgraph"
OUT = Path(__file__).resolve().parent.parent / "public" / "graph.json"

# ponytail: hand-picked list, extend when new infrastructure shows up
EXCLUDED = {
    "googleapis.com", "gstatic.com", "googletagmanager.com", "gmpg.org",
    "googleusercontent.com", "google-analytics.com", "doubleclick.net",
    "googlesyndication.com", "googleadservices.com", "youtube-nocookie.com",
    "cloudfront.net", "amazonaws.com", "akamaihd.net", "akamaized.net",
    "jsdelivr.net", "unpkg.com", "cdnjs.com", "bootstrapcdn.com", "jquery.com",
    "fontawesome.com", "cloudflareinsights.com", "fbcdn.net", "twimg.com",
    "ytimg.com", "wixstatic.com", "wsimg.com", "gravatar.com", "wp.com",
    "example.com", "schema.org", "w3schools.com", "goo.gl", "bit.ly",
    "tinyurl.com", "t.co", "ow.ly", "addthis.com", "sharethis.com",
    "cutt.ly", "list-manage.com", "b-cdn.net", "digitaloceanspaces.com",
    "alicdn.com", "aliyuncs.com", "media-amazon.com", "ssl-images-amazon.com",
    "statcounter.com", "googlevideo.com", "akamai.net", "azureedge.net",
}


def domain_name(rev):
    """com.example -> example.com"""
    return ".".join(reversed(rev.split(".")))


def top_domains(rank_lines, size):
    """The `size` best ranked domains as (name, hosts), excluded ones skipped."""
    top = []
    for line in rank_lines:
        if line.startswith(b"#"):
            continue
        cols = line.split(b"\t")
        name = domain_name(cols[4].decode())
        if name in EXCLUDED:
            continue
        top.append((name, int(cols[5])))
        if len(top) == size:
            break
    return top


def vertex_ids(vertex_lines, names):
    """Map vertex id (bytes) to the index of its domain in `names`."""
    wanted = {".".join(reversed(n.split("."))).encode(): i
              for i, n in enumerate(names)}
    ids = {}
    for line in vertex_lines:
        vid, rev, _ = line.split(b"\t", 2)
        index = wanted.get(rev)
        if index is not None:
            ids[vid] = index
            if len(ids) == len(wanted):
                break
    return ids


def linked_pairs(edge_lines, ids):
    """(source, target) index pairs whose two ends are in `ids`."""
    get = ids.get
    for line in edge_lines:
        src, _, dst = line.partition(b"\t")
        a = get(src)
        if a is None:
            continue
        b = get(dst.rstrip())
        if b is not None and a != b:
            yield a, b


def prune(pairs, size, keep, rescue=2):
    """Keep each node's `keep` most telling targets; count full degrees.

    Reciprocal links come first, then the least cited targets: linking to
    a giant says little, linking to a niche site says a lot. A node left
    without any link gets its `rescue` most specific sources back.
    Returns a flat edge list sorted by source, in-degrees and out-degrees.
    """
    targets = [set() for _ in range(size)]
    sources = [[] for _ in range(size)]
    for a, b in pairs:
        if b not in targets[a]:
            targets[a].add(b)
            sources[b].append(a)
    inn = [len(s) for s in sources]
    out = [len(t) for t in targets]

    kept = set()
    for a, t in enumerate(targets):
        ranked = sorted(t, key=lambda b: (a not in targets[b], inn[b], b))
        kept.update((a, b) for b in ranked[:keep])

    linked = {node for pair in kept for node in pair}
    for b in range(size):
        if b not in linked:
            ranked = sorted(sources[b], key=lambda a: (a not in targets[b], out[a], a))
            kept.update((a, b) for a in ranked[:rescue])

    edges = []
    for a, b in sorted(kept):
        edges += (a, b)
    return edges, inn, out


def _unit(coords, clip=1.4):
    """Center points, scale the 90th percentile to 1, pull outliers in.

    DrL throws a few points very far; scaling by the farthest one
    would crush everything else into a dot.
    """
    n = len(coords)
    center = [sorted(c[i] for c in coords)[n // 2] for i in range(3)]
    moved = [[c[i] - center[i] for i in range(3)] for c in coords]
    lengths = [sum(v * v for v in c) ** 0.5 for c in moved]
    reach = sorted(lengths)[int(0.9 * (n - 1))] or max(lengths) or 1.0
    return [[v / reach * min(1.0, clip * reach / length) if length else 0.0
             for v in c] for c, length in zip(moved, lengths)]


def layout(size, edges, seed=7):
    """Galaxy layout: one 3-D cluster per Louvain community.

    Each community is laid out alone (DrL), sized by the cube root of
    its population, then the communities are placed by their links
    (Fruchterman-Reingold) and pushed apart until no two overlap.
    Returns flat positions on the unit sphere and community ids.
    """
    import igraph

    # igraph draws from Python's random module.
    random.seed(seed)
    graph = igraph.Graph(n=size, edges=list(zip(edges[::2], edges[1::2])))
    simple = graph.as_undirected(mode="collapse")
    groups = simple.community_multilevel().membership

    members = {}
    for node, group in enumerate(groups):
        members.setdefault(group, []).append(node)
    order = sorted(members, key=lambda g: (-len(members[g]), g))
    renumber = {g: i for i, g in enumerate(order)}
    groups = [renumber[g] for g in groups]

    local = [None] * size
    radius = []
    for g in order:
        nodes = members[g]
        radius.append(len(nodes) ** (1 / 3))
        if len(nodes) < 4:
            coords = [[random.uniform(-1, 1) for _ in range(3)] for _ in nodes]
        else:
            coords = simple.induced_subgraph(nodes).layout_drl(dim=3).coords
        for node, point in zip(nodes, _unit(coords)):
            local[node] = point

    links = {}
    for a, b in simple.get_edgelist():
        ga, gb = groups[a], groups[b]
        if ga != gb:
            key = (min(ga, gb), max(ga, gb))
            links[key] = links.get(key, 0) + 1
    clusters = igraph.Graph(n=len(order), edges=list(links))
    centers = _unit(clusters.layout_fruchterman_reingold(
        dim=3, weights=list(links.values()) or None).coords)

    # Start packed, then push overlapping pairs apart.
    # ponytail: O(k^2) per pass, fine below a few thousand communities
    scale = 2.0 * sum(radius) / len(radius) ** (2 / 3)
    centers = [[v * scale for v in c] for c in centers]
    for _ in range(300):
        moved = False
        for i in range(len(order)):
            for j in range(i):
                d = [centers[i][k] - centers[j][k] for k in range(3)]
                gap = sum(v * v for v in d) ** 0.5 or 1e-3
                need = 1.05 * (radius[i] + radius[j])
                if gap < need:
                    push = (need - gap) / gap / 2
                    for k in range(3):
                        centers[i][k] += d[k] * push
                        centers[j][k] -= d[k] * push
                    moved = True
        if not moved:
            break
    spread = 1.0

    placed = [[centers[groups[n]][k] * spread + local[n][k] * radius[groups[n]]
               for k in range(3)] for n in range(size)]
    xyz = [round(v, 4) for point in _unit(placed) for v in point]
    return xyz, groups


def build(release, rank_lines, vertex_lines, edge_lines, size, keep):
    """The snapshot the viewer loads, as a JSON-ready dict."""
    top = top_domains(rank_lines, size)
    names = [name for name, _ in top]
    print(f"{len(names)} domains selected.", file=sys.stderr)

    ids = vertex_ids(vertex_lines, names)
    print(f"{len(ids)} vertex ids resolved.", file=sys.stderr)

    edges, inn, out = prune(linked_pairs(edge_lines, ids), len(names), keep)
    print(f"{len(edges) // 2} links kept.", file=sys.stderr)

    xyz, groups = layout(len(names), edges)
    return {
        "release": release,
        "built": datetime.date.today().isoformat(),
        "names": names,
        "hosts": [hosts for _, hosts in top],
        "xyz": xyz,
        "groups": groups,
        "in": inn,
        "out": out,
        "edges": edges,
    }


def latest_release(info, published):
    """First release of graphinfo.json whose domain files are online."""
    for entry in info:
        if published(entry["id"]):
            return entry["id"]
    raise SystemExit("No published Common Crawl web graph found.")


def file_url(release, kind):
    return f"{BASE}/{release}/domain/{release}-domain-{kind}.txt.gz"


def is_published(release):
    request = urllib.request.Request(file_url(release, "edges"), method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=30):
            return True
    except OSError:
        return False


def stream(url):
    """Lines of a remote gzip file, decompressed outside the interpreter."""
    process = subprocess.Popen(
        ["bash", "-o", "pipefail", "-c",
         'curl -sfL --retry 5 "$0" | gzip -dc', url],
        stdout=subprocess.PIPE, bufsize=1 << 20)
    with process:
        try:
            yield from process.stdout
        except GeneratorExit:
            # Reader stopped early: not a failure.
            process.kill()
            raise
    if process.returncode:
        raise SystemExit(f"download failed ({process.returncode}): {url}")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--release", help="graph id, latest when omitted")
    parser.add_argument("--size", type=int, default=20000)
    parser.add_argument("--keep", type=int, default=8,
                        help="outgoing links kept per domain")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    if args.release:
        release = args.release
    else:
        with urllib.request.urlopen(GRAPH_INFO, timeout=30) as response:
            release = latest_release(json.load(response), is_published)
        if args.out.exists() and json.loads(args.out.read_text())["release"] == release:
            print(f"{release} already built.", file=sys.stderr)
            return
    print(f"Release {release}.", file=sys.stderr)

    graph = build(release,
                  stream(file_url(release, "ranks")),
                  stream(file_url(release, "vertices")),
                  stream(file_url(release, "edges")),
                  args.size, args.keep)
    args.out.write_text(json.dumps(graph, separators=(",", ":")))
    print(f"{args.out} written.", file=sys.stderr)


if __name__ == "__main__":
    main()
