import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const viewport = document.getElementById('viewport');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e1f22);

const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 500);
camera.position.set(3, 3, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.GridHelper(10, 20, 0x555555, 0x333333));
scene.add(new THREE.AxesHelper(1));
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));

function makeAxisLabel(text, color, position) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  context.font = 'bold 34px Segoe UI, Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.position.copy(position);
  sprite.scale.set(0.7, 0.35, 1);
  scene.add(sprite);
}

function addAxisDirection(axis, direction, color) {
  const length = 4.5;
  const vector = axis.clone().multiplyScalar(direction);
  const axisName = axis === axisZ ? 'Z' : axis === axisX ? 'X' : 'Y';
  const displayedDirection = axis === axisZ ? -direction : direction;
  scene.add(new THREE.ArrowHelper(vector, new THREE.Vector3(0, 0, 0), length, color, 0.28, 0.16));
  makeAxisLabel(
    `${axisName}${displayedDirection > 0 ? '+' : '-'}`,
    color,
    vector.clone().multiplyScalar(length / 0.9)
  );
}

const axisX = new THREE.Vector3(1, 0, 0);
const axisY = new THREE.Vector3(0, 1, 0);
const axisZ = new THREE.Vector3(0, 0, 1);
addAxisDirection(axisX, 1, 0xff4444);
addAxisDirection(axisX, -1, 0xff4444);
addAxisDirection(axisY, 1, 0x44dd66);
addAxisDirection(axisY, -1, 0x44dd66);
addAxisDirection(axisZ, 1, 0x4488ff);
addAxisDirection(axisZ, -1, 0x4488ff);

function displayPosition(pos) {
  return new THREE.Vector3(pos.x, pos.y, -pos.z);
}

function displayEuler(ori) {
  const quaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(ori?.x || 0, ori?.y || 0, ori?.z || 0, 'XYZ')
  );
  quaternion.x *= -1;
  quaternion.y *= -1;
  return new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
}

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// --- Tracker visuals -------------------------------------------------

const inputColor = 0x3a9bdc; // unassigned trackers
const groupPalette = [0x39d98a, 0xffcc66, 0xff5555, 0xc77bff, 0x5bd0ff, 0xff9955, 0x9dff5b, 0xff5bd0];
const colorForGroupIndex = (i) => groupPalette[i % groupPalette.length];

/** id -> { group, sphere, axes } */
const trackerObjects = new Map();

function makeTrackerObject(color, size) {
  const group = new THREE.Group();
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(size, 16, 16),
    new THREE.MeshStandardMaterial({ color })
  );
  group.add(sphere);
  const axes = new THREE.AxesHelper(size * 3);
  group.add(axes);
  scene.add(group);
  return { group, sphere };
}

function getOrCreateTracker(id, color, size) {
  let obj = trackerObjects.get(id);
  if (!obj) {
    obj = makeTrackerObject(color, size);
    trackerObjects.set(id, obj);
  }
  return obj;
}

/** groupId -> { mesh: filled plane, edges: perimeter outline } visualizing the object's corners. */
const groupPlanes = new Map();

function getOrCreateGroupPlane(groupId, color) {
  let gp = groupPlanes.get(groupId);
  if (!gp) {
    const fillMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const edgeMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), fillMaterial);
    const edges = new THREE.LineLoop(new THREE.BufferGeometry(), edgeMaterial);
    scene.add(mesh);
    scene.add(edges);
    gp = { mesh, edges };
    groupPlanes.set(groupId, gp);
  }
  return gp;
}

