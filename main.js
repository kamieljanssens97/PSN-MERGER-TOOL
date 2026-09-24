'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const psn = require('./psn/psn');
const { mergeTrackers, computeTiltFromPositions } = require('./psn/merge');

const DEFAULT_CONFIG = {
  systemName: 'PHLIPPO PRODUCTIONS PSN MERGER TOOL',
  inputAddress: '236.10.10.10',
  inputPort: 56565,
  inputInterface: '',
  outputAddress: '236.10.10.10',
  outputPort: 56565,
  outputInterface: '',
  sendRateHz: 30,
  trackerTimeoutMs: 3000,
  // Each group merges its own set of source tracker ids into one output PSN tracker.
  // rotationMode: 'tilt' derives orientation from the trackers' relative positions (best-fit
  // plane), 'average' uses the quaternion average of each source tracker's own orientation.
  groups: [
    {
      groupId: 'group-1',
      name: 'Object 1',
      outputTrackerId: 90,
      sourceTrackerIds: [],
      rotationMode: 'tilt',
      rotationOffsetDeg: { x: 0, y: 0, z: 0 },
    },
  ],
};

/** List IPv4 addresses of local network interfaces, for the UI's interface pickers. */
function listInterfaces() {
  const nets = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      const family = addr.family;
      const isIpv4 = family === 'IPv4' || family === 4 || family === '4';
      if (isIpv4 && addr.address) {
        result.push({ name, address: addr.address, internal: addr.internal });
      }
    }
  }
  if (!result.length) {
    result.push({ name: 'Localhost', address: '127.0.0.1', internal: true });
  }
  return result;
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'psn-merger-config.json');

function loadStoredConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      groups: Array.isArray(parsed.groups) && parsed.groups.length ? parsed.groups : DEFAULT_CONFIG.groups,
    };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfigToDisk() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    // ignore write failures so the app keeps running even without persistence
  }
}

let config = loadStoredConfig();
let inputSocket = null;
let outputSocket = null;
let sendTimer = null;
let frameId = 0;
let running = false;

// id -> { id, pos, ori, lastSeen }
const trackers = new Map();

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1700,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.maximize();
  if (!app.isPackaged) mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopPsn();
  if (process.platform !== 'darwin') app.quit();
});

function pruneStaleTrackers() {
  const now = Date.now();
  for (const [id, t] of trackers) {
    if (now - t.lastSeen > config.trackerTimeoutMs) trackers.delete(id);
  }
}

function startInputSocket() {
  inputSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  inputSocket.on('error', (err) => {
    sendToRenderer('psn:error', `Input socket error: ${err.message}`);
  });

  inputSocket.on('message', (msg) => {
    let packet;
    try {
      packet = psn.decodePacket(msg);
    } catch (e) {
      return; // ignore malformed packets
    }
    if (!packet || packet.type !== 'data') return;

    const now = Date.now();
    const outputIds = new Set(config.groups.map((g) => g.outputTrackerId));
    for (const t of packet.trackers) {
      // Ignore our own re-broadcast tracker ids to avoid feedback loops.
      if (outputIds.has(t.id)) continue;
      if (!t.pos) continue;
      trackers.set(t.id, {
        id: t.id,
        pos: t.pos,
        ori: t.ori || { x: 0, y: 0, z: 0 },
        lastSeen: now,
      });
    }
  });

  inputSocket.bind(config.inputPort, () => {
    try {
      inputSocket.addMembership(config.inputAddress, config.inputInterface || undefined);
      sendToRenderer(
        'psn:status',
        `Listening on ${config.inputAddress}:${config.inputPort}` +
          (config.inputInterface ? ` via ${config.inputInterface}` : '')
      );
    } catch (e) {
      sendToRenderer('psn:error', `Failed to join multicast group: ${e.message}`);
    }
  });
}

function startOutputSocket() {
  outputSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  outputSocket.bind(() => {
    outputSocket.setMulticastTTL(8);
    outputSocket.setBroadcast(true);
    if (config.outputInterface) {
      try {
        outputSocket.setMulticastInterface(config.outputInterface);
      } catch (e) {
        sendToRenderer('psn:error', `Failed to set output interface: ${e.message}`);
      }
    }
  });
}

function computeMergedGroups() {
  const results = [];
  for (const group of config.groups) {
    const active = group.sourceTrackerIds.map((id) => trackers.get(id)).filter(Boolean);
    if (!active.length) continue;
    const merged = mergeTrackers(active);
    const rawOri = group.rotationMode === 'average' ? merged.ori : computeTiltFromPositions(active);
    const offset = group.rotationOffsetDeg || { x: 0, y: 0, z: 0 };
    const ori = {
      x: -(rawOri.x + ((offset.x || 0) * Math.PI) / 180),
      y: rawOri.y + ((offset.y || 0) * Math.PI) / 180,
      z: -(rawOri.z + ((offset.z || 0) * Math.PI) / 180),
    };
    results.push({
      groupId: group.groupId,
      id: group.outputTrackerId,
      name: group.name,
      pos: merged.pos,
      ori,
      sourceCount: active.length,
    });
  }
  return results;
}

function tick() {
  pruneStaleTrackers();
  const mergedGroups = computeMergedGroups();

  if (mergedGroups.length && outputSocket) {
    const dataPacket = psn.encodeDataPacket(
      mergedGroups.map((m) => ({ id: m.id, pos: m.pos, ori: m.ori, status: 1 })),
      { frameId }
    );
    outputSocket.send(dataPacket, config.outputPort, config.outputAddress);

    if (frameId % 15 === 0) {
      const infoPacket = psn.encodeInfoPacket(
        config.systemName || 'PHLIPPO PRODUCTIONS PSN MERGER TOOL',
        mergedGroups.map((m) => ({ id: m.id, name: m.name })),
        { frameId }
      );
      outputSocket.send(infoPacket, config.outputPort, config.outputAddress);
    }
    frameId = (frameId + 1) & 0xff;
  }

  sendToRenderer('psn:trackers', {
    inputs: [...trackers.values()],
    merged: mergedGroups,
    groups: config.groups,
  });
}

function startPsn() {
  if (running) return;
  running = true;
  frameId = 0;
  startInputSocket();
  startOutputSocket();
  const intervalMs = Math.max(10, Math.round(1000 / config.sendRateHz));
  sendTimer = setInterval(tick, intervalMs);
}

function stopPsn() {
  running = false;
  if (sendTimer) clearInterval(sendTimer);
  sendTimer = null;
  if (inputSocket) {
    try { inputSocket.close(); } catch (e) { /* ignore */ }
    inputSocket = null;
  }
  if (outputSocket) {
    try { outputSocket.close(); } catch (e) { /* ignore */ }
    outputSocket = null;
  }
  trackers.clear();
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

ipcMain.handle('psn:start', (_evt, newConfig) => {
  config = { ...config, ...newConfig };
  saveConfigToDisk();
  stopPsn();
  startPsn();
  return { ok: true, config };
});

ipcMain.handle('psn:stop', () => {
  stopPsn();
  return { ok: true };
});

ipcMain.handle('psn:updateConfig', (_evt, newConfig) => {
  config = { ...config, ...newConfig };
  saveConfigToDisk();
  return { ok: true, config };
});

ipcMain.handle('psn:getConfig', () => config);

ipcMain.handle('psn:listInterfaces', () => listInterfaces());
