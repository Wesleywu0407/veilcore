"""STEP 1 -- add finger bones to the duelist armature and report their positions.

Purely additive: no vertex group is created and no weight is changed, so the
mesh deforms exactly as it did before. Saves a .blend for step 2.
"""
import bpy, json, sys, os
from mathutils import Vector

here = os.path.dirname(os.path.abspath(__file__))
if here not in sys.path:
    sys.path.insert(0, here)
from handrig import HandGeometry, DIGITS  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
SRC, BLEND, OUT = args[0], args[1], args[2]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mesh = bpy.data.objects["char1"]

geo = HandGeometry(arm, mesh)
plan = {h: geo.analyse(h) for h in ("RightHand", "LeftHand")}

to_armature = arm.matrix_world.inverted()

bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
eb = arm.data.edit_bones

created = []
for hand, info in plan.items():
    side = hand.replace("Hand", "")          # "Right" / "Left"
    for digit in info["digits"]:
        parent = eb[hand]
        for seg in range(3):
            name = f"{side}Hand{digit['name']}{seg + 1}"
            bone = eb.new(name)
            bone.head = to_armature @ digit["joints"][seg]
            bone.tail = to_armature @ digit["joints"][seg + 1]
            bone.parent = parent
            # Only the joints within one digit are welded together; the first
            # segment starts at the knuckle, which is nowhere near the hand
            # bone's tail (that tail is glTF filler and points 25 units away).
            bone.use_connect = seg > 0
            # Roll so the bone's local X is the bend axis: align Z to the palm
            # normal and the curl becomes a rotation about one axis.
            bone.align_roll(info["palm_normal"])
            created.append(name)
            parent = bone

bpy.ops.object.mode_set(mode="OBJECT")

report = {"created": created, "bone_count": len(arm.data.bones), "hands": {}}
for hand, info in plan.items():
    side = hand.replace("Hand", "")
    report["hands"][hand] = {
        "span": round(info["span"], 5),
        "palm_normal": [round(x, 4) for x in info["palm_normal"]],
        "digits": [
            {
                "name": d["name"],
                "verts": len(d["verts"]),
                "length": round(d["length"], 5),
                "bones": [
                    {
                        "name": f"{side}Hand{d['name']}{s + 1}",
                        "head": [round(x, 5) for x in (arm.matrix_world @ arm.data.bones[f"{side}Hand{d['name']}{s + 1}"].head_local)],
                        "tail": [round(x, 5) for x in (arm.matrix_world @ arm.data.bones[f"{side}Hand{d['name']}{s + 1}"].tail_local)],
                        "length_world": round((arm.matrix_world @ arm.data.bones[f"{side}Hand{d['name']}{s + 1}"].tail_local - arm.matrix_world @ arm.data.bones[f"{side}Hand{d['name']}{s + 1}"].head_local).length, 5),
                        "parent": arm.data.bones[f"{side}Hand{d['name']}{s + 1}"].parent.name,
                    }
                    for s in range(3)
                ],
            }
            for d in info["digits"]
        ],
    }

bpy.ops.wm.save_as_mainfile(filepath=BLEND)
with open(OUT, "w") as f:
    json.dump(report, f, indent=2)
print("CREATED", len(created), "bones; total", len(arm.data.bones))
print("WROTE", BLEND, OUT)
