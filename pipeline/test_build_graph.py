"""Pipeline checks: synthetic data, no network.

    python pipeline/test_build_graph.py
"""

import json

import build_graph as b

RANKS = b"""#harmonicc_pos\t#harmonicc_val\t#pr_pos\t#pr_val\t#host_rev\t#n_hosts
1\t9.0E7\t1\t0.01\tcom.googleapis\t2899
2\t8.0E7\t2\t0.01\tcom.facebook\t3750
3\t7.0E7\t3\t0.01\torg.wikipedia\t2204
4\t6.0E7\t4\t0.01\tcom.github\t6211
5\t5.0E7\t5\t0.01\tuk.co.bbc\t291
6\t4.0E7\t6\t0.01\tcom.example\t12
""".splitlines()

VERTICES = b"""0\tcom.example\t12
1\tcom.facebook\t3750
2\tcom.github\t6211
3\tcom.googleapis\t2899
4\tfr.lemonde\t40
5\torg.wikipedia\t2204
6\tuk.co.bbc\t291
""".splitlines()

EDGES = b"""1\t2
1\t5
1\t6
2\t1
2\t3
2\t5
3\t1
4\t5
5\t1
5\t2
5\t6
6\t5
""".splitlines()


def test_domain_name():
    assert b.domain_name("com.github") == "github.com"
    assert b.domain_name("uk.co.bbc") == "bbc.co.uk"


def test_top_domains_skips_header_and_infrastructure():
    top = b.top_domains(RANKS, 3)
    assert top == [("facebook.com", 3750), ("wikipedia.org", 2204),
                   ("github.com", 6211)], top


def test_top_domains_stops_early():
    def lines():
        yield from RANKS[:3]
        raise AssertionError("read past the needed lines")
    assert len(b.top_domains(lines(), 1)) == 1


def test_vertex_ids():
    names = ["facebook.com", "wikipedia.org", "github.com"]
    assert b.vertex_ids(VERTICES, names) == {b"1": 0, b"5": 1, b"2": 2}


def test_linked_pairs_keeps_edges_inside_the_selection():
    ids = {b"1": 0, b"5": 1, b"2": 2}
    pairs = sorted(b.linked_pairs(EDGES, ids))
    assert pairs == [(0, 1), (0, 2), (1, 0), (1, 2), (2, 0), (2, 1)], pairs


def test_prune_prefers_reciprocal_then_rare_targets():
    # 0 links to 1, 2, 3. Only 3 links back. 1 is cited more than 2.
    pairs = [(0, 1), (0, 2), (0, 3), (3, 0), (4, 1), (2, 4)]
    edges, inn, out = b.prune(pairs, 5, keep=2)
    kept = set(zip(edges[::2], edges[1::2]))
    assert (0, 3) in kept and (0, 2) in kept and (0, 1) not in kept, kept
    assert inn == [1, 2, 1, 1, 1] and out == [3, 0, 1, 1, 1]


def test_prune_rescues_nodes_left_without_links():
    # Node 3 is only cited, by hubs that prefer others.
    pairs = [(0, 1), (0, 2), (0, 3), (1, 0), (2, 0), (1, 3)]
    edges, _, _ = b.prune(pairs, 4, keep=1, rescue=1)
    kept = set(zip(edges[::2], edges[1::2]))
    assert (1, 3) in kept, kept
    assert edges[::2] == sorted(edges[::2])


def test_prune_ignores_duplicate_pairs():
    edges, inn, out = b.prune([(0, 1), (0, 1)], 2, keep=4)
    assert edges == [0, 1] and inn == [0, 1] and out == [1, 0]


def test_layout_is_deterministic_and_normalised():
    edges = [0, 1, 1, 2, 2, 0, 3, 4, 4, 5, 5, 3, 0, 3]
    first = b.layout(6, edges)
    second = b.layout(6, edges)
    assert first == second
    xyz, groups = first
    assert len(xyz) == 18 and len(groups) == 6
    reach = max((xyz[i] ** 2 + xyz[i + 1] ** 2 + xyz[i + 2] ** 2) ** 0.5
                for i in range(0, 18, 3))
    assert 0.5 < reach <= 1.4 + 1e-3, reach


def test_build_produces_a_consistent_snapshot():
    graph = b.build("cc-test", RANKS, VERTICES, EDGES, size=3, keep=8)
    assert graph["release"] == "cc-test"
    assert graph["names"] == ["facebook.com", "wikipedia.org", "github.com"]
    n = len(graph["names"])
    assert len(graph["xyz"]) == 3 * n
    for key in ("hosts", "groups", "in", "out"):
        assert len(graph[key]) == n, key
    assert all(0 <= i < n for i in graph["edges"])
    assert len(graph["edges"]) % 2 == 0
    json.dumps(graph)


def test_latest_release_takes_the_first_published():
    info = [{"id": "cc-new"}, {"id": "cc-old"}]
    assert b.latest_release(info, lambda r: r == "cc-old") == "cc-old"
    assert b.latest_release(info, lambda r: True) == "cc-new"


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for test in tests:
        test()
        print(f"ok  {test.__name__}")
    print(f"\n{len(tests)} tests passed.")


if __name__ == "__main__":
    main()
