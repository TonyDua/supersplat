import { EventHandle, Quat, Vec3 } from 'playcanvas';

import { CubicSpline } from './anim/spline';
import { AnimTrack } from './anim-track';
import { Events } from './events';

type Pose = {
    name: string,
    frame: number,
    position: Vec3,
    target: Vec3,
    fov?: number,
    lens?: CameraLens,
    rotation?: Quat
};

type CameraLens = {
    focalLength?: number,
    filmBackWidth?: number,
    filmBackHeight?: number,
    resolutionWidth?: number,
    resolutionHeight?: number,
    filmOffsetX?: number,
    filmOffsetY?: number,
    lensSqueeze?: number,
    fStop?: number,
    focusDistance?: number,
    nearClip?: number,
    farClip?: number
};

/**
 * A named camera: one animation track plus the label the viewport picker
 * shows. A file may hold several cameras, so importing creates one set each.
 */
type CameraSet = {
    name: string,
    track: CameraAnimTrack,
    worldScale: number
};

/** The viewport camera pose, as reported by `camera.getPose`. */
type View = {
    position: Vec3,
    target: Vec3,
    fov?: number,
    rotation?: Quat,
    lens?: CameraLens
};

/** What the viewport picker needs to render the camera list. */
type CameraSets = {
    /** Set names, in picker order. */
    names: string[],
    /** Index of the set key editing targets, -1 when there are none. */
    active: number,
    /** Whether the viewport is looking through the active set. */
    lookThrough: boolean,
    view: number
};

/**
 * Camera animation track that manages camera keyframes and interpolation.
 * Implements AnimTrack interface so it can be used with the timeline system.
 *
 * A track only drives the viewport camera while it is the set being looked
 * through. Every other set keeps its curve up to date so switching is instant,
 * but leaves the viewport alone.
 */
class CameraAnimTrack implements AnimTrack {
    /** True while this set is the one the viewport is looking through. */
    active = false;

    private poses: Pose[] = [];
    private events: Events;
    private onTimelineChange: ((frame: number) => void) | null = null;
    private poseAt: ((frame: number) => View) | null = null;
    private handles: EventHandle[] = [];

    constructor(events: Events) {
        this.events = events;

        // Camera source samples are independent of the project's Global range.
        this.handles.push(events.on('timeline.smoothness', () => {
            this.rebuildSpline();
        }));

    }

    destroy(): void {
        this.handles.forEach(handle => handle.off());
        this.handles = [];
    }

    get keys(): readonly number[] {
        return this.poses.map(p => p.frame);
    }

    getPoseAt(frame: number): View | null {
        return this.poseAt?.(frame) ?? null;
    }

    addKey(frame: number): boolean {
        const pose = this.events.invoke('camera.getPose');
        if (!pose) return false;

        const existingIndex = this.poses.findIndex(p => p.frame === frame);

        const newPose: Pose = {
            name: `camera_${this.poses.length}`,
            frame,
            position: new Vec3(pose.position.x, pose.position.y, pose.position.z),
            target: new Vec3(pose.target.x, pose.target.y, pose.target.z),
            fov: pose.fov
        };

        if (existingIndex === -1) {
            this.poses.push(newPose);
            this.rebuildSpline();
            this.events.fire('track.keyAdded', frame);
        } else {
            this.poses[existingIndex] = newPose;
            this.rebuildSpline();
            this.events.fire('track.keyUpdated', frame);
        }
        return true;
    }

    removeKey(frame: number): boolean {
        const index = this.poses.findIndex(p => p.frame === frame);
        if (index === -1) return false;
        this.poses.splice(index, 1);
        this.rebuildSpline();
        this.events.fire('track.keyRemoved', frame);
        return true;
    }

    moveKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;

        const index = this.poses.findIndex(p => p.frame === fromFrame);
        if (index === -1) return false;

