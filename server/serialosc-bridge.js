import EventEmitter from "events";
import osc from "osc";

const SERIALOSC_PORT = 12002; // default serialosc UDP port
const DISCOVERY_LISTEN_PORT = 12011; // our discovery listen port (separate from web)
const DEVICE_LISTEN_PORT = 12012; // where the grid sends key events
const LOCALHOST = "127.0.0.1";
const ANYHOST = "0.0.0.0";

export class SerialOSCBridge extends EventEmitter {
  constructor({ prefix = "studiogrid" } = {}) {
    super();
    this.prefix = prefix;
    this.serial = null;
    this.devices = new Map(); // id -> device info/ports
    this.rediscoverTimer = null;
    this.lastRediscover = 0;
    this.connected = false; // any device connected
    this.rotation = 0;
    this._lastDeviceSignature = "";
    this.portMap = new Map(); // deviceId -> listen port
    this.nextPort = DEVICE_LISTEN_PORT;
    this.pendingRemove = new Map(); // deviceId -> timeout
  }

  argValue(arg) {
    return arg && typeof arg === "object" && "value" in arg ? arg.value : arg;
  }

  allocatePort(deviceId, startAt = null) {
    if (this.portMap.has(deviceId) && startAt == null) return this.portMap.get(deviceId);
    const used = new Set(this.portMap.values());
    let candidate = startAt != null ? startAt : this.nextPort;
    while (used.has(candidate)) candidate += 1;
    this.portMap.set(deviceId, candidate);
    this.nextPort = Math.max(this.nextPort, candidate + 1);
    return candidate;
  }

  hasConnectedDevices() {
    return Array.from(this.devices.values()).some((d) => !!d.devicePort);
  }

  setRotation(degrees) {
    if ((degrees !== 0 && degrees !== 180) || degrees === this.rotation) return false;
    this.rotation = degrees;
    for (const device of this.devices.values()) this.applyRotation(device);
    return true;
  }

  applyRotation(device) {
    if (!device.connected || device.rotation === this.rotation || device.heldKeys.size || /\barc\b/i.test(device.type)) return;
    device.devicePort.send({ address: "/sys/rotation", args: [{ type: "i", value: this.rotation }] });
    device.rotation = this.rotation;
    if (device.lastFrame) this.fullResync({ deviceId: device.id });
  }

  start() {
    // Port used to ask serialosc for devices (broadcast /serialosc/list)
    this.serial = new osc.UDPPort({
      localAddress: ANYHOST,
      localPort: DISCOVERY_LISTEN_PORT,
      remoteAddress: LOCALHOST,
      remotePort: SERIALOSC_PORT,
      metadata: true
    });

    this.serial.on("ready", () => {
      this.emit("log", `serialosc ready (port ${this.serial.options.localPort})`);
      this.serial.send({
        address: "/serialosc/list",
        args: [
          { type: "s", value: LOCALHOST },
          { type: "i", value: this.serial.options.localPort }
        ]
      });
      // subscribe to hotplug notifications
      this.serial.send({
        address: "/serialosc/notify",
        args: [
          { type: "s", value: LOCALHOST },
          { type: "i", value: this.serial.options.localPort }
        ]
      });
    });

    this.serial.on("message", (msg) => this.handleSerialMessage(msg));
    this.serial.on("error", (e) => this.emit("error", e));
    this.serial.open();
  }

