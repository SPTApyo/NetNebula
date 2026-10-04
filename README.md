# NetNebula

<p align="center">
<em>A 3D map of the most linked domains on the web: a domain is a point, a link is a line.</em>
</p>

<p align="center">
  <a href="https://github.com/SPTApyo/NetNebula/actions/workflows/build_graph.yml"><img alt="Graph build" src="https://img.shields.io/github/actions/workflow/status/SPTApyo/NetNebula/build_graph.yml?style=flat-square&label=Graph&color=007cf0" /></a>
  <a href="https://github.com/SPTApyo/NetNebula/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/SPTApyo/NetNebula?style=flat-square&label=Updated&color=007cf0" /></a>
</p>

## How it works

NetNebula does not crawl the web page by page. It starts from the domain-level web graph that [Common Crawl](https://commoncrawl.org/web-graphs) publishes every month: over 100 million domains and billions of links.

The pipeline keeps the 20,000 most central domains (harmonic centrality) and drops infrastructure (CDNs, APIs, trackers). For each domain it keeps 8 outgoing links: reciprocal links first, then the least cited targets, because linking to a niche site says more than linking to a giant. It then finds communities, lays each one out as its own 3D galaxy, and writes a single file: public/graph.json.

The site is static. It loads that file and draws the map with WebGL2, with no database.

```text
Common Crawl ──> pipeline/build_graph.py ──> public/graph.json ──> public/ (Firebase Hosting)
  ranks, vertices, edges     filter, communities, layout        WebGL2 viewer
```

## Usage

Environment: `nix develop`, or Python 3.11+ with `pip install -r pipeline/requirements.txt`.

```bash
npm run test           # pipeline tests, no network
npm run graph:small    # 2,000-domain graph
npm run graph          # full graph, about 7 minutes, 9 GB streamed
npm run serve          # local site on http://localhost:5000
npm run deploy         # publish
```

build_graph.py options: `--size` (number of domains), `--keep` (links kept per domain), `--release` (Common Crawl graph id, latest by default), `--out`.

## CI/CD

- build_graph.yml: on the 5th of each month and on demand. Runs the tests, rebuilds the graph when Common Crawl has a new release, commits public/graph.json and deploys.
- firebase-hosting-merge.yml: tests, then deploy on every push to main.
- firebase-hosting-pull-request.yml: tests, then a preview channel for each pull request.

## Controls

- Drag to look, WASD to fly, double-click a domain to focus.
- T: view all, H: random domain, P: pause, L: light or dark theme.
- Search filters domains; Enter flies to the first match.

## License

MIT.
