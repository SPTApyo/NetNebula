const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Récupère tous les liens sortants d'une page
 */
async function scrapeLinks(url) {
  try {
    const res = await axios.get(url);
    const $ = cheerio.load(res.data);
    const links = [];
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href && href.startsWith('http')) links.push(href);
    });
    return links;
  } catch (err) {
    console.error('Erreur scrapping:', url, err.message);
    return [];
  }
}

module.exports = { scrapeLinks };
