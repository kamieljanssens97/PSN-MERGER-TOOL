# PSN Merger

**PSN Merger** is a Windows desktop tool (Electron + Three.js) built for **PHLIPPO PRODUCTIONS**
that receives multiple [PosiStageNet (PSN)](https://www.posistage.net/) trackers over multicast
UDP, merges them into one or more combined "objects", and re-broadcasts the result as new PSN
trackers — with a live 3D preview of everything happening on the network.

It's typically used when several individual PSN position trackers (e.g. on a moving truss, LED
wall, or set piece) need to be treated as a single rigid object by downstream show-control /
media-server software, instead of tracking each point separately.

## What it does

- **Listens** for PSN v2 data packets on a configurable multicast address/port (default
  `236.10.10.10:56565`) and lists every tracker ID it detects on the network.
- **Groups**: you define any number of named "objects" (groups), each with its own output
  tracker ID. Every detected tracker can be assigned to a group via a dropdown.
- **Merges** each group's assigned trackers into a single tracker:
  - Position is the linear average of the source trackers' positions.
  - Orientation is computed either as:
    - `tilt` (default) — derived from the geometric layout of the group's trackers (a best-fit
      plane through their positions), giving stable pitch/roll even if the individual trackers'
      own orientation data is noisy or absent. A manual yaw/pitch/roll offset (in degrees) can be
      added per group to correct for the receiving software's coordinate convention.
    - `average` — a quaternion average of each source tracker's own orientation channel.
- **Re-broadcasts** the merged tracker(s) as a new PSN data/info packet on a configurable
  multicast address/port, so any PSN-compatible receiver downstream sees one clean tracker per
  object.
- **Live 3D view**: every detected tracker, every merged/output tracker, and a visual outline of
  each group's footprint ("vlak") are rendered in real time using Three.js, color-coded per group.
- **Persists your setup**: network settings, object/group definitions, and which tracker is
  assigned to which group are automatically saved to disk and restored the next time the app is
  started — no manual save/load step needed.

## Requirements

- [Node.js](https://nodejs.org/) (LTS, v18+) — only needed for development/building from source.
  End users running a packaged `.exe` don't need Node.js installed.

## Development

```powershell
npm install
npm start
```

`npm start` bundles the renderer (Three.js + UI code) with esbuild and then launches the Electron
app with devtools open.

## Building a distributable

```powershell
npm run build
```

This produces, in `dist/`:

- `PHLIPPO PRODUCTIONS PSN MERGER TOOL-<version>-portable.exe` — a single portable executable,
  no installation required.
- `PHLIPPO PRODUCTIONS PSN MERGER TOOL-<version>-Setup.exe` — an NSIS installer.

## Usage

1. Under **Input**, set the multicast address/port your PSN source(s) broadcast on (default
   `236.10.10.10:56565`) and optionally pick a specific network interface.
2. Under **Output**, set the address/port the merged tracker(s) should be sent to, and the system
   name announced in the PSN info packet.
3. Under **Objecten (groepen)**, create one or more objects. Each object has a name, an output
   tracker ID, a rotation mode, and an optional manual rotation offset.
4. Under **Gedetecteerde trackers**, assign each incoming tracker to an object using its dropdown.
5. The app starts listening automatically on launch. Incoming trackers, merged output trackers,
   and each group's footprint are visible live in the 3D view.
6. Use **Stop**/**Start** to restart the network sockets (e.g. after changing addresses/ports).

## Protocol implementation

- `psn/psn.js` — encoder/decoder for the PSN v2 chunk format (`PSN_DATA_PACKET` /
  `PSN_INFO_PACKET`: tracker position, orientation, and status).
- `psn/merge.js` — position averaging, quaternion-based orientation averaging, and the
  geometry-based "tilt" orientation algorithm (best-fit plane / PCA over tracker positions).

## Project structure

- `main.js` — Electron main process: multicast sockets, PSN encode/decode, merge logic,
  config persistence.
- `preload.js` — secure IPC bridge (contextIsolation) between main and renderer.
- `psn/psn.js` — PSN packet encoder/decoder.
- `psn/merge.js` — position/rotation merging and tilt computation.
- `renderer/` — UI and Three.js 3D visualization (bundled with esbuild into
  `renderer/dist/renderer.bundle.js`, which is git-ignored/generated).

