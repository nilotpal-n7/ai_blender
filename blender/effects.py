"""
Atmosphere for the co-pilot: haze with distance, and puffs of dust or smoke.

The co-pilot's code gets an `Effects` as `fx`. Both effects are built from what
ships with Blender, so they work offline and in any project.
"""

import bpy


class Effects:
    def haze(self, colour=(0.74, 0.62, 0.46), start=4.0, depth=150.0, strength=1.0, scene=None):
        """
        Air you can see: things fade toward `colour` with distance, from `start` meters
        to fully hazed at `start + depth`. It is what makes a landscape read as large
        and dusty, and costs almost nothing to render. It replaces the scene's
        compositing, and shows in `render` looks and final renders.
        """
        scene = scene or bpy.context.scene
        if scene.world is None:
            scene.world = bpy.data.worlds.new("World")
        mist = scene.world.mist_settings
        mist.start, mist.depth, mist.falloff = start, depth, "LINEAR"
        for layer in scene.view_layers:
            layer.use_pass_mist = True

        modern = hasattr(scene, "compositing_node_group")
        if modern:
            tree = bpy.data.node_groups.new("Haze", "CompositorNodeTree")
            tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
            scene.compositing_node_group = tree
            output = tree.nodes.new("NodeGroupOutput")
        else:
            scene.use_nodes = True
            tree = scene.node_tree
            tree.nodes.clear()
            output = tree.nodes.new("CompositorNodeComposite")
        layers = tree.nodes.new("CompositorNodeRLayers")
        amount = tree.nodes.new("ShaderNodeMath" if modern else "CompositorNodeMath")
        amount.operation = "MULTIPLY"
        amount.use_clamp = True
        amount.inputs[1].default_value = strength
        tree.links.new(layers.outputs["Mist"], amount.inputs[0])
        if modern:
            mix = tree.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            factor, near, far, result = mix.inputs[0], mix.inputs[6], mix.inputs[7], mix.outputs[2]
        else:
            mix = tree.nodes.new("CompositorNodeMixRGB")
            factor, near, far, result = mix.inputs[0], mix.inputs[1], mix.inputs[2], mix.outputs[0]
        tree.links.new(amount.outputs[0], factor)
        tree.links.new(layers.outputs["Image"], near)
        far.default_value = (*colour, 1)
        tree.links.new(result, output.inputs[0])
        scene.render.use_compositing = True
        return tree

    def puff_material(self, name="Dust", colour=(0.52, 0.42, 0.30), density=1.0):
        """
        A soft cloud for dust, smoke or steam. Give it to a sphere of radius 1 and scale
        the object to the size of the puff: it is dense in the middle, ragged, and fades
        to nothing at the surface. Its density is multiplied by the object's colour
        alpha (`ob.color[3]`), so a puff is animated by keying location, scale and that
        alpha: born small and thick, it grows, drifts and thins. Needs Cycles or EEVEE
        with volumes. Returns the material.
        """
        mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        mat.use_nodes = True
        tree = mat.node_tree
        tree.nodes.clear()
        nodes, links = tree.nodes, tree.links

        def math_(operation, a, b=None):
            node = nodes.new("ShaderNodeMath")
            node.operation = operation
            node.use_clamp = True
            for socket, value in ((node.inputs[0], a), (node.inputs[1], b)):
                if isinstance(value, bpy.types.NodeSocket):
                    links.new(value, socket)
                elif value is not None:
                    socket.default_value = value
            return node.outputs[0]

        coord = nodes.new("ShaderNodeTexCoord")
        radius = nodes.new("ShaderNodeVectorMath")
        radius.operation = "LENGTH"
        links.new(coord.outputs["Object"], radius.inputs[0])
        core = math_("POWER", math_("SUBTRACT", 1.0, radius.outputs["Value"]), 1.4)
        ragged = nodes.new("ShaderNodeTexNoise")
        ragged.inputs["Scale"].default_value = 2.4
        ragged.inputs["Detail"].default_value = 5.0
        links.new(coord.outputs["Object"], ragged.inputs["Vector"])
        cloud = nodes.new("ShaderNodeMapRange")
        cloud.inputs["From Min"].default_value = 0.32
        cloud.inputs["From Max"].default_value = 0.72
        links.new(ragged.outputs[0], cloud.inputs["Value"])
        own = nodes.new("ShaderNodeObjectInfo")
        amount = math_("MULTIPLY", math_("MULTIPLY", core, cloud.outputs[0]), own.outputs["Alpha"])
        scaled = nodes.new("ShaderNodeMath")
        scaled.operation = "MULTIPLY"
        scaled.inputs[1].default_value = 9.0 * density
        links.new(amount, scaled.inputs[0])

        volume = nodes.new("ShaderNodeVolumePrincipled")
        volume.inputs["Color"].default_value = (*colour, 1)
        volume.inputs["Anisotropy"].default_value = 0.25
        links.new(scaled.outputs[0], volume.inputs["Density"])
        links.new(volume.outputs[0], nodes.new("ShaderNodeOutputMaterial").inputs["Volume"])
        mat.diffuse_color = (*colour, 0.25)
        return mat
