"use client";

import { Bounds, OrbitControls, useBounds } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ArrowUp, Box, Camera, ChevronDown, ExternalLink, FolderOpen, Image as ImageIcon, Plus, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ProjectSummary } from "@/blender/projects";
import type { Message, StudioState } from "@/blender/types";
import type { PlannerInfo } from "@/client/store";
import { Menu, MenuItem, cx } from "./ui";

const api = (id: string, rest = "") => `/api/blender/${id}${rest}`;

async function post(url: string, body: unknown): Promise<string | null> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (response?.ok) return null;
  const reply = (await response?.json().catch(() => null)) as { error?: string } | null;
  return reply?.error ?? "The app could not be reached.";
}

/** The project as the server has it, kept current by asking again whenever it changes. */
function useStudio(id: string): StudioState | null {
  const [state, setState] = useState<StudioState | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      let rev = 0;
      while (!abort.signal.aborted) {
        try {
          const response = await fetch(api(id, rev ? `?after=${rev}` : ""), { signal: abort.signal });
          if (!response.ok) throw new Error(String(response.status));
          const next = (await response.json()) as StudioState;
          rev = next.rev;
          setState(next);
        } catch {
          if (abort.signal.aborted) return;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    })();
    return () => abort.abort();
  }, [id]);
  return state;
}

// ─── The 3D preview ─────────────────────────────────────────────────

/** Soft studio light from every side, so metal has something to reflect. */
function Lighting() {
  const gl = useThree((s) => s.gl);
  const environment = useMemo(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    return texture;
  }, [gl]);
  useEffect(() => () => environment.dispose(), [environment]);
  return (
    <>
      <primitive object={environment} attach="environment" />
      <directionalLight position={[4, 7, 5]} intensity={1.6} />
    </>
  );
}

function Animated({ gltf }: { gltf: GLTF }) {
  const mixer = useMemo(() => new THREE.AnimationMixer(gltf.scene), [gltf]);
  useEffect(() => {
    for (const clip of gltf.animations) mixer.clipAction(clip).play();
    return () => void mixer.stopAllAction();
  }, [gltf, mixer]);
  useFrame((_, delta) => mixer.update(delta));
  return null;
}

/**
 * The box around what the model is of. A ground or backdrop far larger than
 * the subject is left out, or the subject would be a dot in the distance.
 */
function subjectBox(root: THREE.Object3D): THREE.Box3 {
  const parts: { box: THREE.Box3; flat: boolean; span: number }[] = [];
  root.updateWorldMatrix(true, true);
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z);
    parts.push({ box, flat: Math.min(size.x, size.y, size.z) < 0.02 * span, span });
  });
  const union = (boxes: typeof parts) => boxes.reduce((all, part) => all.union(part.box), new THREE.Box3());
  const solid = parts.filter((part) => !part.flat);
  if (solid.length === 0) return union(parts);
  const radius = union(solid).getSize(new THREE.Vector3()).length() / 2;
  return union(parts.filter((part) => !part.flat || part.span <= 4 * radius));
}

/** Points the view at the first model to arrive. Later versions leave the camera where the person put it. */
function Fit({ root }: { root: THREE.Object3D }) {
  const bounds = useBounds();
  const fitted = useRef(false);
  useEffect(() => {
    const box = subjectBox(root);
    if (fitted.current || box.isEmpty()) return;
    fitted.current = true;
    bounds.refresh(box).clip().fit();
  }, [bounds, root]);
  return null;
}

