import { getSites } from "./src/firebaseService.js";
import { createTreeGraph } from "./src/treeGraph.js";

async function main() {
  const sites = await getSites();
  createTreeGraph(sites);
}

main();
