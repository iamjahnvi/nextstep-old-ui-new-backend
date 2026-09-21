// Take raw HTML → return clean structured content.

const cheerio = require("cheerio");

function cleanText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function parseHTML(html) {
  const $ = cheerio.load(html);

  const title = cleanText($("title").text());

  const headings = [];
  $("h1, h2, h3").each((_, el) => {
    const text = cleanText($(el).text());
    if (text) headings.push(text);
  });

  const paragraphs = [];
  $("p").each((_, el) => {
    const text = cleanText($(el).text());

    if (
      text &&
      text.length > 40 &&
      !text.includes("Content Owned and Maintained") &&
      !text.includes("Designed, Developed")
    ) {
      paragraphs.push(text);
    }
  });

  const links = [];
  $("a").each((_, el) => {
    const text = cleanText($(el).text());
    const url = $(el).attr("href");

    if (text && url) {
      links.push({ text, url });
    }
  });

  // Table text: official pages (e.g. date schedules) commonly publish key
  // facts in <table> markup with no <p> wrapper. Harvested separately so the
  // paragraph filters above stay untouched; consumers opt in explicitly.
  const tables = [];
  $("table").each((_, el) => {
    const text = cleanText($(el).text());
    if (text) tables.push(text);
  });

  return {
    title,
    headings,
    paragraphs,
    tables,
    links
  };
}

module.exports = parseHTML;