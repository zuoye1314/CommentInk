// VS Code 1.142 fontInfo.ts / EditorLineHeight rules, before editor font zoom.
// This is a versioned calculation from public settings, NOT a DOM measurement
// or a call to Monaco internals. See RESULTS-LAYOUT.md for verification scope.
function resolveLineHeight({ lineHeight = 0, fontSize = 14, platform = process.platform,
  version = "1.142.0" } = {}) {
  if (!Number.isFinite(fontSize) || fontSize < 6 || fontSize > 100
      || !Number.isFinite(lineHeight) || lineHeight < 0 || lineHeight > 150) {
    throw new Error("Unsupported editor font or line-height setting");
  }
  const mode = lineHeight === 0 ? "automatic" : lineHeight < 8 ? "multiplier" : "pixels";
  if (mode !== "pixels" && (!/^1\.142\./.test(version)
      || !["linux", "win32", "darwin"].includes(platform))) {
    throw new Error("Automatic line-height rules have not been checked for this editor version/platform");
  }
  const value = mode === "automatic" ? fontSize * (platform === "darwin" ? 1.5 : 1.35)
    : mode === "multiplier" ? fontSize * lineHeight : lineHeight;
  return { lineHeight: Math.max(8, Math.round(value)), configuredLineHeight: lineHeight,
    editorFontSize: fontSize, lineHeightMode: mode, metricsRule: "vscode-1.142-fontInfo" };
}

module.exports = { resolveLineHeight };
