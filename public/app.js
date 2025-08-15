// Initialisation Firebase (déjà dans ton init.js)
import { getFirestore, doc, getDoc } from "firebase/firestore";

const db = firebase.firestore();

// Exemple de récupération des sites depuis Firestore
async function loadSites() {
  const snapshot = await db.collection('sites').get();
  const sites = snapshot.docs.map(doc => doc.data());
  console.log('Sites loaded:', sites);
  return sites;
}

// Fonction pour initialiser la visualisation 3D (Three.js ou Babylon.js)
function init3DGraph(sites) {
  // TODO: créer scène, caméras, nœuds pour chaque site
  console.log('Initialisation de la carte 3D avec', sites.length, 'sites');
}

// Chargement des données et initialisation
document.addEventListener('DOMContentLoaded', async () => {
  const sites = await loadSites();
  init3DGraph(sites);
});
