import { spawnSync } from "node:child_process";
import console from "node:console";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const bridge = fileURLToPath(new URL(".", import.meta.url));
const reference = path.resolve(process.env.STUDIO_GRID_ENCDR_SOURCE || path.join(bridge, "../../../modular-machine-mk3"));
const encdrSource = path.join(reference, "vendor", "encdr");
const viewSource = path.join(reference, "vendor", "encdr-view");
if (![encdrSource, viewSource].every((source) => existsSync(path.join(source, "Cargo.toml")))) {
  console.error("Set STUDIO_GRID_ENCDR_SOURCE to the modular-machine-mk3 checkout with the patched encdr crates.");
  process.exit(1);
}

// Encdr's NI service registration currently hardcodes the instance label.
const encdr = path.join(bridge, "target", "encdr-studiogrid");
const protocolPath = path.join("src", "usb", "ni_service", "protocol.rs");
const protocol = readFileSync(path.join(encdrSource, protocolPath), "utf8");
const instanceLabel = /(pub fn instance_setup\(product_id: u16\) -> Vec<Vec<u8>> \{\s*)let project: &\[u8\] = [^;]+;/;
if (!instanceLabel.test(protocol)) {
  console.error("The Encdr NI instance setup changed. Update the Studio Grid instance label patch.");
  process.exit(1);
}
cpSync(encdrSource, encdr, { recursive: true });
writeFileSync(path.join(encdr, protocolPath), protocol.replace(instanceLabel, '$1let project: &[u8] = b"studiogrid\\0";'));

const cargoArgs = ["build", "--locked", "--manifest-path", path.join(bridge, "Cargo.toml")];
for (const [crate, source] of [["encdr", encdr], ["encdr-view", viewSource]]) {
  cargoArgs.push("--config", `patch.crates-io.${crate}.path=${JSON.stringify(source)}`);
}
const result = spawnSync("cargo", cargoArgs, { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
