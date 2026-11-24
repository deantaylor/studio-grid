import { spawn } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import WebSocket from "ws";

const debugBinary = fileURLToPath(new URL("./target/debug/studio-grid-ni", import.meta.url));

export function startNiBridge({
  url = "ws://127.0.0.1:3000",
  binary = debugBinary,
  controller = process.env.STUDIO_GRID_NI_CONTROLLER || "auto",
  visible = process.env.STUDIO_GRID_NI_PREVIEW === "1"
} = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("The NI bridge requires a local Studio Grid WebSocket URL");
  }

  const child = spawn(binary, [controller, ...(visible ? ["--visible"] : [])], {
    env: visible ? process.env : { ...process.env, STUDIO_GRID_NI_BACKGROUND: "1" },
    stdio: ["pipe", "pipe", "inherit"]
  });
  const ready = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let socket;
  let stopTimer;
  let retry;
  let stopped = false;
  let latest;
  let toast = "";
  let toastTimer;
  const activeDevices = new Set();

  function sendToNative(event) {
    if (child.stdin.writable) child.stdin.write(JSON.stringify(event) + "\n");
  }

  function updateScreens() {
    if (latest) sendToNative({ ...latest, toast });
  }

  function connect() {
    if (stopped) return;
    socket = new WebSocket(endpoint);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "subscribe_ni_surface" }));
      for (const device of activeDevices) {
        socket.send(JSON.stringify({ type: "ni_ownership", device, active: true }));
      }
    });
    socket.on("message", (message) => {
      const event = JSON.parse(message.toString());
      if (event.type === "ni_surface") {
        latest = event;
        updateScreens();
      } else if (event.type === "track_activity") {
        sendToNative(event);
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
      if (!stopped) {
        sendToNative({ type: "track_activity", mask: 0 });
        retry = setTimeout(connect, 750);
      }
    });
  }

  const input = createInterface({ input: child.stdout });
  input.on("line", (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.kind === "ownership") {
      const { device, active } = event;
      if (active) activeDevices.add(device);
      else activeDevices.delete(device);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ni_ownership", device, active }));
      }
      return;
    }
    if (socket?.readyState !== WebSocket.OPEN) return;
    const { kind, ...data } = event;
    if (["slot", "pattern", "dial", "nudge", "knob", "octave"].includes(kind)) {
      socket.send(JSON.stringify({ type: "ni_control", ...data }));
    } else if (kind === "pattern_launcher") {
      socket.send(JSON.stringify({ type: "ni_pattern_launcher", ...data }));
    } else if (kind === "edit") {
      socket.send(JSON.stringify({ type: "ni_edit", ...data }));
    } else if (kind === "note_edit") {
      socket.send(JSON.stringify({ type: "ni_note_edit", ...data }));
    }
  });

  function close() {
    if (!stopped) {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(toastTimer);
      socket?.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        stopTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
        stopTimer.unref();
      }
    }
    return closed;
  }

  child.stdin.on("error", close);
  child.on("error", close);
  child.once("close", () => {
    clearTimeout(stopTimer);
    close();
  });
  connect();
  return { ready, closed, close };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const bridge = startNiBridge({ url: process.argv[2] });
  bridge.ready.catch((error) => {
    console.error(`NI bridge could not start: ${error.message}. Run npm run ni:build first.`);
    process.exitCode = 1;
  });
  process.once("SIGINT", bridge.close);
  process.once("SIGTERM", bridge.close);
}
