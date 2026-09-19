# NetNebula

<p align="center">
  <img src=".github/assets/banner.svg" alt="NetNebula Banner" width="80%" />
</p>

<p align="center">
<em>Interactive 3-D graph of the web: pages are nodes, links are edges.</em>
</p>

<hr/>
<br/>

<p align="center">
  <!-- CI & Quality -->
  <a href="https://github.com/SPTApyo/NetNebula/actions/workflows/run_crawler.yml"><img src="https://img.shields.io/github/actions/workflow/status/SPTApyo/NetNebula/run_crawler.yml?style=flat-square&label=Crawl+Test&color=007cf0" /></a>
  <!-- License -->
  <a href="https://github.com/SPTApyo/NetNebula/blob/main/LICENSE"><img src="https://img.shields.io/github/license/SPTApyo/NetNebula?style=flat-square&label=License&color=ff0080" /></a>
  <!-- Last Commit -->
  <a href="https://github.com/SPTApyo/NetNebula/commits/main"><img src="https://img.shields.io/github/last-commit/SPTApyo/NetNebula?style=flat-square&label=Updated&color=007cf0" /></a>
</p>

## Overview

NetNebula is a two‑part system that maps the web into an interactive 3‑D visualisation.
The **crawler** (Python + Firebase Admin SDK) populates Firestore with pages and links, while the **viewer** (static page served by Firebase Hosting) reads that data to render a WebGL2 graph.

- **Crawler**: discovers pages starting from seed URLs, respects `robots.txt`, stores metadata in Firestore, and persists frontier state locally for fast restarts.
- **Viewer**: loads the Firestore snapshot into a lightweight client, positions nodes via a precomputed spatial layout, and renders edges with WebGL2.

Both components communicate only through Firestore; no direct network traffic between them is required.

## Architecture

```
scrapper/crawler.py ──writes──> Firestore ──reads──> public/ (viewer)
   Admin SDK                pages/            layout.worker.js
                            frontier/         meta/stats
```

- `pages/{sha1(url)}`: page metadata (`url`, `domain`, `title`, `linked_to[]`, spatial coordinates, etc.).
- `frontier/{sha1(url)}`: queue state for pages yet to be crawled.
- `meta/stats`: aggregated statistics (page count, frontier size, domain distribution).

The viewer reconstructs the graph client‑side using a grid of cells; node positions are immutable once assigned by the crawler.

## Features

| Feature | Description |
|---|---|
| **Incremental Crawling** | The crawler can be stopped and resumed; frontier state is cached locally to avoid expensive Firestore reads on restart. |
| **Rate‑Limiting & Quota Guarding** | Configurable write budget, page limits, and per‑host concurrency prevent exceeding Firebase Spark plan quotas. |
| **Robots.txt Compliance** | Each host’s robots file is fetched once and cached; disallowed URLs are marked `done` and never retried. |
| **Structured Logging** | Uses `loguru` for consistent timestamps and log levels across all outputs. |
| **GitHub Actions CI** | Automated daily crawl runs (`run_crawler.yml`) ensure the database stays up‑to‑date in production. |
| **Local Development** | Supports a Firestore emulator; run with `FIRESTORE_EMULATOR_HOST` to avoid quota usage and allow rapid iteration. |

## Getting Started

### Prerequisites
- Python 3.10+ (recommended via virtualenv or Conda)
- Firebase project with Admin SDK service account key
- (Optional) Firestore emulator for local testing

#### 1. Clone the repo
```bash
git clone https://github.com/SPTApyo/NetNebula.git
cd NetNebula
```

#### 2. Install dependencies
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

> `requirements.txt` contains the crawler's Python dependencies, including `loguru` for logging.

#### 3. Configure credentials
Create a `.env` file from the template:
```bash
cp scrapper/.env.example scrapper/.env
```
Edit `scrapper/.env` to point `GOOGLE_APPLICATION_CREDENTIALS` or `NN_SERVICE_ACCOUNT` at your service‑account JSON key.

#### 4. Run the crawler (production)
```bash
python scrapper/crawler.py            # starts crawling / resumes existing run
python scrapper/crawler.py --status   # prints database statistics
```

The crawler writes provisional positions while it discovers pages. With
`NN_AUTO_PLACE=1`, it places pending pages first, then spends the remaining
quota on crawling. A quota error exits cleanly and retries on the next run.

#### 5. Local emulator (no quota)
```bash
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8088
python scrapper/crawler.py            # uses the local emulator
```

### Viewer
Navigate to `public/` in a browser or deploy via Firebase Hosting:
```bash
firebase deploy --only hosting
```
The viewer automatically reads Firestore and renders the graph.

## Configuration
All runtime settings are loaded from environment variables or `.env`. Key variables include:
- `NN_WRITE_BUDGET`: maximum crawler writes per run (default 18,000)
- `NN_PLACE_WRITE_LIMIT`: maximum writes allowed by `--place` (default 19,999)
- `NN_MAX_PAGES`: total pages to crawl before stopping (default 500,000)
- `NN_OBEY_ROBOTS`: whether to respect robots.txt (default 1)
- `NN_PER_HOST`: concurrent connections per host (default 8)
- `FETCH_TIMEOUT`: HTTP timeout in seconds (default 15)

See `scrapper/.env.example` for a full list with defaults.

## Contributing
Pull requests are welcome. Please ensure tests pass locally (`python scrapper/test_crawler.py`) and that the CI workflow remains green.

## License
This project is licensed under the MIT license. See [LICENSE](LICENSE) for details.