  handleSerialMessage(msg) {
    const rearmNotify = () => {
      if (this.serial) {
        this.serial.send({
          address: "/serialosc/notify",
          args: [
            { type: "s", value: LOCALHOST },
            { type: "i", value: this.serial.options.localPort }
          ]
        });
      }
    };
    if (msg.address === "/serialosc/device" || msg.address === "/serialosc/add") {
      // serialosc/device args: id, type, port (metadata)
      const id = this.argValue(msg.args[0]);
      const type = this.argValue(msg.args[1]);
      const port = this.argValue(msg.args[2]);
      const host = LOCALHOST; // serialosc always on localhost; avoid DNS on device name
      this.emit("log", `found device id=${id} type=${type} @ ${host}:${port}`);
      // cancel pending removal if flapping
      const pending = this.pendingRemove.get(id);
      if (pending) {
        clearTimeout(pending);
        this.pendingRemove.delete(id);
      }
      this.connectDevice({ id, type, host, port });
      rearmNotify();
    } else if (msg.address === "/serialosc/remove") {
      const id = this.argValue(msg.args[0]);
      this.emit("log", `Grid removed ${id || ""}`.trim());
      if (this.pendingRemove.has(id)) return;
      const timeoutId = setTimeout(() => {
        this.pendingRemove.delete(id);
        this.disconnectDevice(id);
      }, 800);
      this.pendingRemove.set(id, timeoutId);
      rearmNotify();
    }
  }

  connectDevice({ id, type, host, port }) {
    const key = id || `${host}:${port}`;
    // close any existing connection for this id
    if (this.devices.has(key)) {
      const existing = this.devices.get(key);
      try {
        existing?.devicePort?.close();
      } catch (e) {
        this.emit("error", e);
      }
    }
    const supportsLevels = typeof type === "string" ? !type.toLowerCase().includes("40h") : true;
    const guessed = (typeof type === "string" ? type.toLowerCase() : "");
    const guessSize = () => {
      if (guessed.includes("40h") || guessed.includes("64")) return { cols: 8, rows: 8 };
      if (guessed.includes("128")) return { cols: 16, rows: 8 };
      if (guessed.includes("256")) return { cols: 16, rows: 16 };
      return { cols: 16, rows: 8 };
    };
    const initSize = guessSize();
    const device = {
      id: key,
      type: type || "",
      host,
      port,
      listenPort: this.allocatePort(key),
      gridCols: initSize.cols,
      gridRows: initSize.rows,
      supportsLevels,
      devicePort: null,
      backBuffer: null,
      frontBuffer: null,
      lastFrame: null,
      rotation: null,
      heldKeys: new Set(),
      connected: false
    };
    this.devices.set(key, device);
    this.openDevicePort(device);
  }

