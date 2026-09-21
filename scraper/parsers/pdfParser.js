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