        // Remove any existing pose at the target frame
        const toIndex = this.poses.findIndex(p => p.frame === toFrame);
        if (toIndex !== -1) {
            this.poses.splice(toIndex, 1);
        }

        // Update the frame (re-find index since splice may have shifted it)
        const movedIndex = this.poses.findIndex(p => p.frame === fromFrame);
        this.poses[movedIndex].frame = toFrame;
        this.rebuildSpline();
        this.events.fire('track.keyMoved', fromFrame, toFrame);
        return true;
    }

    copyKey(fromFrame: number, toFrame: number): boolean {
        if (fromFrame === toFrame) return false;

        const source = this.poses.find(p => p.frame === fromFrame);
        if (!source) return false;

        // Remove any existing pose at the target frame
        const toIndex = this.poses.findIndex(p => p.frame === toFrame);
        if (toIndex !== -1) {
            this.poses.splice(toIndex, 1);
        }

        this.poses.push({
            name: `camera_${this.poses.length}`,
            frame: toFrame,
            position: source.position.clone(),
            target: source.target.clone(),
            fov: source.fov,
            lens: source.lens ? { ...source.lens } : undefined,
            rotation: source.rotation?.clone()
        });

        this.rebuildSpline();
        this.events.fire('track.keyAdded', toFrame);
        return true;
    }

    evaluate(frame: number): void {
        this.onTimelineChange?.(frame);
    }

    clear(): void {
        this.poses.length = 0;
        this.onTimelineChange = null;
        this.poseAt = null;
        this.events.fire('track.keysCleared');
    }

    snapshot(): Pose[] {
        return this.poses.map(p => ({
            name: p.name,
            frame: p.frame,
            position: p.position.clone(),
            target: p.target.clone(),
            fov: p.fov,
            lens: p.lens ? { ...p.lens } : undefined,
            rotation: p.rotation?.clone()
        }));
    }

    restore(snapshot: unknown): void {
        this.poses = (snapshot as Pose[]).map(p => ({
            name: p.name,
            frame: p.frame,
            position: p.position.clone(),
            target: p.target.clone(),
            fov: p.fov,
            lens: p.lens ? { ...p.lens } : undefined,
            rotation: p.rotation?.clone()
        }));
        this.rebuildSpline();
        this.events.fire('track.keysLoaded');
    }

    /**
     * Add a pose directly (used for deserialization).
     */
    addPose(pose: Pose): void {
        if (pose.frame === undefined) {
            return;
        }

        pose.fov ??= this.events.invoke('camera.fov') ?? 60;

        const idx = this.poses.findIndex(p => p.frame === pose.frame);
        if (idx !== -1) {
            this.poses[idx] = pose;
            this.rebuildSpline();
            this.events.fire('track.keyUpdated', pose.frame);
        } else {
            this.poses.push(pose);
            this.rebuildSpline();
            this.events.fire('track.keyAdded', pose.frame);
        }
    }

    /**
     * Get all poses (used for serialization).
     */
    getPoses(): readonly Pose[] {
        return this.poses;
    }

    /**
     * Load poses from serialized data.
     */
    loadPoses(posesData: Pose[]): void {
        const defaultFov = this.events.invoke('camera.fov');
        this.poses.length = 0;
        posesData.forEach((pose) => {
            this.poses.push({
                ...pose,
                fov: pose.fov ?? defaultFov
            });
        });
        this.rebuildSpline();
        this.events.fire('track.keysLoaded');
    }

    scaleWorld(ratio: number): void {
        for (const pose of this.poses) {
            pose.position.mulScalar(ratio);
            pose.target.mulScalar(ratio);
            if (pose.lens?.nearClip) pose.lens.nearClip *= ratio;
            if (pose.lens?.farClip) pose.lens.farClip *= ratio;
            if (pose.lens?.focusDistance) pose.lens.focusDistance *= ratio;
        }
        this.rebuildSpline();
    }

    private rebuildSpline(): void {
        const smoothness = this.events.invoke('timeline.smoothness');

        const orderedPoses = this.poses.slice()
        .sort((a, b) => a.frame - b.frame);
        const startFrame = orderedPoses[0]?.frame ?? 0;

        const times = orderedPoses.map(p => p.frame - startFrame);
        const points: number[] = [];
        for (let i = 0; i < orderedPoses.length; ++i) {
            const p = orderedPoses[i];
            points.push(p.position.x, p.position.y, p.position.z);
            points.push(p.target.x, p.target.y, p.target.z);
            points.push(p.fov);
        }

        if (orderedPoses.length > 1) {
            // when not looping the spline clamps, holding the first/last pose
            // beyond the outer keys instead of wrapping the end into the start
            const spline = CubicSpline.fromPoints(times, points, smoothness);
            const result: number[] = [];
            const pose: View = { position: new Vec3(), target: new Vec3(), fov: 0, rotation: new Quat() };

            this.poseAt = (frame: number) => {
                spline.evaluate(frame - startFrame, result);
                pose.position.set(result[0], result[1], result[2]);
                pose.target.set(result[3], result[4], result[5]);
                pose.fov = result[6];
                const later = orderedPoses.findIndex(p => p.frame >= frame);
                const right = Math.max(0, later < 0 ? orderedPoses.length - 1 : later);
                const left = Math.max(0, right - 1);
                const a = orderedPoses[left];
                const b = orderedPoses[right];
                if (a.rotation && b.rotation) {
                    const t = a === b ? 0 : Math.max(0, Math.min(1, (frame - a.frame) / (b.frame - a.frame)));
                    pose.rotation ??= new Quat();
                    pose.rotation.slerp(a.rotation, b.rotation, t);
                } else {
                    pose.rotation = undefined;
                }
                pose.lens = (a === b ? a : frame === b.frame ? b : a).lens;
                return pose;
            };
        } else if (orderedPoses.length === 1) {
            // a single key can't form a spline; hold its pose at every frame
            const p = orderedPoses[0];
            const pose: View = {
                position: p.position.clone(),
                target: p.target.clone(),
                fov: p.fov,
                rotation: p.rotation?.clone(),
                lens: p.lens
            };

            this.poseAt = () => pose;
        } else {
            this.poseAt = null;
        }

        this.onTimelineChange = (frame: number) => {
            if (!this.active) return;
            const pose = this.getPoseAt(frame);
            if (pose) this.events.fire(pose.rotation ? 'camera.setTrackedPose' : 'camera.setPose', pose, 0);
        };

        // re-evaluate at the current frame so the camera updates immediately
        this.evaluate(this.events.invoke('timeline.frame'));
    }
}