/** Draws the flat "vlak" spanned by a group's corner trackers, oriented to match the computed rotation. */
function updateGroupPlane(groupId, color, center, ori, points) {
  const gp = getOrCreateGroupPlane(groupId, color);
  if (!center || points.length < 2) {
    gp.mesh.geometry.setFromPoints([]);
    gp.edges.geometry.setFromPoints([]);
    return;
  }

  const c = displayPosition(center);
  const displayRotation = displayEuler(ori);
  const q = new THREE.Quaternion().setFromEuler(displayRotation);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);

  // Order the corners around the centroid (in the plane's own basis) so the outline/fill isn't a bowtie.
  const sorted = points
    .map((p) => {
      const v = displayPosition(p);
      const rel = v.clone().sub(c);
      return { v, angle: Math.atan2(rel.dot(forward), rel.dot(right)) };
    })
    .sort((a, b) => a.angle - b.angle)
    .map((e) => e.v);

  gp.edges.geometry.setFromPoints(sorted);

  if (sorted.length >= 3) {
    const triVerts = [];
    for (let i = 0; i < sorted.length; i++) {
      triVerts.push(c, sorted[i], sorted[(i + 1) % sorted.length]);
    }
    gp.mesh.geometry.setFromPoints(triVerts);
    gp.mesh.geometry.computeVertexNormals();
  } else {
    gp.mesh.geometry.setFromPoints([]);
  }
}

function applyPose(obj, pos, ori) {
  const displayPos = displayPosition(pos);
  const displayRot = displayEuler(ori);
  obj.group.position.copy(displayPos);
  obj.group.rotation.copy(displayRot);
}

function updateScene(data) {
  const seenIds = new Set();
  const groupIndexByTrackerId = new Map();
  groups.forEach((g, i) => {
    for (const id of g.sourceTrackerIds) groupIndexByTrackerId.set(id, i);
  });

  for (const t of data.inputs) {
    seenIds.add('in-' + t.id);
    const groupIndex = groupIndexByTrackerId.get(t.id);
    const color = groupIndex === undefined ? inputColor : colorForGroupIndex(groupIndex);
    const obj = getOrCreateTracker('in-' + t.id, color, 0.08);
    obj.sphere.material.color.set(color);
    applyPose(obj, t.pos, t.ori);
  }

  data.merged.forEach((m, i) => {
    const key = 'merged-' + m.groupId;
    seenIds.add(key);
    const obj = getOrCreateTracker(key, colorForGroupIndex(i), 0.14);
    const visualMergedOri = { x: -(m.ori?.x || 0), y: m.ori?.y || 0, z: -(m.ori?.z || 0) };
    applyPose(obj, m.pos, visualMergedOri);

    const groupDef = groups.find((g) => g.groupId === m.groupId);
    const points = (groupDef ? data.inputs.filter((t) => groupDef.sourceTrackerIds.includes(t.id)) : []).map(
      (t) => t.pos
    );
    updateGroupPlane(m.groupId, colorForGroupIndex(i), m.pos, m.ori, points);
  });

  for (const [groupId, gp] of groupPlanes) {
    if (!data.merged.some((m) => m.groupId === groupId)) {
      gp.mesh.geometry.setFromPoints([]);
      gp.edges.geometry.setFromPoints([]);
    }
  }

  for (const [id, obj] of trackerObjects) {
    if (!seenIds.has(id)) {
      scene.remove(obj.group);
      trackerObjects.delete(id);
    }
  }
}

// --- UI ----------------------------------------------------------------

const el = (id) => document.getElementById(id);
const startBtn = el('startBtn');
const stopBtn = el('stopBtn');
const statusEl = el('status');
const trackerListEl = el('trackerList');
const groupsListEl = el('groupsList');
const addGroupBtn = el('addGroupBtn');
const mergedInfoEl = el('mergedInfo');

let groups = [
  {
    groupId: 'group-1',
    name: 'Object 1',
    outputTrackerId: 90,
    sourceTrackerIds: [],
    rotationMode: 'tilt',
    rotationOffsetDeg: { x: 0, y: 0, z: 0 },
  },
];
let latestInputs = [];
let groupSeq = 2;

function currentConfig() {
  return {
    systemName: el('systemName').value,
    inputAddress: el('inputAddress').value,
    inputPort: Number(el('inputPort').value),
    inputInterface: el('inputInterface').value,
    outputAddress: el('outputAddress').value,
    outputPort: Number(el('outputPort').value),
    outputInterface: el('outputInterface').value,
    sendRateHz: Number(el('sendRateHz').value),
    groups,
  };
}

function pushGroupsUpdate() {
  window.psnApi.updateConfig({ groups });
  renderGroupsList();
  renderTrackerList(latestInputs);
}

