const { PDFParse } = require("pdf-parse");

async function parsePDF(url) {
  const parser = new PDFParse({ url });

  const result = await parser.getText();

  await parser.destroy();

  return result.text;
}

// Buffer twin of parsePDF: parses an already-retrieved PDF (e.g. a
// RawDocument content Buffer) without refetching it over the network.
async function parsePDFBuffer(buffer) {
  const parser = new PDFParse({ data: buffer });

  const result = await parser.getText();

  await parser.destroy();

  return result.text;
}

module.exports = parsePDF;
module.exports.parsePDF = parsePDF;
module.exports.parsePDFBuffer = parsePDFBuffer;

// It takes a PDF and converts it into plain text so the scraper can actually understand/search the PDF's contents.

// PDF website
//    ↓
// fetchDocument()
//    ↓
// PDF downloaded
//    ↓
// PDF parser
//    ↓
// Plain text
//    ↓
// Extractors
//    ↓
// Registration dates / eligibility / subjects / etc.

// There are two ways it can receive the PDF :-

// 1. PDF URL
// PDF URL
//   ↓
// parser fetches PDF
//   ↓
// extracts text
//   ↓
// returns text

// This is useful when you only have the PDF's URL.

// 2. Already-downloaded PDF Buffer

// PDF already downloaded
//        ↓
//      Buffer
//        ↓
// PDF parser
//        ↓
// extract text
//        ↓
// return text
