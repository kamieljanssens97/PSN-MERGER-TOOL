'use strict';
const THREE = require('three');

/**
 * Average position (arithmetic mean) and orientation (quaternion average)
 * of a set of PSN trackers.
 * trackers: [{ pos:{x,y,z}, ori:{x,y,z} }] (ori in radians, Euler XYZ)
 * Returns { pos:{x,y,z}, ori:{x,y,z} }
 */
function mergeTrackers(trackers) {
  if (!trackers.length) return null;

  const posSum = { x: 0, y: 0, z: 0 };
  const quatSum = new THREE.Quaternion(0, 0, 0, 0);
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();

  for (const t of trackers) {
    posSum.x += t.pos.x;
    posSum.y += t.pos.y;
    posSum.z += t.pos.z;

    e.set(t.ori?.x || 0, t.ori?.y || 0, t.ori?.z || 0, 'XYZ');
    q.setFromEuler(e);
    // Hemisphere correction so antipodal quaternions don't cancel out.
    if (quatSum.x * q.x + quatSum.y * q.y + quatSum.z * q.z + quatSum.w * q.w < 0) {
      q.x *= -1;
      q.y *= -1;
      q.z *= -1;
      q.w *= -1;
    }
    quatSum.x += q.x;
    quatSum.y += q.y;
    quatSum.z += q.z;
    quatSum.w += q.w;
  }

  const n = trackers.length;
  const pos = { x: posSum.x / n, y: posSum.y / n, z: posSum.z / n };

  quatSum.normalize();
  const outEuler = new THREE.Euler().setFromQuaternion(quatSum, 'XYZ');
  // Preserve the PSN Z-axis sign: positive stays positive and negative stays negative.
  const ori = { x: outEuler.x, y: outEuler.y, z: outEuler.z };

  return { pos, ori };
}

/** Solve a 2x2 linear system; falls back to solving each axis independently if singular
 *  (e.g. only 2 trackers, where roll around the forward axis is genuinely undetermined). */
function solve2x2(A, B) {
  const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
  if (Math.abs(det) < 1e-9) {
    const a = Math.abs(A[0][0]) > 1e-9 ? B[0] / A[0][0] : 0;
    const b = Math.abs(A[1][1]) > 1e-9 ? B[1] / A[1][1] : 0;
    return [a, b];
  }
  return [(B[0] * A[1][1] - B[1] * A[0][1]) / det, (A[0][0] * B[1] - A[1][0] * B[0]) / det];
}

/**
 * Derive pitch/roll (tilt) from the spatial arrangement of tracker positions, instead of relying
 * on each tracker's own (often meaningless) orientation channel.
 *
 * The horizontal reference axes (forward = world +Z, right = world +X) are FIXED, not derived
 * from the trackers' footprint. An earlier version tried to auto-detect a "long axis" via PCA,
 * but that is fundamentally unstable for square/near-square layouts (a square has no unique long
 * axis - a few mm of height noise could flip the detected axis by 90deg). Height is then fit as a
 * plane y = a*x + b*z over those fixed axes, giving continuous, jump-free pitch/roll. This means
 * yaw is not auto-detected (there is no reliable way to do so from a symmetric footprint); use a
 * group's rotation offset (Y, degrees) to add a fixed heading if needed.
 * trackers: [{ id, pos:{x,y,z} }], needs >= 2 entries. Returns { x, y, z } radians.
 */
function computeTiltFromPositions(trackers) {
  if (trackers.length < 2) return { x: 0, y: 0, z: 0 };

  const pts = trackers.map((t) => t.pos);
  const n = pts.length;

  const centroid = { x: 0, y: 0, z: 0 };
  for (const p of pts) {
    centroid.x += p.x;
    centroid.y += p.y;
    centroid.z += p.z;
  }
  centroid.x /= n;
  centroid.y /= n;
  centroid.z /= n;

  // Fit height y = a*x + b*z (relative to centroid) over the fixed world X/Z axes.
  let sxx = 0, sxz = 0, szz = 0, sxy = 0, szy = 0;
  for (const p of pts) {
    const dx = p.x - centroid.x, dz = p.z - centroid.z, dy = p.y - centroid.y;
    sxx += dx * dx;
    sxz += dx * dz;
    szz += dz * dz;
    sxy += dx * dy;
    szy += dz * dy;
  }
  const [a, b] = solve2x2(
    [
      [sxx, sxz],
      [sxz, szz],
    ],
    [sxy, szy]
  );

  // Tangent vectors of the tilted surface y(x,z) = a*x + b*z give the true 3D forward/right/up.
  const tangentX = new THREE.Vector3(1, a, 0);
  const tangentZ = new THREE.Vector3(0, b, 1);
  let normal = new THREE.Vector3().crossVectors(tangentZ, tangentX);
  if (normal.lengthSq() < 1e-9) normal.set(0, 1, 0);
  if (normal.y < 0) normal.multiplyScalar(-1);
  normal.normalize();

  const forward = tangentZ.normalize();
  // Right-handed convention (like world axes X x Y = Z): right = up x forward, forward = right x up.
  const right = new THREE.Vector3().crossVectors(normal, forward).normalize();
  const trueForward = new THREE.Vector3().crossVectors(right, normal).normalize();

  // The merged output tracker must match the plane defined by the incoming corner trackers.
  // Use the fitted plane basis directly as the output orientation, rather than allowing a separate
  // quaternion average to drift away from the actual plane alignment.
  const m = new THREE.Matrix4().makeBasis(right, normal, trueForward);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  const outEuler = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return { x: outEuler.x, y: outEuler.y, z: outEuler.z };
}

module.exports = { mergeTrackers, computeTiltFromPositions };
