import { getSites } from "./firebaseService.js";
import { createTreeGraph } from "./treeGraph.js";

async function main() {
  const sites = await getSites();
  createTreeGraph(sites);
}

main();
