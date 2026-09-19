"use strict";

const fs = require("node:fs");
const path = require("node:path");
const transforms = require("./sourceTransforms");

// Independent anchors that must still look like EveJS 0.12.8 before the mod is
// allowed to touch anything. They only prove the file is the shape the seam
// expects; the seam itself is counted again inside the transform.
const SOURCE_REQUIREMENTS = Object.freeze([
  {
    key: "beyonceServiceShape",
    file: "server/src/services/ship/beyonceService.js",
    required: [
      "  Handle_CmdWarpToStuffAutopilot(args, session) {",
      "  Handle_CmdDock(args, session) {",
      "[Beyonce] CmdWarpToStuffAutopilot char=",
    ],
  },
]);

function inspectSourceShape(runtimeRoot, definition) {
  const filename = path.join(runtimeRoot, ...definition.file.split("/"));
  let source = "";
  try {
    source = fs.readFileSync(filename, "utf8");
  } catch (error) {
    return { key: definition.key, filename, ok: false, state: "missing", reason: error.message };
  }
  const problems = definition.required.flatMap((token) => {
    const count = source.split(token).length - 1;
    return count === 1
      ? []
      : [`API seam ${JSON.stringify(token)} count ${count}, expected 1`];
  });
  return {
    key: definition.key,
    filename,
    ok: problems.length === 0,
    state: problems.length === 0 ? "vanilla" : "missing",
    reason: problems.length > 0 ? problems.join("; ") : null,
  };
}

function inspect(runtimeRoot) {
  const transformReport = transforms.inspect(runtimeRoot);
  const reports = [
    ...transformReport.reports,
    ...SOURCE_REQUIREMENTS.map((definition) => inspectSourceShape(runtimeRoot, definition)),
  ];
  return { ok: reports.every((report) => report.ok), reports };
}

module.exports = {
  SOURCE_REQUIREMENTS,
  inspect,
  inspectSourceShape,
};