  openDevicePort(device, retryCount = 0) {
    if (!device) return;
    const portRef = new osc.UDPPort({
      localAddress: ANYHOST,
      localPort: device.listenPort, // stable port per device/id
      remoteAddress: device.host,
      remotePort: device.port,
      metadata: true
    });

    device.devicePort = portRef;

    portRef.on("ready", () => {
      if (!device.devicePort || device.devicePort !== portRef || !portRef.options) return;
      this.emit("log", `device ready ${device.id} (local ${portRef.options.localPort})`);
      // standard sys setup (as per monome serialosc docs)
      const hostToSet = portRef.options.localAddress === ANYHOST ? LOCALHOST : portRef.options.localAddress;
      const listenPortResolved = portRef.options.localPort || device.listenPort || DEVICE_LISTEN_PORT;
      device.listenPort = listenPortResolved;
      this.portMap.set(device.id, listenPortResolved);
      portRef.send({
        address: "/sys/host",
        args: [{ type: "s", value: hostToSet }]
      });
      portRef.send({
        address: "/sys/port",
        args: [{ type: "i", value: listenPortResolved }]
      });
      portRef.send({
        address: "/sys/prefix",
        args: [{ type: "s", value: `/${this.prefix}` }]
      });
      device.connected = true;
      this.applyRotation(device);
      portRef.send({ address: `/${this.prefix}/grid/led/all`, args: [{ type: "i", value: 0 }] });
      portRef.send({ address: "/sys/info", args: [] });
      setTimeout(() => {
        // port may have been closed before the delayed resend; bail quietly if so
        if (!device.devicePort || device.devicePort !== portRef || !portRef.socket) return;
        try {
          // address() throws if the underlying dgram socket is closed/not bound.
          portRef.socket.address();
        } catch (err) {
          return;
        }
        try {
          portRef.send({
            address: "/sys/host",
            args: [{ type: "s", value: hostToSet }]
          });
          portRef.send({
            address: "/sys/port",
            args: [{ type: "i", value: device.listenPort }]
          });
          portRef.send({
            address: "/sys/prefix",
            args: [{ type: "s", value: `/${this.prefix}` }]
          });
        } catch (err) {
          // surface error but don't crash if socket was torn down
          this.emit("error", err);
        }
      }, 100);
      device.lastFrame = null; // force full redraw after connect
      device.backBuffer = null;
      device.frontBuffer = null;
      this.markConnected(true);
      this.emit("device_ready", { id: device.id });
    });

    portRef.on("message", (msg) => {
      if (device.devicePort !== portRef || this.devices.get(device.id) !== device) return;
      if (msg.address === `/${this.prefix}/grid/key`) {
        const [x, y, s] = msg.args.map((a) => a.value ?? a);
        const key = `${x},${y}`;
        if (s === 1) device.heldKeys.add(key);
        else if (s === 0) device.heldKeys.delete(key);
        this.emit("grid_key", { deviceId: device.id, x, y, s, cols: device.gridCols, rows: device.gridRows, supportsLevels: device.supportsLevels });
        // Let releases reach the sequencer in the same coordinates as their presses.
        if (s === 0) this.applyRotation(device);
      } else if (msg.address === "/sys/size") {
        const [w, h] = msg.args.map((a) => a.value ?? a);
        device.gridCols = w || device.gridCols;
        device.gridRows = h || device.gridRows;
        this.emit("log", `device size ${device.id} ${device.gridCols}x${device.gridRows}`);
      } else if (msg.address === "/sys/id") {
        this.emit("log", `device id ${msg.args.map((a) => a.value ?? a).join(" ")}`);
      } else if (msg.address === "/sys/info") {
        this.emit("log", `device info ${msg.args.map((a) => a.value ?? a).join(" ")}`);
      } else {
        this.emit("log", `osc ${msg.address} ${JSON.stringify(msg.args)}`);
      }
    });
    portRef.on("error", (e) => {
      if (!device.devicePort || device.devicePort !== portRef) return;
      if (e?.code === "EADDRINUSE" && retryCount < 4) {
        const nextPort = this.allocatePort(device.id, (device.listenPort || DEVICE_LISTEN_PORT) + 1);
        this.emit("log", `port ${device.listenPort} in use; retrying on ${nextPort}`);
        device.listenPort = nextPort;
        try {
          portRef.close();
        } catch (err) {
          // ignore close errors during retry path
        }
        this.openDevicePort(device, retryCount + 1);
        return;
      }
      this.emit("error", e);
      this.markDisconnected(device.id);
      this.devices.delete(device.id);
      this.scheduleRediscover();
    });
    portRef.on("close", () => {
      if (!device.devicePort || device.devicePort !== portRef) return;
      this.emit("log", "device connection closed");
      this.markDisconnected(device.id);
      this.devices.delete(device.id);
      this.scheduleRediscover();
    });
    portRef.open();
  }

  disconnectDevice(id) {
    if (!id) {
      // clear all devices if we don't know which one
      Array.from(this.devices.values()).forEach((dev) => {
        try {
          dev?.devicePort?.close();
        } catch (e) {
          this.emit("error", e);
        }
      });
      this.devices.clear();
      this.markDisconnected(true);
      this.scheduleRediscover();
      return;
    }
    const dev = this.devices.get(id);
    if (dev?.devicePort) {
      try {
        dev.devicePort.close();
      } catch (e) {
        this.emit("error", e);
      }
    }
    this.devices.delete(id);
    this.markDisconnected();
    this.scheduleRediscover();
  }

