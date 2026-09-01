"""Is every finger joint actually inside the digit it belongs to?

Two measurements per joint:
  * distance to the nearest vertex of its own digit cluster
  * whether the joint is inside the mesh at all, by ray casting

Eyeballing a translucent render cannot answer either.
"""
import bpy, json, sys, os
from mathutils import Vector

here = os.path.dirname(os.path.abspath(__file__))
if here not in sys.path:
    sys.path.insert(0, here)
from handrig import HandGeometry  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
BLEND, SRC, OUT = args[0], args[1], args[2]

# Analyse the ORIGINAL to recover the clusters, then measure the bones in the
# rigged blend. Same geometry either way, so the clusters line up.
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
arm0 = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mesh0 = bpy.data.objects["char1"]
geo = HandGeometry(arm0, mesh0)
clusters = {h: geo.analyse(h) for h in ("RightHand", "LeftHand")}
world = geo.world

bpy.ops.wm.open_mainfile(filepath=BLEND)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mesh = bpy.data.objects["char1"]
depsgraph = bpy.context.evaluated_depsgraph_get()
mesh_eval = mesh.evaluated_get(depsgraph)
to_local = mesh.matrix_world.inverted()


def inside(point):
    """Even/odd ray crossings: an odd count means the point is enclosed."""
    origin = to_local @ point
    hits = 0
    d = Vector((0.5773, 0.5773, 0.5773))
    p = origin.copy()
    for _ in range(24):
        ok, loc, nrm, idx = mesh_eval.ray_cast(p, d)
        if not ok:
            break
        hits += 1
        p = loc + d * 1e-5
    return hits % 2 == 1


report = {}
for hand, info in clusters.items():
    side = hand.replace("Hand", "")
    rows = []
    for digit in info["digits"]:
        cloud = [world[i] for i in digit["verts"]]
        for seg in range(3):
            name = f"{side}Hand{digit['name']}{seg + 1}"
            bone = arm.data.bones[name]
            for end, label in ((arm.matrix_world @ bone.head_local, "head"),
                               (arm.matrix_world @ bone.tail_local, "tail")):
                near = min((end - c).length for c in cloud)
                rows.append({
                    "bone": name, "end": label,
                    "nearest_own_vertex": round(near, 5),
                    "inside_mesh": inside(end),
                })
    report[hand] = rows

with open(OUT, "w") as f:
    json.dump(report, f, indent=2)
print("WROTE", OUT)
