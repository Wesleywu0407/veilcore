"""Shared analysis for adding finger bones to the sealed porcelain duelist.

Everything here is derived from the mesh itself rather than from a hand
template, so it survives the character being regenerated at a different scale.

Two facts about this particular asset drive the whole approach:

  * The glTF is a split-vertex soup -- 25,285 vertices for 24,904 triangles --
    so the mesh's own edges do not connect what visually looks connected.
    Everything below welds by rounded position first.

  * The four fingers share one continuous surface below the top ~20% of the
    hand; only the thumb is a shell of its own. So the fingers are separated by
    position across the knuckles, not by connectivity.
"""
from mathutils import Vector

QUANT = 100000.0          # 1e-5 world units: merges true duplicates only
PADDLE_CUT = 0.50         # up the hand, where thumb and fingers both still exist
THUMB_CUT = 0.22          # lower, so the thumb keeps its full length
DIGITS = ("Index", "Middle", "Ring", "Pinky")

# Human digit proportions, roughly 45/30/25 of the finger. Close enough for a
# curl seen at duelling distance, and the alternative is three more guesses.
JOINT_FRACTIONS = (0.0, 0.45, 0.75, 1.0)

# A thumb runs about 60% of the middle finger. Used only as a ceiling on the
# search below, never as the answer -- the geometry decides where it stops.
THUMB_MAX = 0.75


def principal_axis(points, centre):
    """Largest-eigenvalue direction of the covariance, by power iteration."""
    cov = [[0.0] * 3 for _ in range(3)]
    for p in points:
        d = p - centre
        for i in range(3):
            for j in range(3):
                cov[i][j] += d[i] * d[j]
    v = Vector((1.0, 1.0, 1.0)).normalized()
    for _ in range(80):
        nv = Vector((sum(cov[i][j] * v[j] for j in range(3)) for i in range(3)))
        if nv.length < 1e-12:
            break
        v = nv.normalized()
    return v


def kmeans_1d(values, k, iters=80):
    lo, hi = min(values), max(values)
    cents = [lo + (hi - lo) * (i + 0.5) / k for i in range(k)]
    for _ in range(iters):
        buckets = [[] for _ in range(k)]
        for v in values:
            buckets[min(range(k), key=lambda c: abs(v - cents[c]))].append(v)
        moved = 0.0
        for c in range(k):
            if buckets[c]:
                nc = sum(buckets[c]) / len(buckets[c])
                moved = max(moved, abs(nc - cents[c]))
                cents[c] = nc
        if moved < 1e-9:
            break
    return sorted(cents)


