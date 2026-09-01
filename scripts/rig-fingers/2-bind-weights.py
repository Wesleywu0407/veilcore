"""STEP 2 -- bind the hand vertices to the new finger bones.

Deliberately NOT Blender's automatic weights: that would recompute the whole
body and throw away a rig whose arm, spine and head weights already work. Only
vertices that currently belong to LeftHand/RightHand are touched, and each one
keeps whatever share the forearm already had -- the hand's own share is what
gets redistributed among its finger bones.
"""
import bpy, json, sys, os
from mathutils import Vector

here = os.path.dirname(os.path.abspath(__file__))
if here not in sys.path:
    sys.path.insert(0, here)
from handrig import HandGeometry, JOINT_FRACTIONS  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
BLEND, SRC, OUT_BLEND, OUT = args[0], args[1], args[2], args[3]

# Inverse-distance sharpness. Higher pins a vertex to its nearest bone; lower
# smears it across the joint. 3 keeps knuckles soft without the fingers dragging
# their neighbours.
FALLOFF_POWER = 3.0
SMOOTH_PASSES = 6
SMOOTH_RATE = 0.5
EPS = 1e-5


def point_segment_distance(p, a, b):
    ab = b - a
    denom = ab.dot(ab)
    if denom < 1e-12:
        return (p - a).length
    t = max(0.0, min(1.0, (p - a).dot(ab) / denom))
    return (p - (a + ab * t)).length


# Recover the digit clusters from the original, then apply to the rigged blend.
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
arm0 = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mesh0 = bpy.data.objects["char1"]
geo = HandGeometry(arm0, mesh0)
plan = {h: geo.analyse(h) for h in ("RightHand", "LeftHand")}
rep = geo.rep

bpy.ops.wm.open_mainfile(filepath=BLEND)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mesh = bpy.data.objects["char1"]
M = mesh.matrix_world
world = [M @ v.co for v in mesh.data.vertices]

for name in [b.name for b in arm.data.bones if b.name not in [g.name for g in mesh.vertex_groups]]:
    mesh.vertex_groups.new(name=name)

stats = {}
for hand, info in plan.items():
    side = hand.replace("Hand", "")
    hand_group = mesh.vertex_groups[hand]

    # Every vertex the hand currently holds any share of, and how much.
    held = {}
    for v in mesh.data.vertices:
        for g in v.groups:
            if g.group == hand_group.index and g.weight > 0.0:
                held[v.index] = g.weight
                break

    # Which digit each vertex belongs to, from the clustering, plus the bone
    # segments of that digit in world space.
    owner = {}
    segments = {}
    for digit in info["digits"]:
        dname = digit["name"]
        segs = []
        for seg in range(3):
            bone = arm.data.bones[f"{side}Hand{dname}{seg + 1}"]
            segs.append((arm.matrix_world @ bone.head_local,
                         arm.matrix_world @ bone.tail_local))
        segments[dname] = (segs, digit["joints"][0])
        for i in digit["verts"]:
            owner[i] = dname

    target = {}
    for i, hand_share in held.items():
        dname = owner.get(i)
        if dname is None:
            # Palm and wrist keep the whole share -- but they still have to go
            # into `target`, or the smoothing below never sees the palm side of
            # the boundary and the cluster edge stays a hard step. That step is
            # a visible rip the moment the fingers close.
            target[i] = {hand: hand_share}
            continue
        segs, knuckle = segments[dname]
        p = world[i]
        # Four candidates: the three bones of this digit, and the hand itself
        # standing in for "still in the palm", measured at the knuckle.
        d = [point_segment_distance(p, a, b) for a, b in segs]
        d.append((p - knuckle).length)
        inv = [1.0 / ((x + EPS) ** FALLOFF_POWER) for x in d]
        total = sum(inv)
        shares = [x / total for x in inv]
        target[i] = {
            f"{side}Hand{dname}{s + 1}": hand_share * shares[s] for s in range(3)
        }
        target[i][hand] = hand_share * shares[3]

    # Smooth across welded neighbours so the cluster boundary is not a crease.
    neighbours = {}
    for e in mesh.data.edges:
        a, b = rep[e.vertices[0]], rep[e.vertices[1]]
        if a == b:
            continue
        neighbours.setdefault(a, set()).add(b)
        neighbours.setdefault(b, set()).add(a)
    by_node = {}
    for i in target:
        by_node.setdefault(rep[i], []).append(i)

    for _ in range(SMOOTH_PASSES):
        averaged = {}
        for node, members in by_node.items():
            acc, count = {}, 0
            for other in list(neighbours.get(node, ())) + [node]:
                if other not in by_node:
                    continue
                sample = target[by_node[other][0]]
                for k, w in sample.items():
                    acc[k] = acc.get(k, 0.0) + w
                count += 1
            if count:
                averaged[node] = {k: w / count for k, w in acc.items()}
        for node, avg in averaged.items():
            for i in by_node[node]:
                cur = target[i]
                blended = {}
                for k in set(cur) | set(avg):
                    blended[k] = cur.get(k, 0.0) * (1 - SMOOTH_RATE) + avg.get(k, 0.0) * SMOOTH_RATE
                # Smoothing must not change how much of the vertex the hand owns
                # in total; only how that share is split up.
                scale = held[i] / max(sum(blended.values()), 1e-9)
                target[i] = {k: w * scale for k, w in blended.items()}

    moved = 0.0
    for i, weights in target.items():
        for name, w in weights.items():
            mesh.vertex_groups[name].add([i], w, "REPLACE")
        moved += held[i] - weights.get(hand, 0.0)

    stats[hand] = {
        "vertices_held_by_hand": len(held),
        "vertices_reassigned": len(target),
        "weight_moved_to_fingers": round(moved, 2),
        "per_digit": {
            d["name"]: len([i for i in d["verts"] if i in target])
            for d in info["digits"]
        },
    }

bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND)
with open(OUT, "w") as f:
    json.dump(stats, f, indent=2)
print("WROTE", OUT_BLEND, OUT)