  markConnected(force = false) {
    const anyConnected = Array.from(this.devices.values()).some((d) => d?.devicePort);
    const summary = JSON.stringify(this.deviceList());
    const changed = force || this.connected !== anyConnected || summary !== this._lastDeviceSignature;
    this.connected = anyConnected;
    if (changed) {
      this._lastDeviceSignature = summary;
      this.emit("grid_status", { connected: this.connected, devices: JSON.parse(summary) });
    }
  }

  markDisconnected(force = false) {
    const anyConnected = Array.from(this.devices.values()).some((d) => d?.devicePort);
    const summary = JSON.stringify(this.deviceList());
    const changed = force || this.connected !== anyConnected || summary !== this._lastDeviceSignature;
    this.connected = anyConnected;
    if (changed) {
      this._lastDeviceSignature = summary;
      this.emit("grid_status", { connected: this.connected, devices: JSON.parse(summary) });
    }
    if (!anyConnected) {
      this.scheduleRediscover();
    }
  }

  deviceList() {
    return Array.from(this.devices.values()).map((d) => ({
      id: d.id,
      type: d.type,
      cols: d.gridCols,
      rows: d.gridRows,
      supportsLevels: d.supportsLevels,
      connected: !!d.devicePort
    }));
  }

  getDevices() {
    return this.deviceList();
  }

  getPrimaryDevice() {
    // Prefer any grid larger than 8x8; 8x8 (e.g., 40h/64) should never be primary
    const connected = Array.from(this.devices.values()).filter((d) => d.devicePort);
    const nonEight = connected
      .filter((d) => (d.gridCols > 8 || d.gridRows > 8))
      .sort((a, b) => (b.gridCols * b.gridRows) - (a.gridCols * a.gridRows));
    return nonEight[0] || null;
  }

  clearAll() {
    const devices = Array.from(this.devices.values());
    devices.forEach((dev) => {
      if (dev.devicePort) {
        dev.devicePort.send({ address: `/${this.prefix}/grid/led/all`, args: [{ type: "i", value: 0 }] });
        dev.backBuffer = null;
        dev.frontBuffer = null;
      }
    });
    if (devices.length) {
      return;
    }
    // Fallback: if we recently knew the device host/port, fire a one-shot clear.
    if (devices.length === 0) {
      const temp = new osc.UDPPort({
        localAddress: ANYHOST,
        localPort: 0,
        remoteAddress: LOCALHOST,
        remotePort: SERIALOSC_PORT,
        metadata: true
      });
      temp.on("ready", () => {
        temp.send({ address: `/${this.prefix}/grid/led/all`, args: [{ type: "i", value: 0 }] });
        setTimeout(() => temp.close(), 50);
      });
      temp.on("error", () => {
        try {
          temp.close();
        } catch (e) {
          // ignore close errors on temporary clear socket
        }
      });
      temp.open();
    }
  }

  updateFront(device, frame) {
    if (!device || !frame) return;
    const cols = device.gridCols || 16;
    const rows = device.gridRows || 8;
    const size = cols * rows;
    if (!device.frontBuffer || device.frontBuffer.length !== size) {
      device.frontBuffer = new Uint8Array(size);
    }
    for (let i = 0; i < size; i++) {
      const val = Math.max(0, Math.min(15, frame[i] || 0));
      device.frontBuffer[i] = device.supportsLevels ? val : (val > 0 ? 1 : 0);
    }
    device.lastFrame = device.frontBuffer.slice();
  }

  sendLEDFrame(frame, opts = {}) {
    const target = opts.deviceId ? this.devices.get(opts.deviceId) : this.getPrimaryDevice();
    if (!target || !target.devicePort || !frame) {
      this.scheduleRediscover();
      return;
    }
    this.updateFront(target, frame);
    const cols = target.gridCols || 16;
    const rows = target.gridRows || 8;
    const size = cols * rows;
    if (!target.supportsLevels) {
      this.sendBinaryFrame(target);
      return;
    }
    const clamped = target.frontBuffer;
    for (let y = 0; y < rows; y++) {
      const start = y * cols;
      const row = Array.from(clamped.slice(start, start + cols));
      target.devicePort.send({
        address: `/${this.prefix}/grid/led/level/row`,
        args: [{ type: "i", value: 0 }, { type: "i", value: y }, ...row.map((n) => ({ type: "i", value: n }))]
      });
    }
    target.backBuffer = new Uint8Array(clamped);
  }