class HandGeometry:
    def __init__(self, arm, mesh):
        self.arm = arm
        self.mesh = mesh
        M = mesh.matrix_world
        self.world = [M @ v.co for v in mesh.data.vertices]
        weld = {}
        for i, co in enumerate(self.world):
            weld.setdefault(
                (round(co.x * QUANT), round(co.y * QUANT), round(co.z * QUANT)), []
            ).append(i)
        self.rep = {}
        for group in weld.values():
            for i in group:
                self.rep[i] = group[0]
        self.edges = [(self.rep[e.vertices[0]], self.rep[e.vertices[1]])
                      for e in mesh.data.edges]
        self._to_local = mesh.matrix_world.inverted()

    def inside(self, point):
        """Even/odd ray crossings: an odd count means the point is enclosed."""
        import mathutils
        p = self._to_local @ point
        d = mathutils.Vector((0.5773, 0.5773, 0.5773))
        hits = 0
        for _ in range(24):
            ok, loc, _n, _i = self.mesh.ray_cast(p, d)
            if not ok:
                break
            hits += 1
            p = loc + d * 1e-5
        return hits % 2 == 1

    def _components(self, nodes):
        adj = {n: set() for n in nodes}
        for a, b in self.edges:
            if a in nodes and b in nodes and a != b:
                adj[a].add(b)
                adj[b].add(a)
        seen, out = set(), []
        for start in nodes:
            if start in seen:
                continue
            stack, comp = [start], []
            seen.add(start)
            while stack:
                n = stack.pop()
                comp.append(n)
                for m in adj[n]:
                    if m not in seen:
                        seen.add(m)
                        stack.append(m)
            out.append(comp)
        out.sort(key=len, reverse=True)
        return out

    def analyse(self, hand):
        mesh, arm = self.mesh, self.arm
        gi = mesh.vertex_groups[hand].index
        owned = {v.index for v in mesh.data.vertices
                 for g in v.groups if g.group == gi and g.weight >= 0.5}
        wrist = arm.matrix_world @ arm.data.bones[hand].head_local
        pts = {i: self.world[i] for i in owned}
        centre = sum(pts.values(), Vector()) / len(pts)
        axis = principal_axis(list(pts.values()), centre)
        if (centre - wrist).dot(axis) < 0:
            axis = -axis
        proj = {i: (p - wrist).dot(axis) for i, p in pts.items()}
        lo, hi = min(proj.values()), max(proj.values())
        span = hi - lo

        def zone_at(cut):
            return {i for i in owned if (proj[i] - lo) / span > cut}

        members_of = {}
        zone = zone_at(PADDLE_CUT)
        for i in zone:
            members_of.setdefault(self.rep[i], []).append(i)
        comps = self._components(set(members_of))
        paddle = [i for n in comps[0] for i in members_of[n]]
        thumb_hi = [i for n in comps[1] for i in members_of[n]] if len(comps) > 1 else []

        # The thumb again, from lower down, so its base is included. Picked by
        # proximity to the thumb found above rather than by size, because low
        # on the hand the palm is the biggest shell.
        thumb = thumb_hi
        if thumb_hi:
            seed = sum((pts[i] for i in thumb_hi), Vector()) / len(thumb_hi)
            low_members = {}
            for i in zone_at(THUMB_CUT):
                low_members.setdefault(self.rep[i], []).append(i)
            best, best_d = None, 1e9
            for comp in self._components(set(low_members)):
                verts = [i for n in comp for i in low_members[n]]
                if len(verts) < 20:
                    continue
                c = sum((pts[i] for i in verts), Vector()) / len(verts)
                d = (c - seed).length
                if d < best_d:
                    best, best_d = verts, d
            # Only accept it if it really is the thumb and not the whole palm.
            if best and len(best) < len(paddle):
                thumb = best

        pv = [pts[i] for i in paddle]
        pc = sum(pv, Vector()) / len(pv)
        flat = [(p - pc) - axis * (p - pc).dot(axis) for p in pv]
        across = principal_axis(flat, Vector((0, 0, 0)))
        coords = [(p - pc).dot(across) for p in pv]
        cents = kmeans_1d(coords, 4)
        groups = {c: [] for c in range(4)}
        for i, co in zip(paddle, coords):
            groups[min(range(4), key=lambda c: abs(co - cents[c]))].append(i)

        # Order Index..Pinky by walking away from the thumb.
        if thumb:
            tc = sum((pts[i] for i in thumb), Vector()) / len(thumb)
            thumb_side = (tc - pc).dot(across)
        else:
            thumb_side = -1.0
        order = sorted(range(4), key=lambda c: cents[c],
                       reverse=(thumb_side > 0))

        palm_normal = axis.cross(across).normalized()

        digits = []
        for name, c in zip(DIGITS, order):
            digits.append((name, groups[c]))
        if thumb:
            digits.append(("Thumb", thumb))   # last: the cap below reads the fingers
        middle_length = 0.0

        out = []
        for name, members in digits:
            dv = [pts[i] for i in members]
            dc = sum(dv, Vector()) / len(dv)
            # Base-to-tip, not PCA. PCA needs an elongated cloud to be
            # meaningful, and the thumb's is a stubby blob -- its principal axis
            # came out pointing sideways out of the hand, and the chain was
            # built into thin air. Averaging the nearest and furthest fifths
            # keeps this robust to a single stray vertex, which is the one thing
            # a raw min/max would not survive.
            by_reach = sorted(dv, key=lambda p: (p - wrist).length)
            take = max(3, len(by_reach) // 5)
            near = sum(by_reach[:take], Vector()) / take
            far = sum(by_reach[-take:], Vector()) / take
            daxis = (far - near)
            daxis = daxis.normalized() if daxis.length > 1e-9 else principal_axis(dv, dc)
            # Measured from the digit's OWN centroid, not from the wrist. A
            # knuckle sits off to the side of the wrist, so anchoring the chain
            # at the wrist fans all five digits out of one point and the bones
            # end up beside the fingers instead of inside them.
            dproj = [(p - dc).dot(daxis) for p in dv]
            base_t, tip_t = min(dproj), max(dproj)

            if name == "Thumb":
                # Only the part of the thumb clear of the palm is its own shell,
                # so the cluster stops at the web and the chain came out a third
                # of the length it should be. Walk the base back down the thumb's
                # own axis while the point is still inside the mesh: that finds
                # the root in the palm from the geometry instead of assuming a
                # ratio. Capped against the middle finger so a thumb that never
                # exits cannot bore all the way through the hand.
                step = (tip_t - base_t) * 0.06
                cap = base_t - THUMB_MAX * middle_length
                t = base_t
                while t - step > cap and self.inside(dc + daxis * (t - step)):
                    t -= step
                base_t = t

            length = tip_t - base_t
            joints = [dc + daxis * (base_t + length * f) for f in JOINT_FRACTIONS]
            out.append({
                "name": name,
                "verts": members,
                "axis": daxis,
                "length": length,
                "joints": joints,
                "centroid": dc,
            })
            if name == "Middle":
                middle_length = length
        return {"wrist": wrist, "axis": axis, "across": across,
                "palm_normal": palm_normal, "span": span, "digits": out}
