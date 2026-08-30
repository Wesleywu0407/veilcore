// Pure ray intersections for arrows. Kept free of Three.js so the exact combat
// shapes can be tested without a renderer, DOM, or camera.

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

export function raySphereDistance(origin, direction, centre, radius) {
  const rel = {
    x: origin.x - centre.x,
    y: origin.y - centre.y,
    z: origin.z - centre.z,
  };
  const b = dot(rel, direction);
  const c = dot(rel, rel) - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const near = -b - root;
  const far = -b + root;
  return near >= 0 ? near : far >= 0 ? far : null;
}

/** A vertical capsule: a cylinder from minY to maxY with a sphere on each end. */
export function rayVerticalCapsuleDistance(origin, direction, x, z, minY, maxY, radius) {
  const ox = origin.x - x;
  const oz = origin.z - z;
  const a = direction.x * direction.x + direction.z * direction.z;
  const b = 2 * (ox * direction.x + oz * direction.z);
  const c = ox * ox + oz * oz - radius * radius;
  let best = Infinity;

  if (a > 1e-9) {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
        const y = origin.y + direction.y * t;
        if (t >= 0 && y >= minY && y <= maxY) best = Math.min(best, t);
      }
    }
  }

  for (const y of [minY, maxY]) {
    const t = raySphereDistance(origin, direction, { x, y, z }, radius);
    if (t !== null) best = Math.min(best, t);
  }
  return Number.isFinite(best) ? best : null;
}