  sendBinaryFrame(device) {
    if (!device?.devicePort || !device.frontBuffer) return;
    const cols = device.gridCols || 8;
    const rows = device.gridRows || 8;
    // send in 8-row blocks using bitmask map
    for (let by = 0; by < rows; by += 8) {
      const args = [
        { type: "i", value: 0 },
        { type: "i", value: by }
      ];
      for (let y = by; y < Math.min(by + 8, rows); y++) {
        let mask = 0;
        for (let x = 0; x < Math.min(cols, 8); x++) {
          const idx = y * cols + x;
          if (device.frontBuffer[idx]) mask |= (1 << x);
        }
        args.push({ type: "i", value: mask });
      }
      while (args.length < 10) {
        args.push({ type: "i", value: 0 });
      }
      device.devicePort.send({
        address: `/${this.prefix}/grid/led/map`,
        args
      });
    }
    device.backBuffer = new Uint8Array(device.frontBuffer);
  }

  sendLEDDiff(frame, opts = {}) {
    const targets = opts.deviceId ? [this.devices.get(opts.deviceId)].filter(Boolean) : [this.getPrimaryDevice()].filter(Boolean);
    if (!targets.length || !frame) {
      this.scheduleRediscover();
      return;
    }
    targets.forEach((target) => {
      if (!target || !target.devicePort) {
        this.scheduleRediscover();
        return;
      }
      this.updateFront(target, frame);
      const cols = target.gridCols || 16;
      const rows = target.gridRows || 8;
      const size = cols * rows;
      if (!target.supportsLevels) {
        this.sendBinaryFrame(target);
        return;
      }
      if (!target.backBuffer || target.backBuffer.length !== size) {
        this.sendLEDFrame(frame, { deviceId: target.id });
        return;
      }

      const front = target.frontBuffer;
      const back = target.backBuffer;
      let totalChanged = 0;
      const rowChanges = new Array(rows).fill(0);

      for (let y = 0; y < rows; y++) {
        const start = y * cols;
        let changed = 0;
        for (let x = 0; x < cols; x++) {
          const i = start + x;
          if (front[i] !== back[i]) changed++;
        }
        rowChanges[y] = changed;
        totalChanged += changed;
      }

      if (totalChanged === 0) return;

      // thresholds
      const fullThreshold = Math.floor(size * 0.5);
      const blockThreshold = 16; // 25% of 8x8

      // full redraw if dense
      if (totalChanged >= fullThreshold) {
        this.sendLEDFrame(front, { deviceId: target.id });
        return;
      }

      // try 8x8 map batching where dense
      const ops = [];
      const coveredRows = new Array(rows).fill(false);
      for (let by = 0; by < rows; by += 8) {
        for (let bx = 0; bx < cols; bx += 8) {
          let changed = 0;
          for (let y = by; y < Math.min(by + 8, rows); y++) {
            const start = y * cols;
            for (let x = bx; x < Math.min(bx + 8, cols); x++) {
              const i = start + x;
              if (front[i] !== back[i]) changed++;
            }
          }
          if (changed >= blockThreshold) {
            const block = [];
            for (let y = by; y < Math.min(by + 8, rows); y++) {
              const start = y * cols + bx;
              const len = Math.min(8, cols - bx);
              const slice = front.slice(start, start + len);
              block.push(...slice, ...new Array(8 - len).fill(0));
              coveredRows[y] = true;
            }
            ops.push({ type: "map", x: bx, y: by, block });
            for (let y = by; y < Math.min(by + 8, rows); y++) {
              const start = y * cols + bx;
              const len = Math.min(8, cols - bx);
              for (let x = 0; x < len; x++) {
                back[start + x] = front[start + x];
              }
            }
          }
        }
      }

      // rows for remaining changes (skip rows fully covered by maps)
      for (let y = 0; y < rows; y++) {
        if (coveredRows[y]) continue;
        if (rowChanges[y] > 0) {
          const start = y * cols;
          const row = Array.from(front.slice(start, start + cols));
          ops.push({ type: "row", y, row });
          for (let x = 0; x < cols; x++) {
            const i = start + x;
            back[i] = front[i];
          }
        }
      }

      // send ops with simple packet budget (one op per packet to stay under MTU safely)
      ops.forEach((op) => {
        if (op.type === "map") {
          target.devicePort.send({
            address: `/${this.prefix}/grid/led/level/map`,
            args: [
              { type: "i", value: op.x },
              { type: "i", value: op.y },
              ...op.block.map((n) => ({ type: "i", value: n }))
            ]
          });
        } else if (op.type === "row") {
          target.devicePort.send({
            address: `/${this.prefix}/grid/led/level/row`,
            args: [{ type: "i", value: 0 }, { type: "i", value: op.y }, ...op.row.map((n) => ({ type: "i", value: n }))]
          });
        }
      });
    });
  }

