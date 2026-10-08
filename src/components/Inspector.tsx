"use client";

import { Copy, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useEditor } from "@/client/store";
import { sampleTrack } from "@/scene/animate";
import {
  ANIMATABLE,
  PRIMITIVES,
  type Animatable,
  type ArrayCopies,
  type EnvPatch,
  type NodePatch,
  type SceneNode,
  type Vec3,
} from "@/scene/types";
import { ColorField, IconButton, NumberField, Row, Section, Select, Slider, TextField } from "./ui";

const AXES = ["X", "Y", "Z"] as const;

function Vec3Field({
  label,
  value,
  onChange,
  step,
  min,
}: {
  label: string;
  value: Vec3;
  onChange: (value: Vec3) => void;
  step?: number;
  min?: number;
}) {
  return (
    <Row label={label}>
      <div className="grid grid-cols-3 gap-1">
        {AXES.map((axis, i) => (
          <NumberField
            key={axis}
            label={`${label} ${axis}`}
            value={value[i]}
            step={step}
            min={min}
            onChange={(n) => onChange(value.map((v, j) => (j === i ? n : v)) as Vec3)}
          />
        ))}
      </div>
    </Row>
  );
}

const ONE_COPY: ArrayCopies = { count: 1, step: [0, 0, 0], turn: [0, 0, 0] };