function renderGroupsList() {
  groupsListEl.innerHTML = '';
  groups.forEach((g, i) => {
    const card = document.createElement('div');
    card.className = 'group-card';

    const topRow = document.createElement('div');
    topRow.className = 'group-row';
    const bottomRow = document.createElement('div');
    bottomRow.className = 'group-row';

    const swatch = document.createElement('div');
    swatch.className = 'swatch';
    swatch.style.background = '#' + colorForGroupIndex(i).toString(16).padStart(6, '0');

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = g.name;
    nameInput.addEventListener('change', () => {
      g.name = nameInput.value;
      pushGroupsUpdate();
    });

    const idInput = document.createElement('input');
    idInput.type = 'number';
    idInput.title = 'PSN tracker ID';
    idInput.value = g.outputTrackerId;
    idInput.addEventListener('change', () => {
      g.outputTrackerId = Number(idInput.value);
      pushGroupsUpdate();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      groups = groups.filter((x) => x.groupId !== g.groupId);
      pushGroupsUpdate();
    });

    topRow.append(swatch, nameInput, idInput, removeBtn);

    const modeSelect = document.createElement('select');
    modeSelect.title = 'Rotatie-bron';
    modeSelect.innerHTML =
      '<option value="tilt">Positie-tilt (vlak)</option><option value="average">Bron-rotatie</option>';
    modeSelect.value = g.rotationMode || 'tilt';
    modeSelect.addEventListener('change', () => {
      g.rotationMode = modeSelect.value;
      pushGroupsUpdate();
    });

    if (!g.rotationOffsetDeg) g.rotationOffsetDeg = { x: 0, y: 0, z: 0 };
    bottomRow.appendChild(modeSelect);
    for (const axis of ['x', 'y', 'z']) {
      const label = document.createElement('span');
      label.className = 'offset-label';
      label.textContent = axis.toUpperCase() + '°';

      const input = document.createElement('input');
      input.type = 'number';
      input.step = '1';
      input.title = `Rotatie-offset ${axis.toUpperCase()} (graden) — gebruik dit om een afwijking recht te trekken`;
      input.value = g.rotationOffsetDeg[axis];
      input.addEventListener('change', () => {
        g.rotationOffsetDeg[axis] = Number(input.value);
        pushGroupsUpdate();
      });

      bottomRow.append(label, input);
    }

    card.append(topRow, bottomRow);
    groupsListEl.appendChild(card);
  });
}

addGroupBtn.addEventListener('click', () => {
  const nextId = Math.max(89, ...groups.map((g) => g.outputTrackerId)) + 1;
  groups.push({
    groupId: 'group-' + groupSeq++,
    name: `Object ${groups.length + 1}`,
    outputTrackerId: nextId,
    sourceTrackerIds: [],
    rotationMode: 'tilt',
    rotationOffsetDeg: { x: 0, y: 0, z: 0 },
  });
  pushGroupsUpdate();
});

async function populateInterfaces() {
  const interfaces = await window.psnApi.listInterfaces();
  for (const selectId of ['inputInterface', 'outputInterface']) {
    const select = el(selectId);
    for (const iface of interfaces) {
      const option = document.createElement('option');
      option.value = iface.address;
      option.textContent = `${iface.name} (${iface.address})${iface.internal ? ' [loopback]' : ''}`;
      select.appendChild(option);
    }
  }
}

// Loads the config saved from a previous session so tracker/group assignments survive a restart.
async function loadSavedConfig() {
  const saved = await window.psnApi.getConfig();
  if (!saved) return;
  el('systemName').value = saved.systemName ?? el('systemName').value;
  el('inputAddress').value = saved.inputAddress ?? el('inputAddress').value;
  el('inputPort').value = saved.inputPort ?? el('inputPort').value;
  el('inputInterface').value = saved.inputInterface ?? '';
  el('outputAddress').value = saved.outputAddress ?? el('outputAddress').value;
  el('outputPort').value = saved.outputPort ?? el('outputPort').value;
  el('outputInterface').value = saved.outputInterface ?? '';
  el('sendRateHz').value = saved.sendRateHz ?? el('sendRateHz').value;
  if (Array.isArray(saved.groups) && saved.groups.length) {
    groups = saved.groups;
    const maxSeq = Math.max(0, ...groups.map((g) => Number(String(g.groupId).replace('group-', '')) || 0));
    groupSeq = maxSeq + 1;
  }
}

