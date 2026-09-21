// Generic extractor: identity facts come from the adapter config, descriptive
// text from the parsed page. No hardcoded exam facts here.
function extractBasicInfo(data, adapter) {
  const exclusions = Array.isArray(adapter.descriptionExclusions)
    ? adapter.descriptionExclusions
    : [];
  return {
    examName: data.title,
    fullForm: adapter.fullForm,
    conductingBody: adapter.conductingBody,
    description: data.paragraphs
      .filter((p) => !exclusions.some((ex) => p.includes(ex)))
      .slice(0, 2)
      .join(" "),
    officialWebsite: adapter.officialWebsite
  };
}

module.exports = extractBasicInfo;