/**
 * Register the camera sets and expose them via events.
 *
 * The editor has one free camera and any number of imported or hand keyed
 * camera sets. Only the set the viewport is looking through drives the camera,
 * which is what keeps free navigation and shot cameras from fighting: with
 * look-through off you can fly around while key editing still targets the
 * selected set.
 */
const registerCameraPosesEvents = (events: Events) => {
    const sets: CameraSet[] = [];

    // index of the set that key editing targets, -1 when there are none
    let activeIndex = -1;
    let viewIndex = -1;

    // whether the viewport is looking through the active set
    let lookThrough = false;

    // the free camera pose captured when look-through began, restored on exit
    let freeView: View | null = null;

    const activeTrack = () => {
        return activeIndex >= 0 && activeIndex < sets.length ? sets[activeIndex].track : null;
    };

    const updateActivation = () => {
        sets.forEach((set, i) => {
            set.track.active = lookThrough && i === viewIndex;
        });
    };

    const notify = () => {
        const poses = activeTrack()?.getPoses() ?? [];
        events.fire('timeline.setInputRange', 'camera', poses.length ? {
            start: poses.reduce((min, pose) => Math.min(min, pose.frame), Infinity),
            end: poses.reduce((max, pose) => Math.max(max, pose.frame), -Infinity),
            name: sets[activeIndex].name
        } : null);
        events.fire('camera.sets', {
            names: sets.map(set => set.name),
            active: activeIndex,
            lookThrough,
            view: viewIndex
        } satisfies CameraSets);
    };

    // drive the viewport camera from the active set at the current frame
    const applyActivePose = () => {
        sets[viewIndex]?.track.evaluate(events.invoke('timeline.frame') as number);
    };

    // only the set being looked through follows playback and scrubbing
    const onTimelineChange = (frame: number) => {
        if (lookThrough) {
            sets[viewIndex]?.track.evaluate(frame);
        }
    };

    events.on('timeline.frame', onTimelineChange);
    events.on('timeline.time', onTimelineChange);

    // a label the picker can show without duplicates
    const uniqueName = (name: string, taken: Set<string>) => {
        const base = name || 'camera';
        let candidate = base;
        for (let suffix = 2; taken.has(candidate); ++suffix) {
            candidate = `${base} ${suffix}`;
        }
        return candidate;
    };

    /**
     * Replace every set. Importing keeps the artist in perspective view so
     * camera objects remain visible and can be inspected before look-through.
     */
    const loadSets = (incoming: Array<{ name: string, poses: Pose[], worldScale?: number }>) => {
        const returnToFreeView = lookThrough ? freeView : null;
        sets.forEach(set => set.track.destroy());
        sets.length = 0;
        const taken = new Set<string>();
        incoming.forEach((entry) => {
            const track = new CameraAnimTrack(events);
            track.loadPoses(entry.poses);
            const name = uniqueName(entry.name, taken);
            taken.add(name);
            sets.push({ name, track, worldScale: entry.worldScale ?? 1 });
        });

        activeIndex = sets.length > 0 ? 0 : -1;
        viewIndex = -1;
        lookThrough = false;
        freeView = null;

        updateActivation();
        if (returnToFreeView) {
            events.fire('camera.setPose', returnToFreeView, 0);
        }

        events.fire('track.keysLoaded');
        notify();
    };

    // the track the timeline and key editing work on
    events.function('camera.animTrack', () => {
        return activeTrack();
    });

    events.function('camera.poses', () => {
        return activeTrack()?.getPoses() ?? [];
    });

    events.function('camera.selectedDetails', () => {
        const set = sets[activeIndex];
        if (!set) return null;
        const frame = events.invoke('timeline.frame') as number;
        const poses = set.track.getPoses();
        const pose = poses.filter(value => value.frame <= frame).sort((a, b) => b.frame - a.frame)[0] ?? poses[0];
        return {
            name: set.name,
            frame,
            fov: set.track.getPoseAt(frame)?.fov,
            lens: pose?.lens ?? {},
            worldScale: set.worldScale
        };
    });

    events.function('camera.selectedPose', () => {
        return activeTrack()?.getPoseAt(events.invoke('timeline.frame')) ?? null;
    });

    events.function('camera.scenePoses', () => {
        const frame = events.invoke('timeline.frame');
        const poses = sets.map(set => set.track.getPoseAt(frame)).filter(pose => !!pose);
        if (lookThrough && freeView) poses.push(freeView);
        return poses;
    });

    events.function('camera.sets', () => {
        return {
            names: sets.map(set => set.name),
            active: activeIndex,
            lookThrough,
            view: viewIndex
        };
    });

    events.on('camera.selectSet', (index: number) => {
        if (index < 0 || index >= sets.length || index === activeIndex) return;
        activeIndex = index;
        events.fire('track.keysLoaded');
        notify();
    });

    events.on('camera.setWorldScale', (value: number) => {
        const set = sets[activeIndex];
        if (!set || !Number.isFinite(value) || value <= 0 || value === set.worldScale) return;
        set.track.scaleWorld(value / set.worldScale);
        set.worldScale = value;
        events.fire('track.keysLoaded');
        notify();
    });

    // the single camera formats (inria json, colmap images.txt) import one set
    events.on('camera.loadPoses', (poses: Pose[]) => {
        loadSets([{ name: 'camera', poses }]);
    });

    // an alembic file can hold several cameras, one set each
    events.on('camera.loadSets', (incoming: Array<{ name: string, poses: Pose[] }>) => {
        loadSets(incoming);
    });

    // selecting a set looks through it; -1 returns to the free camera, which
    // only changes the view - key editing keeps targeting the selected set
    events.on('camera.setActiveSet', (index: number) => {
        const next = index >= 0 && index < sets.length ? index : -1;
        const nextLookThrough = next >= 0;

        if (nextLookThrough === lookThrough && next === viewIndex) {
            return;
        }

        if (nextLookThrough && !lookThrough) {
            freeView = events.invoke('camera.getPose') as View;
        }

        if (next >= 0) {
            activeIndex = next;
        }
        viewIndex = next;
        lookThrough = nextLookThrough;
        updateActivation();

        if (lookThrough) {
            applyActivePose();
            // the timeline shows the keys of the set that is now selected
            events.fire('track.keysLoaded');
        } else if (freeView) {
            events.fire('camera.setPose', {
                position: new Vec3(freeView.position.x, freeView.position.y, freeView.position.z),
                target: new Vec3(freeView.target.x, freeView.target.y, freeView.target.z),
                fov: freeView.fov
            }, 0);
            freeView = null;
        }

        notify();
    });

    // free camera -> each set -> free camera
    events.on('camera.cycleSets', () => {
        if (sets.length === 0) {
            return;
        }
        const current = lookThrough ? viewIndex : -1;
        const next = current + 1;
        events.fire('camera.setActiveSet', next < sets.length ? next : -1);
    });

    events.on('scene.clear', () => {
        sets.forEach(set => set.track.destroy());
        sets.length = 0;
        activeIndex = -1;
        viewIndex = -1;
        lookThrough = false;
        freeView = null;
        events.fire('track.keysCleared');
        notify();
    });

    // Serialization

    events.function('docSerialize.poseSets', (): any[] => {
        const pack3 = (v: Vec3) => [v.x, v.y, v.z];

        return sets
        .filter(set => set.track.getPoses().length > 0)
        .map(set => ({
            name: set.name,
            worldScale: set.worldScale,
            poses: set.track.getPoses().map((pose) => {
                return {
                    name: pose.name,
                    frame: pose.frame,
                    position: pack3(pose.position),
                    target: pack3(pose.target),
                    fov: pose.fov,
                    lens: pose.lens,
                    rotation: pose.rotation ? [pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w] : undefined
                };
            })
        }));
    });

    events.function('docDeserialize.poseSets', (poseSets: any[], documentCameraFov?: number) => {
        if (!poseSets || poseSets.length === 0) {
            return;
        }

        const fps = events.invoke('timeline.frameRate');
        const defaultFov = documentCameraFov ?? events.invoke('camera.fov') ?? 60;

        const loaded = poseSets.map((set: any) => {
            return {
                name: set.name ?? 'camera',
                worldScale: set.worldScale ?? 1,
                poses: (set.poses ?? []).map((docPose: any, index: number) => {
                    return {
                        name: docPose.name,
                        frame: docPose.frame ?? (index * fps),
                        position: new Vec3(docPose.position),
                        target: new Vec3(docPose.target),
                        fov: docPose.fov ?? defaultFov,
                        lens: docPose.lens,
                        rotation: docPose.rotation ? new Quat(docPose.rotation) : undefined
                    };
                })
            };
        });

        // the document also restores its saved view, so do not look through a
        // camera on load - the picker is one click away
        loadSets(loaded);
    });
};

export { registerCameraPosesEvents, CameraAnimTrack, Pose, CameraSets, CameraLens };
