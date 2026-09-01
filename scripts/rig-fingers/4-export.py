"""Clear the pose and export the finished rig under a NEW filename.

The original sealed-porcelain-duelist.glb is never touched: AGENTS.md 4 records
that its PBR maps, root motion and idle damping were all repaired by hand.
"""
import bpy, sys

args = sys.argv[sys.argv.index("--") + 1:]
BLEND, OUT = args[0], args[1]

bpy.ops.wm.open_mainfile(filepath=BLEND)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")

# Back to bind pose, so the export is the rest rig and not whatever the last
# pose test left behind.
for pb in arm.pose.bones:
    pb.matrix_basis.identity()
bpy.context.view_layer.update()

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_skins=True,
    export_animations=True,
    export_def_bones=False,
    export_apply=False,
    export_yup=True,
)
print("EXPORTED", OUT)