  fullResync(opts = {}) {
    const target = opts.deviceId ? this.devices.get(opts.deviceId) : this.getPrimaryDevice();
    if (!target) return;
    target.backBuffer = null;
    this.sendLEDFrame(target.frontBuffer || target.lastFrame || [], { deviceId: target.id });
  }

  scheduleRediscover() {
    const now = Date.now();
    if (this.rediscoverTimer || now - this.lastRediscover < 2000) return;
    this.lastRediscover = now;
    this.rediscoverTimer = setTimeout(() => {
      this.rediscoverTimer = null;
      if (!this.hasConnectedDevices() && this.serial) {
        this.emit("log", "Looking for grids..");
        this.serial.send({
          address: "/serialosc/list",
          args: [
            { type: "s", value: LOCALHOST },
            { type: "i", value: this.serial.options.localPort || DISCOVERY_LISTEN_PORT }
          ]
        });
      }
    }, 2000);
  }

  scrollText(text = "SEQ.") {
    const target = this.getPrimaryDevice();
    if (!target?.devicePort) return;
    // simple 5x7 font columns (LSB top)
    const font = {
      "S": [0x0E, 0x10, 0x0E, 0x01, 0x0E],
      "E": [0x1F, 0x10, 0x1E, 0x10, 0x1F],
      "Q": [0x0E, 0x11, 0x11, 0x0D, 0x1A],
      ".": [0x00, 0x00, 0x00, 0x00, 0x02],
      " ": [0x00, 0x00, 0x00, 0x00, 0x00]
    };
    const cols = [];
    for (const ch of text) {
      const glyph = font[ch] || font[" "];
      cols.push(...glyph, 0x00); // add spacer column
    }
    const width = target.gridCols || 16;
    const height = target.gridRows || 8;
    const frames = [];
    for (let offset = 0; offset <= Math.max(0, cols.length - width); offset++) {
      const frame = new Array(width * height).fill(0);
      for (let x = 0; x < width; x++) {
        const colVal = cols[offset + x] || 0;
        for (let y = 0; y < Math.min(7, height); y++) {
          const bitOn = (colVal >> y) & 1;
          if (bitOn) frame[y * width + x] = 10;
        }
      }
      frames.push(frame);
    }
    let idx = 0;
    const interval = setInterval(() => {
      if (!target.devicePort || idx >= frames.length) {
        clearInterval(interval);
        return;
      }
      this.sendLEDFrame(frames[idx], { deviceId: target.id });
      idx++;
    }, 120);
  }
}
// serialosc bridge: OSC/UDP client for monome devices, emitting grid events and sending LED frames.
