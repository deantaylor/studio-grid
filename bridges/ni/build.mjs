import { spawnSync } from "node:child_process";
import console from "node:console";
import { cpSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const bridge = fileURLToPath(new URL(".", import.meta.url));
const encdr = path.join(bridge, "target", "encdr-studiogrid");
const view = path.join(bridge, "target", "encdr-view-studiogrid");
cpSync(path.join(bridge, "vendor", "encdr"), encdr, { recursive: true });
cpSync(path.join(bridge, "vendor", "encdr-view"), view, { recursive: true });
for (const [source, patch] of [[encdr, "encdr-instance-readiness"], [view, "encdr-view-hotplug"]]) {
  const result = spawnSync("patch", ["-f", "-p1", "-i", path.join(bridge, "patches", `${patch}.patch`)], {
    cwd: source, stdio: "inherit"
  });
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(1);
  }
}

const cargoArgs = ["build", "--locked", "--manifest-path", path.join(bridge, "Cargo.toml"), ...process.argv.slice(2)];
for (const [crate, source] of [["encdr", encdr], ["encdr-view", view]]) {
  cargoArgs.push("--config", `patch.crates-io.${crate}.path=${JSON.stringify(source)}`);
}
const result = spawnSync("cargo", cargoArgs, { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
