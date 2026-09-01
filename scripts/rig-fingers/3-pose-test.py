"""STEP 3 -- pose the fingers and render, to see whether the weights hold up.

Curl is a rotation about each bone's local X: step 1 set the roll so that Z runs
along the palm normal, which puts X across the knuckles. If the rolls were wrong
the fingers will splay sideways instead of closing, and that is exactly what
this is meant to catch.
"""
import bpy, sys, os, math
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
BLEND, OUTDIR = args[0], args[1]

DIGITS = ("Thumb", "Index", "Middle", "Ring", "Pinky")
# Knuckle bends most, last joint least -- a real fist, not a uniform arc.
CURL = (0.9, 0.75, 0.6)

bpy.ops.wm.open_mainfile(filepath=BLEND)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mesh = bpy.data.objects["char1"]

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 900
scene.render.resolution_y = 700
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new("w")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.05, 0.06, 0.08, 1)
scene.world.node_tree.nodes["Background"].inputs[1].default_value = 1.0

# Flat clay, so the silhouette is what gets judged and not the porcelain texture.
clay = bpy.data.materials.new("clay")
clay.use_nodes = True
bsdf = clay.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.85, 0.83, 0.78, 1)
bsdf.inputs["Roughness"].default_value = 0.55
mesh.data.materials.clear()
mesh.data.materials.append(clay)

for name, loc, energy in (("key", (1.2, -1.6, 1.6), 900.0),
                          ("fill", (-1.4, -1.0, 0.8), 320.0),
                          ("rim", (0.2, 1.5, 1.2), 420.0)):
    light = bpy.data.lights.new(name, type="POINT")
    light.energy = energy
    obj = bpy.data.objects.new(name, light)
    obj.location = loc
    scene.collection.objects.link(obj)

cam_data = bpy.data.cameras.new("cam")
cam_data.lens = 70
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam


def frame_hand(side, direction, dist=0.30):
    pts = []
    for d in DIGITS:
        for s in (1, 2, 3):
            b = arm.pose.bones.get(f"{side}Hand{d}{s}")
            if b:
                pts.append(arm.matrix_world @ b.head)
                pts.append(arm.matrix_world @ b.tail)
    centre = sum(pts, Vector()) / len(pts)
    cam.location = centre + Vector(direction).normalized() * dist
    look = centre - cam.location
    cam.rotation_euler = look.to_track_quat("-Z", "Y").to_euler()
    return centre


def set_curl(side, amount, thumb_amount=None):
    for d in DIGITS:
        a = thumb_amount if (d == "Thumb" and thumb_amount is not None) else amount
        for s in (1, 2, 3):
            pb = arm.pose.bones.get(f"{side}Hand{d}{s}")
            if not pb:
                continue
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = (math.radians(-90.0 * CURL[s - 1] * a), 0.0, 0.0)


os.makedirs(OUTDIR, exist_ok=True)


def render(name):
    scene.render.filepath = os.path.join(OUTDIR, name)
    bpy.ops.render.render(write_still=True)
    print("RENDERED", name)


for side in ("Right",):
    for label, amount in (("open", 0.0), ("c25", 0.25), ("c40", 0.40),
                          ("c55", 0.55), ("c70", 0.70), ("fist", 1.0)):
        set_curl(side, amount)
        bpy.context.view_layer.update()
        frame_hand(side, (0.55, -0.75, 0.35))
        render(f"{side.lower()}_{label}.png")

# One from the back of the hand too: a fist that reads from the palm side can
# still be wrong from behind.
set_curl("Right", 1.0)
bpy.context.view_layer.update()
frame_hand("Right", (-0.5, -0.55, 0.67))
render("right_fist_back.png")
print("DONE")
