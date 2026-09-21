function extractSection(text, startMarker, endMarker) {
  const start = text.lastIndexOf(startMarker);

  if (start === -1) {
    return "";
  }

  const contentStart = start + startMarker.length;

  const end = text.indexOf(endMarker, contentStart);

  if (end === -1) {
    return text.slice(contentStart).trim();
  }

  return text.slice(contentStart, end).trim();
}

module.exports = extractSection;