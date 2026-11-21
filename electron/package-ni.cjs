const { execFileSync } = require("node:child_process");
const { copyFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { Arch } = require("builder-util");

module.exports = ({ packager, electronPlatformName, arch }) => {
  if (electronPlatformName !== "darwin") return;
  const architectures = { [Arch.arm64]: "aarch64", [Arch.x64]: "x86_64" };
  const cpu = architectures[arch];
  if (!cpu) throw new Error(`Unsupported macOS build architecture: ${Arch[arch]}`);

  const bridge = path.join(packager.projectDir, "bridges", "ni");
  const target = `${cpu}-apple-darwin`;
  const output = path.join(bridge, "target", "packaged", Arch[arch]);
  execFileSync(process.execPath, [path.join(bridge, "build.mjs"), "--release", "--target", target], {
    cwd: bridge,
    env: { ...process.env, CARGO_TARGET_DIR: path.join(bridge, "target") },
    stdio: "inherit"
  });
  mkdirSync(output, { recursive: true });
  copyFileSync(path.join(bridge, "target", target, "release", "studio-grid-ni"), path.join(output, "studio-grid-ni"));
  execFileSync("tar", [
    "-czf", path.join(output, "studio-grid-ni-source.tar.gz"),
    "-C", bridge, "Cargo.toml", "Cargo.lock", "build.mjs", "panel.html", "src", "patches", "vendor"
  ], { stdio: "inherit" });
};
