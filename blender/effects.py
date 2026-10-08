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
        compositing, and shows in `render` looks and final renders. For haze together
        with a film look, use `grade`.
        """
        return self.grade(haze={"colour": colour, "start": start, "depth": depth, "strength": strength}, bloom=0.0, vignette=0.0, contrast=0.0, scene=scene)

    def grade(self, haze=None, bloom=0.25, vignette=0.3, contrast=0.12, saturation=1.0, tint=(1.0, 1.0, 1.0), scene=None):
        """
        The look of the finished picture, done after rendering so it costs nothing:
        `bloom` (0 to 1) lets bright things glow, `vignette` (0 to 1) darkens the corners
        and draws the eye in, `contrast` (-1 to 1) and `saturation` (1 is unchanged) set
        the punch, and `tint` (r, g, b) multiplies the whole frame, for a warm or cold
        cast. `haze` is a dict of `colour`, `start`, `depth` and optionally `strength`,
        as in `haze()`. It replaces the scene's compositing. Call it once, last.
        """
        scene = scene or bpy.context.scene
        modern = hasattr(scene, "compositing_node_group")
        if modern:
            tree = bpy.data.node_groups.new("Grade", "CompositorNodeTree")
            tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
            scene.compositing_node_group = tree
            output = tree.nodes.new("NodeGroupOutput")
        else:
            scene.use_nodes = True
            tree = scene.node_tree
            tree.nodes.clear()
            output = tree.nodes.new("CompositorNodeComposite")
        nodes, links = tree.nodes, tree.links
        layers = nodes.new("CompositorNodeRLayers")
        image = layers.outputs["Image"]

        def setting(node, name, value):
            socket = node.inputs.get(name)
            if socket is not None:
                socket.default_value = value
            return socket is not None

        def mixed(factor, a, b, blend="MIX"):
            if modern:
                node = nodes.new("ShaderNodeMix")
                node.data_type = "RGBA"
                node.blend_type = blend
                ins, out = (node.inputs[0], node.inputs[6], node.inputs[7]), node.outputs[2]
            else:
                node = nodes.new("CompositorNodeMixRGB")
                node.blend_type = blend
                ins, out = (node.inputs[0], node.inputs[1], node.inputs[2]), node.outputs[0]
            for socket, value in zip(ins, (factor, a, b)):
                if isinstance(value, bpy.types.NodeSocket):
                    links.new(value, socket)
                else:
                    socket.default_value = value
            return out

        if haze:
            if scene.world is None:
                scene.world = bpy.data.worlds.new("World")
            mist = scene.world.mist_settings
            mist.start, mist.depth, mist.falloff = haze.get("start", 4.0), haze.get("depth", 150.0), "LINEAR"
            for layer in scene.view_layers:
                layer.use_pass_mist = True
            amount = nodes.new("ShaderNodeMath" if modern else "CompositorNodeMath")
            amount.operation = "MULTIPLY"
            amount.use_clamp = True
            amount.inputs[1].default_value = haze.get("strength", 1.0)
            links.new(layers.outputs["Mist"], amount.inputs[0])
            image = mixed(amount.outputs[0], image, (*haze.get("colour", (0.74, 0.62, 0.46)), 1))

        if bloom > 0:
            glare = nodes.new("CompositorNodeGlare")
            links.new(image, glare.inputs["Image"])
            if modern:
                glare.inputs["Type"].default_value = "Bloom"
                setting(glare, "Threshold", 1.0)
                setting(glare, "Strength", min(1.0, bloom))
                setting(glare, "Size", 0.5)
            else:
                glare.glare_type = "BLOOM" if bpy.app.version >= (4, 2, 0) else "FOG_GLOW"
                glare.threshold = 1.0
            image = glare.outputs["Image"]

        if tuple(tint) != (1.0, 1.0, 1.0):
            image = mixed(1.0, image, (*tint, 1), "MULTIPLY")

        if saturation != 1.0:
            colours = nodes.new("CompositorNodeHueSat")
            links.new(image, colours.inputs["Image"])
            if not setting(colours, "Saturation", saturation):
                colours.color_saturation = saturation
            image = colours.outputs["Image"]

        if contrast != 0:
            punch = nodes.new("CompositorNodeBrightContrast")
            links.new(image, punch.inputs["Image"])
            # Blender's contrast runs to 100.
            if not setting(punch, "Contrast", contrast * 25.0):
                punch.inputs[2].default_value = contrast * 25.0
            image = punch.outputs["Image"]

        if vignette > 0 and modern:
            where = nodes.new("CompositorNodeImageCoordinates")
            links.new(image, where.inputs["Image"])
            middle = nodes.new("ShaderNodeVectorMath")
            middle.operation = "SUBTRACT"
            links.new(where.outputs["Normalized"], middle.inputs[0])
            middle.inputs[1].default_value = (0.5, 0.5, 0.0)
            away = nodes.new("ShaderNodeVectorMath")
            away.operation = "LENGTH"
            links.new(middle.outputs[0], away.inputs[0])
            edge = nodes.new("ShaderNodeMapRange")
            edge.interpolation_type = "SMOOTHSTEP"
            edge.inputs["From Min"].default_value = 0.3
            edge.inputs["From Max"].default_value = 0.75
            edge.inputs["To Max"].default_value = vignette
            links.new(away.outputs["Value"], edge.inputs["Value"])
            image = mixed(edge.outputs[0], image, (0.0, 0.0, 0.0, 1.0))

        links.new(image, output.inputs[0])
        scene.render.use_compositing = True
        return tree

    def puff_material(self, name="Dust", colour=(0.52, 0.42, 0.30), density=1.0, volume=False):
        """
        A soft cloud for dust, smoke or steam. Give it to a sphere of radius 1 and scale
        the object to the size of the puff: it is thick in the middle, ragged, and fades
        to nothing at its edge. Its thickness is multiplied by the object's colour alpha
        (`ob.color[3]`), so a puff is animated by keying location, scale and that alpha:
        born small and thick, it grows, drifts and thins. Key `hide_render` too, so a
        puff that is not alive costs nothing.

        By default the puff is a see-through surface, which renders fast. `volume=True`
        makes it a true volume: better when the camera is inside it or light shafts
        matter, but Cycles prepares every such object before each frame, which for a few
        dozen puffs is minutes. Returns the material.
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
        ragged = nodes.new("ShaderNodeTexNoise")
        ragged.inputs["Scale"].default_value = 2.4
        ragged.inputs["Detail"].default_value = 5.0
        links.new(coord.outputs["Object"], ragged.inputs["Vector"])
        cloud = nodes.new("ShaderNodeMapRange")
        cloud.inputs["From Min"].default_value = 0.32
        cloud.inputs["From Max"].default_value = 0.72
        links.new(ragged.outputs[0], cloud.inputs["Value"])
        own = nodes.new("ShaderNodeObjectInfo")
        output = nodes.new("ShaderNodeOutputMaterial")
        mat.diffuse_color = (*colour, 0.25)

        if volume:
            radius = nodes.new("ShaderNodeVectorMath")
            radius.operation = "LENGTH"
            links.new(coord.outputs["Object"], radius.inputs[0])
            core = math_("POWER", math_("SUBTRACT", 1.0, radius.outputs["Value"]), 1.4)
            amount = math_("MULTIPLY", math_("MULTIPLY", core, cloud.outputs[0]), own.outputs["Alpha"])
            scaled = nodes.new("ShaderNodeMath")
            scaled.operation = "MULTIPLY"
            scaled.inputs[1].default_value = 9.0 * density
            links.new(amount, scaled.inputs[0])
            smoke = nodes.new("ShaderNodeVolumePrincipled")
            smoke.inputs["Color"].default_value = (*colour, 1)
            smoke.inputs["Anisotropy"].default_value = 0.25
            links.new(scaled.outputs[0], smoke.inputs["Density"])
            links.new(smoke.outputs[0], output.inputs["Volume"])
            return mat

        # Seen from outside, a puff is thickest where the eye looks through its middle.
        edge = nodes.new("ShaderNodeLayerWeight")
        edge.inputs["Blend"].default_value = 0.35
        core = math_("POWER", math_("SUBTRACT", 1.0, edge.outputs["Facing"]), 1.6)
        amount = math_("MULTIPLY", math_("MULTIPLY", math_("MULTIPLY", core, cloud.outputs[0]), own.outputs["Alpha"]), min(1.0, 0.85 * density))
        lit = nodes.new("ShaderNodeBsdfDiffuse")
        lit.inputs["Color"].default_value = (*colour, 1)
        through = nodes.new("ShaderNodeBsdfTranslucent")
        through.inputs["Color"].default_value = (*colour, 1)
        body = nodes.new("ShaderNodeMixShader")
        body.inputs[0].default_value = 0.5
        links.new(lit.outputs[0], body.inputs[1])
        links.new(through.outputs[0], body.inputs[2])
        clear = nodes.new("ShaderNodeBsdfTransparent")
        puff = nodes.new("ShaderNodeMixShader")
        links.new(amount, puff.inputs[0])
        links.new(clear.outputs[0], puff.inputs[1])
        links.new(body.outputs[0], puff.inputs[2])
        links.new(puff.outputs[0], output.inputs["Surface"])
        return mat
