const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { scrapeLinks } = require('./scraper');

import { getFirestore, doc, getDoc } from "firebase/firestore";


admin.initializeApp();
const db = admin.firestore();

exports.scrapeSite = functions.https.onCall(async (data, context) => {
  const { url } = data;
  const links = await scrapeLinks(url);

  // Stockage dans Firestore
  await db.collection('sites').doc(url).set({
    url,
    outgoingLinks: links,
    lastCrawled: new Date().toISOString()
  });

  return { success: true, links };
});
