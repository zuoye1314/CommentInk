// Desktop integration launcher. Creates an isolated profile; never attaches to
// a daily VS Code instance or changes daily user/workspace configuration.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "asciiflow-studio-"));
  const user = path.join(directory, "user-data");
  await fs.mkdir(path.join(user, "User"), { recursive: true }); await fs.mkdir(path.join(directory, "extensions"));
  await fs.writeFile(path.join(user, "User/settings.json"), JSON.stringify({
    "workbench.startupEditor": "none", "workbench.colorTheme": "Dark Modern", "editor.fontSize": 14,
    "editor.lineHeight": 0, "editor.minimap.enabled": false, "editor.wordWrap": "off", "editor.codeLens": true,
    "workbench.secondarySideBar.defaultVisibility": "hidden", "telemetry.telemetryLevel": "off",
    "update.mode": "none", "extensions.autoUpdate": false, "extensions.ignoreRecommendations": true,
  }));
  console.log(`Evidence: ${directory}`);
  const port = process.env.COMMENT_STUDIO_TEST_PORT || "9361";
  const child = spawn("/usr/bin/code", ["--new-window", "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
    "--user-data-dir", user, "--extensions-dir", path.join(directory, "extensions"), "--extensionDevelopmentPath", __dirname,
    "--extensionTestsPath", path.join(__dirname, "studio/test-runner.cjs"), `--remote-debugging-port=${port}`, "--disable-gpu", "--no-sandbox"],
  { env: { ...process.env, COMMENT_PREVIEW_PROBE_DIR: directory }, stdio: "inherit" });
  child.on("error", (error) => { throw error; });
  await new Promise((resolve) => child.once("exit", resolve));
  const measure = spawn(process.execPath, [path.join(__dirname, "studio/measure.cjs"), directory, `http://127.0.0.1:${port}`], { env: process.env, stdio: "inherit" });
  const result = await new Promise((resolve) => measure.once("exit", resolve));
  process.exitCode = result || 0;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
