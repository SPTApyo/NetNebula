# NetNebula

<p align="center">
<em>Carte 3D des domaines les plus liés du web : un domaine est un point, un lien est un trait.</em>
</p>

<p align="center">
  <a href="https://github.com/SPTApyo/NetNebula/actions/workflows/build_graph.yml"><img alt="Graphe" src="https://img.shields.io/github/actions/workflow/status/SPTApyo/NetNebula/build_graph.yml?style=flat-square&label=Graphe&color=007cf0" /></a>
  <a href="https://github.com/SPTApyo/NetNebula/commits/main"><img alt="Mise à jour" src="https://img.shields.io/github/last-commit/SPTApyo/NetNebula?style=flat-square&label=Mise%20%C3%A0%20jour&color=007cf0" /></a>
</p>

## Principe

NetNebula ne crawle plus le web page par page. Il part du graphe de domaines publié chaque mois par [Common Crawl](https://commoncrawl.org/web-graphs) : plus de 100 millions de domaines et des milliards de liens.

Le pipeline garde les 20 000 domaines les plus centraux (centralité harmonique), retire l'infrastructure (CDN, API, traceurs), garde pour chacun ses 8 liens sortants vers les domaines les mieux classés, calcule une disposition 3D et des communautés, puis écrit un seul fichier : public/graph.json.

Le site est statique. Il charge ce fichier et dessine la carte en WebGL2, sans base de données.

```text
Common Crawl ──> pipeline/build_graph.py ──> public/graph.json ──> public/ (Firebase Hosting)
  ranks, vertices, edges     filtre, layout, communautés        viewer WebGL2
```

## Utilisation

Environnement : `nix develop`, ou Python 3.11+ avec `pip install -r pipeline/requirements.txt`.

```bash
npm run test           # tests du pipeline, sans réseau
npm run graph:small    # graphe de 2 000 domaines
npm run graph          # graphe complet, environ 10 minutes et 9 Go téléchargés en flux
npm run serve          # site local sur http://localhost:5000
npm run deploy         # mise en ligne
```

Options de build_graph.py : `--size` (nombre de domaines), `--keep` (liens gardés par domaine), `--release` (version Common Crawl, la plus récente par défaut), `--out`.

## CI/CD

- build_graph.yml : le 5 de chaque mois et à la demande. Tests, build du graphe si une nouvelle version Common Crawl est sortie, commit de public/graph.json, déploiement.
- firebase-hosting-merge.yml : tests puis déploiement à chaque push sur main.
- firebase-hosting-pull-request.yml : tests puis preview sur chaque PR.

## Interface

- Glisser pour regarder, WASD pour voler, double-clic pour cibler un domaine.
- T : tout voir, H : domaine au hasard, P : pause, L : thème clair ou sombre.
- La recherche filtre les domaines, Entrée vole vers le premier résultat.

## Licence

MIT.