/** What Blender last exported. The old model stays up while a new one loads. */
function Model({ url }: { url: string }) {
  const [gltf, setGltf] = useState<GLTF | null>(null);
  useEffect(() => {
    let current = true;
    new GLTFLoader().loadAsync(url).then(
      (loaded) => current && setGltf(loaded),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [url]);
  // A tall, narrow view needs more room around the subject to show all of it.
  const tall = useThree((s) => Math.max(1, s.size.height / s.size.width));
  if (!gltf) return null;
  return (
    <Bounds margin={1.25 * tall} maxDuration={0.4}>
      <primitive object={gltf.scene} />
      <Fit root={gltf.scene} />
      {gltf.animations.length > 0 && <Animated gltf={gltf} />}
    </Bounds>
  );
}

function Preview({ url }: { url: string | null }) {
  return (
    <Canvas camera={{ position: [3, 2.2, 4], fov: 40, near: 0.01, far: 2000 }} dpr={[1, 2]}>
      <color attach="background" args={["#15171f"]} />
      <Lighting />
      {url && <Model url={url} />}
      {/* Just under the floor, so a ground plane at zero doesn't flicker against it. */}
      <gridHelper args={[20, 20, "#2c3142", "#1f2330"]} position={[0, -0.003, 0]} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
    </Canvas>
  );
}

// ─── The conversation ───────────────────────────────────────────────

function Bubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="ml-6 flex flex-col items-end gap-1 self-end">
        <div className="rounded-xl rounded-br-sm bg-raised px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">
          {message.text}
        </div>
        {message.from === "blender" && <span className="font-mono text-[11px] text-faint">typed in Blender</span>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {message.text && <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-text">{message.text}</p>}
      {message.error && (
        <p role="alert" className="rounded-lg border border-err/30 bg-err/10 px-3 py-2 text-xs leading-relaxed text-err">
          {message.error}
        </p>
      )}
      {message.steps ? (
        <span className="font-mono text-[11px] text-faint">
          {message.steps} {message.steps === 1 ? "step" : "steps"} in Blender
        </span>
      ) : null}
    </div>
  );
}

const SUGGESTIONS = [
  "A weathered oil lantern standing on a wooden crate",
  "A small delivery robot with rubber tracks and a single camera eye",
  "A ceramic teapot and two cups on a tray, lit like a product shot",
];

function Chat({ id, state, planner }: { id: string; state: StudioState; planner: PlannerInfo }) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const { chat } = state.project;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [chat.length, state.live.length, state.status]);

  const send = async (text: string) => {
    if (!text.trim() || state.busy) return;
    setDraft("");
    setProblem(await post(api(id, "/chat"), { text, from: "web" }));
  };
  const source = {
    claude: planner.model,
    bridge: "claude code session",
    offline: "no model",
  }[planner.kind];

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-[11px] font-semibold tracking-wider text-faint uppercase">Co-pilot</h2>
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-faint">
          <span className={cx("size-1.5 rounded-full", planner.kind === "offline" ? "bg-warn" : "bg-accent")} />
          {source}
        </span>
      </header>

      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {planner.kind === "offline" && (
          <p className="rounded-lg border border-warn/25 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
            Building in Blender needs a model. Add <code className="font-mono">ANTHROPIC_API_KEY</code> to{" "}
            <code className="font-mono">.env.local</code>, or set <code className="font-mono">PLANNER=bridge</code>.
          </p>
        )}
        {chat.length === 0 && !state.busy && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] leading-relaxed text-dim">
              Describe what to build. It is modelled in a real Blender scene, which you can open to watch,
              edit by hand, and keep talking from there.
            </p>
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => void send(suggestion)}
                className="rounded-lg border border-line px-3 py-2 text-left text-xs leading-relaxed text-dim transition-colors hover:border-accent/60 hover:text-text"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
        {chat.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
        {state.busy && (
          <div className="flex flex-col gap-1.5" aria-live="polite">
            {state.live && <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-text">{state.live}</p>}
            <span className="flex items-center gap-2 font-mono text-[11px] text-dim">
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
              {state.status || "Working"}
            </span>
          </div>
        )}
        {problem && (
          <p role="alert" className="rounded-lg border border-err/30 bg-err/10 px-3 py-2 text-xs leading-relaxed text-err">
            {problem}
          </p>
        )}
      </div>

      <form
        className="shrink-0 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border border-line bg-bg p-2 transition-colors focus-within:border-accent">
          <textarea
            aria-label="Describe what to build or change"
            placeholder={chat.length === 0 ? "Describe what to build…" : "Ask for a change…"}
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(draft);
              }
            }}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-faint"
          />
          {state.busy ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop after the current step"
              onClick={() => void post(api(id, "/action"), { do: "stop" })}
              className="grid size-7 shrink-0 place-items-center rounded-lg bg-raised text-text hover:bg-hover"
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              title="Send (Enter)"
              disabled={!draft.trim()}
              className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-white transition-opacity disabled:opacity-30"
            >
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

// ─── The page ───────────────────────────────────────────────────────

function ProjectsMenu({ id }: { id: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);

  const load = async () => {
    const response = await fetch("/api/blender");
    setProjects(response.ok ? ((await response.json()) as { projects: ProjectSummary[] }).projects : []);
  };
  const create = async () => {
    const response = await fetch("/api/blender", { method: "POST" });
    if (response.ok) router.push(`/b/${((await response.json()) as { id: string }).id}`);
  };
  const remove = async () => {
    if (!window.confirm("Delete this project and its Blender file? This can't be undone.")) return;
    await fetch(api(id), { method: "DELETE" });
    router.push("/b");
  };

  return (
    <Menu
      trigger={
        <span className="flex items-center gap-1.5" onPointerDown={() => void load()}>
          <FolderOpen size={14} /> Projects <ChevronDown size={12} />
        </span>
      }
    >
      {(close) => (
        <div onClick={close}>
          <MenuItem onSelect={() => void create()}>
            <Plus size={14} /> New project
          </MenuItem>
          <div className="my-1 border-t border-line" />
          {projects === null && <p className="px-2 py-1.5 text-xs text-faint">Loading…</p>}
          {projects?.map((project) => (
            <MenuItem key={project.id} onSelect={() => router.push(`/b/${project.id}`)}>
              <span className={cx("truncate", project.id === id && "text-accent")}>{project.name}</span>
            </MenuItem>
          ))}
          <div className="my-1 border-t border-line" />
          <MenuItem danger onSelect={() => void remove()}>
            <Trash2 size={14} /> Delete this project
          </MenuItem>
        </div>
      )}
    </Menu>
  );
}

const ENGINE = {
  ui: { label: "Open in Blender", dot: "bg-ok", title: "This project is open in a Blender window. Changes appear there as they are made." },
  headless: { label: "Blender running in the background", dot: "bg-accent", title: "A Blender without a window is holding this project." },
  off: { label: "Blender starts with your next prompt", dot: "bg-faint", title: "No Blender is running for this project yet." },
};

const barButton =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 text-[13px] text-text transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-40";

export default function Studio({ id, planner }: { id: string; planner: PlannerInfo }) {
  const state = useStudio(id);
  const [view, setView] = useState<"model" | "picture">("model");
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A new picture from Blender is what the person wants to see next.
  const image = state?.project.image ?? null;
  const [seenImage, setSeenImage] = useState<string | null | undefined>(undefined);
  if (state && image !== seenImage) {
    setSeenImage(image);
    if (seenImage !== undefined && image) setView("picture");
  }

  if (!state) return <div className="grid h-dvh place-items-center bg-bg font-mono text-xs text-faint">Loading studio…</div>;

  const { project } = state;
  const engine = ENGINE[state.engine];
  const modelUrl = project.model ? api(id, `/file?name=model.glb&v=${project.model}`) : null;
  const act = async (what: "open" | "render", options: { animation?: boolean; draft?: boolean } = {}) => {
    if (what === "open") setOpening(true);
    setProblem(await post(api(id, "/action"), { do: what, ...options }));
    setOpening(false);
  };

  return (
    <div className="flex h-dvh flex-col bg-bg text-text">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <Link href="/" title="Back to the built-in scene editor" className="grid size-6 shrink-0 place-items-center rounded-md bg-accent text-[11px] font-bold text-white">
          AB
        </Link>
        <span className="max-w-28 truncate text-[13px] font-medium sm:max-w-64">{project.name}</span>
        <ProjectsMenu id={id} />
        <div className="flex-1" />
        <span className="hidden items-center gap-1.5 font-mono text-[11px] text-faint md:flex" title={engine.title}>
          <span className={cx("size-1.5 rounded-full", engine.dot)} />
          {engine.label}
        </span>
        <Menu
          align="right"
          trigger={
            <>
              <Camera size={14} /> Render <ChevronDown size={12} />
            </>
          }
        >
          {(close) => (
            <fieldset disabled={state.busy} className="contents disabled:opacity-40" onClick={close}>
              <MenuItem onSelect={() => void act("render")} hint="one frame">
                Picture
              </MenuItem>
              <MenuItem onSelect={() => void act("render", { animation: true, draft: true })} hint="half size, fast">
                Animation, draft
              </MenuItem>
              <MenuItem onSelect={() => void act("render", { animation: true })} hint="can take hours">
                Animation, full quality
              </MenuItem>
            </fieldset>
          )}
        </Menu>
        {state.engine !== "ui" && (
          <button
            type="button"
            className={cx(barButton, "border-accent/60")}
            disabled={state.busy || opening}
            onClick={() => void act("open")}
            title="Open this project in a Blender window. The conversation continues in its sidebar."
          >
            <ExternalLink size={14} /> {opening ? "Opening…" : "Open in Blender"}
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <main className="relative min-h-0 min-w-0 flex-1">
          <div className={cx("absolute inset-0", view !== "model" && "invisible")}>
            <Preview url={modelUrl} />
          </div>
          {view === "picture" && image && (
            <div className="absolute inset-0 grid place-items-center bg-bg p-4">
              {image.endsWith(".mp4") ? (
                <video key={image} src={api(id, `/file?name=${image}`)} controls loop autoPlay muted playsInline className="max-h-full max-w-full rounded-md" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- a local file that changes with every look
                <img src={api(id, `/file?name=${image}`)} alt="The latest picture from Blender" className="max-h-full max-w-full rounded-md object-contain" />
              )}
            </div>
          )}

          <div className="absolute top-3 left-3 flex gap-0.5 rounded-lg border border-line bg-panel/90 p-1 backdrop-blur">
            {(
              [
                { key: "model", label: "3D", icon: Box, disabled: false },
                { key: "picture", label: "Picture", icon: ImageIcon, disabled: !image },
              ] as const
            ).map(({ key, label, icon: Icon, disabled }) => (
              <button
                key={key}
                type="button"
                disabled={disabled}
                aria-pressed={view === key}
                onClick={() => setView(key)}
                className={cx(
                  "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors disabled:opacity-35",
                  view === key ? "bg-accent text-white" : "text-dim hover:bg-hover hover:text-text",
                )}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>

          {view === "model" && !modelUrl && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <p className="max-w-xs text-center text-sm leading-relaxed text-dim">
                {state.busy ? "Blender is at work. The model appears here as it takes shape." : "Nothing built yet. Describe what you want in the co-pilot panel."}
              </p>
            </div>
          )}
          {problem && (
            <p role="alert" className="absolute right-3 bottom-3 left-3 rounded-lg border border-err/30 bg-panel px-3 py-2 text-xs leading-relaxed text-err">
              {problem}
            </p>
          )}
        </main>
        <aside className="h-[45%] shrink-0 border-t border-line bg-panel md:h-auto md:w-[320px] md:border-t-0 md:border-l xl:w-[360px]">
          <Chat id={id} state={state} planner={planner} />
        </aside>
      </div>
    </div>
  );
}