function NodeInspector({ node }: { node: SceneNode }) {
  const locked = useEditor((s) => s.generating);
  const { commit, transform, duplicateSelected, removeSelected } = useEditor.getState();
  // An animated property shows its value at the playhead, and editing it sets a key there.
  const shown = useEditor(
    useShallow((s) =>
      ANIMATABLE.flatMap((property) => {
        const track = s.doc.scene.clip.tracks.find((t) => t.node === node.id && t.property === property);
        return track ? sampleTrack(track.keys, s.time) : node[property];
      }),
    ),
  );
  const value = (property: Animatable) => {
    const at = ANIMATABLE.indexOf(property) * 3;
    return shown.slice(at, at + 3) as Vec3;
  };
  const move = (property: Animatable) => (next: Vec3) =>
    transform(node.id, { [property]: next }, `Edit ${node.name}`, `${property}:${node.id}`);

  /** Edits one property group; repeated edits to it merge into one undo step. */
  const update = (patch: NodePatch, what: string) =>
    commit([{ type: "update", id: node.id, patch }], `Edit ${node.name}`, `${what}:${node.id}`);

  return (
    <fieldset disabled={locked} className="contents">
      <Section
        title={node.kind}
        action={
          <div className="flex gap-0.5">
            <IconButton label="Duplicate (Ctrl+D)" onClick={duplicateSelected}>
              <Copy size={13} />
            </IconButton>
            <IconButton label="Delete (Del)" onClick={removeSelected}>
              <Trash2 size={13} />
            </IconButton>
          </div>
        }
      >
        <Row label="Name">
          <TextField label="Name" value={node.name} onCommit={(name) => update({ name }, "name")} />
        </Row>
        <Vec3Field label="Position" value={value("position")} onChange={move("position")} />
        <Vec3Field label="Rotation" value={value("rotation")} step={5} onChange={move("rotation")} />
        {node.kind !== "light" && (
          <Vec3Field
            label={node.kind === "mesh" ? "Size" : "Scale"}
            value={value("scale")}
            min={0.001}
            onChange={move("scale")}
          />
        )}
      </Section>

      {node.kind === "group" && (
        <Section title="Surface">
          <Row label="Blend">
            <Slider
              label="Blend parts together"
              value={node.blend}
              max={0.3}
              step={0.01}
              onChange={(blend) => update({ blend }, "blend")}
            />
          </Row>
          <p className="text-[11px] leading-relaxed text-faint">
            Above zero, this object&apos;s solid parts fuse into one smooth surface.
          </p>
        </Section>
      )}

      {node.kind === "mesh" && (
        <Section title="Surface">
          <Row label="Shape">
            <Select
              label="Shape"
              value={node.primitive}
              options={PRIMITIVES}
              onChange={(primitive) => update({ primitive }, "primitive")}
            />
          </Row>
          {node.primitive === "box" && (
            <Row label="Bevel">
              <Slider
                label="Round the edges, in meters"
                value={node.bevel}
                max={0.1}
                step={0.005}
                onChange={(bevel) => update({ bevel }, "bevel")}
              />
            </Row>
          )}
          <Row label="Color">
            <ColorField
              label="Color"
              value={node.material.color}
              onChange={(color) => update({ material: { color } }, "color")}
            />
          </Row>
          <Row label="Wear">
            <Slider
              label="Chipped, worn paint"
              value={node.material.wear}
              onChange={(wear) => update({ material: { wear } }, "wear")}
            />
          </Row>
          <Row label="Roughness">
            <Slider
              label="Roughness"
              value={node.material.roughness}
              onChange={(roughness) => update({ material: { roughness } }, "roughness")}
            />
          </Row>
          <Row label="Metalness">
            <Slider
              label="Metalness"
              value={node.material.metalness}
              onChange={(metalness) => update({ material: { metalness } }, "metalness")}
            />
          </Row>
          <Row label="Opacity">
            <Slider
              label="Opacity"
              value={node.material.opacity}
              onChange={(opacity) => update({ material: { opacity } }, "opacity")}
            />
          </Row>
          <Row label="Glow">
            <div className="grid grid-cols-[1fr_64px] gap-1">
              <ColorField
                label="Glow color"
                value={node.material.emissive}
                onChange={(emissive) =>
                  update(
                    {
                      material: {
                        emissive,
                        // Picking a glow color should visibly do something.
                        emissiveIntensity: node.material.emissiveIntensity || 2,
                      },
                    },
                    "emissive",
                  )
                }
              />
              <NumberField
                label="Glow strength"
                value={node.material.emissiveIntensity}
                min={0}
                max={100}
                step={0.5}
                onChange={(emissiveIntensity) =>
                  update({ material: { emissiveIntensity } }, "emissiveIntensity")
                }
              />
            </div>
          </Row>
        </Section>
      )}

      {node.kind === "mesh" && (
        <Section title="Array">
          <Row label="Copies">
            <NumberField
              label="How many, the original included"
              value={node.array?.count ?? 1}
              min={1}
              max={64}
              step={1}
              onChange={(count) =>
                update(
                  { array: count > 1 ? { ...(node.array ?? ONE_COPY), count: Math.round(count) } : null },
                  "arrayCount",
                )
              }
            />
          </Row>
          {node.array && (
            <>
              <Vec3Field
                label="Step"
                value={node.array.step}
                onChange={(step) => update({ array: { ...node.array!, step } }, "arrayStep")}
              />
              <Vec3Field
                label="Turn"
                value={node.array.turn}
                step={5}
                onChange={(turn) => update({ array: { ...node.array!, turn } }, "arrayTurn")}
              />
            </>
          )}
        </Section>
      )}

      {node.kind === "light" && (
        <Section title="Light">
          <Row label="Type">
            <Select
              label="Light type"
              value={node.light.type}
              options={["point", "spot"] as const}
              onChange={(type) => update({ light: { type } }, "lightType")}
            />
          </Row>
          <Row label="Color">
            <ColorField
              label="Light color"
              value={node.light.color}
              onChange={(color) => update({ light: { color } }, "lightColor")}
            />
          </Row>
          <Row label="Intensity">
            <NumberField
              label="Intensity"
              value={node.light.intensity}
              min={0}
              step={5}
              onChange={(intensity) => update({ light: { intensity } }, "intensity")}
            />
          </Row>
          <Row label="Range">
            <NumberField
              label="Range in meters, 0 for unlimited"
              value={node.light.distance}
              min={0}
              step={1}
              onChange={(distance) => update({ light: { distance } }, "distance")}
            />
          </Row>
          {node.light.type === "spot" && (
            <Row label="Cone">
              <Slider
                label="Cone angle"
                value={node.light.angle}
                min={1}
                max={89}
                step={1}
                onChange={(angle) => update({ light: { angle } }, "angle")}
              />
            </Row>
          )}
        </Section>
      )}

      {node.pinned.length > 0 && (
        <Section
          title="Set by you"
          action={
            <button
              type="button"
              className="text-[11px] text-dim hover:text-text"
              onClick={() =>
                commit(
                  [{ type: "update", id: node.id, patch: { pinned: [] } }],
                  `Release ${node.name}`,
                )
              }
            >
              Release
            </button>
          }
        >
          <div className="flex flex-wrap gap-1">
            {node.pinned.map((key) => (
              <span
                key={key}
                className="rounded-full border border-user/40 bg-user/10 px-2 py-0.5 text-[11px] text-user"
              >
                {key}
              </span>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-faint">
            The co-pilot keeps these as you set them unless you ask it to change them.
          </p>
        </Section>
      )}
    </fieldset>
  );
}

function EnvironmentInspector() {
  const env = useEditor((s) => s.doc.scene.environment);
  const locked = useEditor((s) => s.generating);
  const update = (patch: EnvPatch, what: string) =>
    useEditor.getState().commit([{ type: "env", patch }], "Edit environment", `env:${what}`);

  return (
    <fieldset disabled={locked} className="contents">
      <Section title="Environment">
        <Row label="Sky">
          <ColorField
            label="Sky color"
            value={env.background}
            onChange={(background) => update({ background }, "background")}
          />
        </Row>
        <Row label="Ambient">
          <Slider
            label="Ambient light"
            value={env.ambient}
            max={3}
            step={0.05}
            onChange={(ambient) => update({ ambient }, "ambient")}
          />
        </Row>
        <Row label="Ground">
          <div className="grid grid-cols-[auto_1fr] items-center gap-2">
            <input
              type="checkbox"
              aria-label="Show ground"
              className="size-3.5 accent-accent"
              checked={env.ground.visible}
              onChange={(e) => update({ ground: { visible: e.target.checked } }, "groundVisible")}
            />
            <ColorField
              label="Ground color"
              value={env.ground.color}
              onChange={(color) => update({ ground: { color } }, "groundColor")}
            />
          </div>
        </Row>
        <Row label="Fog">
          <div className="grid grid-cols-[auto_1fr] items-center gap-2">
            <input
              type="checkbox"
              aria-label="Fog"
              className="size-3.5 accent-accent"
              checked={env.fog !== null}
              onChange={(e) =>
                update(
                  { fog: e.target.checked ? { color: env.background, near: 10, far: 60 } : null },
                  "fogToggle",
                )
              }
            />
            {env.fog ? (
              <Slider
                label="Fog distance"
                value={env.fog.far}
                min={10}
                max={200}
                step={1}
                onChange={(far) => update({ fog: { ...env.fog!, far } }, "fogFar")}
              />
            ) : (
              <span className="text-xs text-faint">Off</span>
            )}
          </div>
        </Row>
      </Section>
      <Section title="Sun">
        <Row label="Color">
          <ColorField
            label="Sun color"
            value={env.sun.color}
            onChange={(color) => update({ sun: { color } }, "sunColor")}
          />
        </Row>
        <Row label="Strength">
          <Slider
            label="Sun strength"
            value={env.sun.intensity}
            max={6}
            step={0.05}
            onChange={(intensity) => update({ sun: { intensity } }, "sunIntensity")}
          />
        </Row>
        <Row label="Height">
          <Slider
            label="Sun height"
            value={env.sun.elevation}
            min={0}
            max={90}
            step={1}
            onChange={(elevation) => update({ sun: { elevation } }, "sunElevation")}
          />
        </Row>
        <Row label="Direction">
          <Slider
            label="Sun direction"
            value={env.sun.azimuth}
            min={-180}
            max={180}
            step={1}
            onChange={(azimuth) => update({ sun: { azimuth } }, "sunAzimuth")}
          />
        </Row>
      </Section>
      <Section title="Grade">
        <Row label="Bloom">
          <Slider
            label="Glow around bright things"
            value={env.grade.bloom}
            max={3}
            step={0.05}
            onChange={(bloom) => update({ grade: { bloom } }, "bloom")}
          />
        </Row>
        <Row label="Vignette">
          <Slider
            label="Darken the corners"
            value={env.grade.vignette}
            onChange={(vignette) => update({ grade: { vignette } }, "vignette")}
          />
        </Row>
        <Row label="Saturation">
          <Slider
            label="Saturation"
            value={env.grade.saturation}
            max={2}
            onChange={(saturation) => update({ grade: { saturation } }, "saturation")}
          />
        </Row>
        <Row label="Contrast">
          <Slider
            label="Contrast"
            value={env.grade.contrast}
            min={-0.5}
            max={0.5}
            onChange={(contrast) => update({ grade: { contrast } }, "contrast")}
          />
        </Row>
      </Section>
    </fieldset>
  );
}

export default function Inspector() {
  const node = useEditor((s) => (s.selection ? s.doc.scene.nodes[s.selection] : undefined));
  return (
    <div className="max-h-[58%] shrink-0 overflow-y-auto border-t border-line">
      {node ? <NodeInspector key={node.id} node={node} /> : <EnvironmentInspector />}
    </div>
  );
}