async function doStart() {
  await window.psnApi.start(currentConfig());
  startBtn.disabled = true;
  stopBtn.disabled = false;
  statusEl.textContent = 'Gestart...';
}

(async () => {
  await populateInterfaces();
  await loadSavedConfig();
  renderGroupsList();
  await doStart(); // listen immediately so trackers show up without a manual click
})();

startBtn.addEventListener('click', doStart);

stopBtn.addEventListener('click', async () => {
  await window.psnApi.stop();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusEl.textContent = 'Gestopt';
});

window.psnApi.onStatus((msg) => {
  statusEl.textContent = msg;
});
window.psnApi.onError((msg) => {
  statusEl.textContent = 'Fout: ' + msg;
  statusEl.style.color = '#f66';
});

function groupOfTracker(trackerId) {
  return groups.find((g) => g.sourceTrackerIds.includes(trackerId));
}

function assignTrackerToGroup(trackerId, groupId) {
  for (const g of groups) {
    g.sourceTrackerIds = g.sourceTrackerIds.filter((id) => id !== trackerId);
  }
  if (groupId) {
    const target = groups.find((g) => g.groupId === groupId);
    if (target) target.sourceTrackerIds.push(trackerId);
  }
  pushGroupsUpdate();
}

function renderTrackerList(inputs) {
  latestInputs = [...inputs].sort((a, b) => Number(a.id) - Number(b.id));
  trackerListEl.innerHTML = '';
  for (const t of latestInputs) {
    const row = document.createElement('div');
    row.className = 'tracker-row';

    const currentGroup = groupOfTracker(t.id);
    const groupIndex = currentGroup ? groups.indexOf(currentGroup) : -1;
    const color = groupIndex === -1 ? 0x3a9bdc : colorForGroupIndex(groupIndex);

    const swatch = document.createElement('div');
    swatch.className = 'swatch';
    swatch.style.background = '#' + color.toString(16).padStart(6, '0');

    const label = document.createElement('span');
    label.textContent = `Tracker ${t.id}`;

    const select = document.createElement('select');
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = '-- geen --';
    select.appendChild(noneOption);
    for (const g of groups) {
      const option = document.createElement('option');
      option.value = g.groupId;
      option.textContent = g.name;
      if (currentGroup && currentGroup.groupId === g.groupId) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => assignTrackerToGroup(t.id, select.value));

    const coords = document.createElement('span');
    coords.className = 'coords';
    coords.textContent = `x:${t.pos.x.toFixed(2)} y:${t.pos.y.toFixed(2)} z:${t.pos.z.toFixed(2)}`;

    row.append(swatch, label, select, coords);
    trackerListEl.appendChild(row);
  }
}

function renderMergedInfo(mergedList) {
  if (!mergedList.length) {
    mergedInfoEl.textContent = '-';
    return;
  }
  const rad2deg = (r) => (r * 180 / Math.PI).toFixed(1);
  mergedInfoEl.textContent = mergedList
    .map(
      (m) =>
        `id: ${m.id} (${m.name})\n` +
        `bronnen: ${m.sourceCount}\n` +
        `pos  x:${m.pos.x.toFixed(3)} y:${m.pos.y.toFixed(3)} z:${m.pos.z.toFixed(3)}\n` +
        `rot  x:${rad2deg(m.ori.x)} y:${rad2deg(m.ori.y)} z:${rad2deg(m.ori.z)} (deg)`
    )
    .join('\n\n');
}

window.psnApi.onTrackers((data) => {
  statusEl.style.color = '#8f8';
  // Note: `groups` is the local source of truth (already pushed to main); don't overwrite it
  // with the periodically echoed config, or in-progress edits (e.g. typing a name) get lost.
  renderTrackerList(data.inputs);
  renderMergedInfo(data.merged);
  updateScene(data);
});

