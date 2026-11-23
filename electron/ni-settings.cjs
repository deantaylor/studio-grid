const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { promisify } = require("node:util");

const run = promisify(execFile);
const hostAgent = "/Library/Application Support/Native Instruments/Hardware/NIHostIntegrationAgent.app";

async function startNiHostAgent() {
  try {
    await fs.access(hostAgent);
    await run("/usr/bin/open", ["-g", "-a", hostAgent], { timeout: 3000 });
  } catch (cause) {
    // Some controllers use NIHardwareAgent instead.
    if (cause.code !== "ENOENT") console.warn("NI Host Integration Agent could not start:", cause.message);
  }
}

function createNiSettings(app) {
  const supported = process.platform === "darwin";
  let enabled = false;
  let bridge = null;
  let error = "";
  let task = Promise.resolve();

  const preferencePath = () => path.join(app.getPath("userData"), "ni-bridge.json");
  const status = () => ({ supported, enabled, error });

  async function update(url, active) {
    error = "";
    if (!active) {
      const current = bridge;
      bridge = null;
      await current?.close();
      return;
    }
    if (bridge) return;

    const binary = app.isPackaged
      ? path.join(process.resourcesPath, "ni", "studio-grid-ni")
      : path.join(app.getAppPath(), "bridges", "ni", "target", "debug", "studio-grid-ni");
    try {
      await fs.access(binary, fs.constants.X_OK);
      const entry = path.join(app.getAppPath(), "bridges", "ni", "bridge.mjs");
      const { startNiBridge } = await import(pathToFileURL(entry));
      await startNiHostAgent();
      const current = startNiBridge({ url, binary });
      bridge = current;
      current.closed.then(() => {
        if (bridge !== current) return;
        bridge = null;
        error = "The Native Instruments bridge stopped. Turn it off and on to retry.";
      });
      await current.ready;
    } catch (cause) {
      console.error("NI bridge could not start:", cause);
      bridge = null;
      error = app.isPackaged
        ? "The Native Instruments bridge could not start."
        : "Build the Native Instruments bridge with npm run ni:build.";
    }
  }

  return {
    status,
    async start(url) {
      if (!supported) return;
      try {
        const saved = JSON.parse(await fs.readFile(preferencePath(), "utf8"));
        enabled = saved.enabled === true;
      } catch (cause) {
        if (cause.code !== "ENOENT") console.error("NI bridge preference could not be read:", cause);
      }
      enabled ||= process.env.STUDIO_GRID_NI === "1";
      await update(url, enabled);
    },
    setEnabled(url, value) {
      if (!supported || typeof value !== "boolean") return status();
      task = task.then(async () => {
        try {
          const file = preferencePath();
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(`${file}.tmp`, JSON.stringify({ enabled: value }), "utf8");
          await fs.rename(`${file}.tmp`, file);
        } catch (cause) {
          console.error("NI bridge preference could not be saved:", cause);
          error = "The Native Instruments setting could not be saved.";
          return status();
        }
        enabled = value;
        await update(url, enabled);
        return status();
      });
      return task;
    },
    async stop() {
      await task;
      await update(null, false);
    }
  };
}

module.exports = { createNiSettings };
