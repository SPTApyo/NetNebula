// src/firebaseService.js
import { collection, getDocs } from "firebase/firestore";
import { db } from "./init.js";

/**
 * Récupère tous les sites et leurs liens depuis Firestore
 * Structure attendue pour chaque document :
 * { name: "Site A", links: ["Site B", "Site C"] }
 */
export async function getSites() {
  const sitesCol = collection(db, "sites");
  const snapshot = await getDocs(sitesCol);
  const sites = [];
  snapshot.forEach(doc => {
    sites.push({ id: doc.id, ...doc.data() });
  });
  return sites;
}
