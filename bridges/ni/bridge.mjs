import { spawn } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import WebSocket from "ws";

const binary = fileURLToPath(new URL("./target/debug/studio-grid-ni", import.meta.url));

export function startNiBridge({
  url = "ws://127.0.0.1:3000",
  controller = process.env.STUDIO_GRID_NI_CONTROLLER || "s49",
  visible = process.env.STUDIO_GRID_NI_PREVIEW === "1"
} = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("The NI bridge requires a local Studio Grid WebSocket URL");
  }

  const child = spawn(binary, [controller, ...(visible ? ["--visible"] : [])], {
    env: { ...process.env, NORD_MODULAR_NI_BACKGROUND: "1" },
    stdio: ["pipe", "pipe", "inherit"]
  });
  let socket;
  let retry;
  let stopped = false;
  let latest;
  let toast = "";
  let toastTimer;
  let controllerActive = false;

  function updateScreens() {
    if (latest && child.stdin.writable) {
      child.stdin.write(JSON.stringify({ ...latest, toast }) + "\n");
    }
  }

  function connect() {
    if (stopped) return;
    socket = new WebSocket(endpoint);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "subscribe_ni_surface" }));
      if (controllerActive) socket.send(JSON.stringify({ type: "ni_ownership", active: true }));
    });
    socket.on("message", (message) => {
      const event = JSON.parse(message.toString());
      if (event.type === "ni_surface") {
        latest = event;
        updateScreens();
      } else if (event.type === "ni_toast") {
        toast = event.text;
        clearTimeout(toastTimer);
        updateScreens();
        toastTimer = setTimeout(() => {
          toast = "";
          updateScreens();
        }, 2000);
      }
    });
    socket.on("error", () => {
      // A local server restart is handled by the close listener.
    });
    socket.on("close", () => {
      if (!stopped) retry = setTimeout(connect, 750);
    });
  }

  const input = createInterface({ input: child.stdout });
  input.on("line", (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.kind === "ownership") {
      controllerActive = event.active === true;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ni_ownership", active: controllerActive }));
      }
      return;
    }
    if (socket?.readyState !== WebSocket.OPEN) return;
    const { kind, ...data } = event;
    if (["slot", "pattern", "dial", "knob", "octave"].includes(kind)) {
      socket.send(JSON.stringify({ type: "ni_control", ...data }));
    } else if (kind === "pattern_launcher") {
      socket.send(JSON.stringify({ type: "ni_pattern_launcher", pressed: data.pressed }));
    } else if (kind === "edit") {
      socket.send(JSON.stringify({ type: "ni_edit", action: data.action }));
    } else if (kind === "note_edit") {
      socket.send(JSON.stringify({ type: "ni_note_edit", action: data.action }));
    }
  });

  function close() {
    if (stopped) return;
    stopped = true;
    clearTimeout(retry);
    clearTimeout(toastTimer);
    socket?.close();
    child.stdin.end();
  }

  child.stdin.on("error", close);
  child.on("error", (error) => {
    console.error(`NI bridge could not start: ${error.message}. Run npm run ni:build first.`);
    close();
  });
  child.on("exit", close);
  connect();
  return { close };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const bridge = startNiBridge({ url: process.argv[2] });
  process.once("SIGINT", bridge.close);
  process.once("SIGTERM", bridge.close);
}
