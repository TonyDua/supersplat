import { Vec3 } from 'playcanvas';

import { CubicSpline } from './anim/spline';
import { AnimTrack } from './anim-track';
import { Events } from './events';

type Pose = {
    name: string,
    frame: number,
    position: Vec3,
    target: Vec3,
    fov?: number
};

/**
 * A named camera: one animation track plus the label the viewport picker
 * shows. A file may hold several cameras, so importing creates one set each.
 */
type CameraSet = {
    name: string,
    track: CameraAnimTrack
};

/** The viewport camera pose, as reported by `camera.getPose`. */
type View = {
    position: Vec3,
    target: Vec3,
    fov?: number
};

/** What the viewport picker needs to render the camera list. */
type CameraSets = {
    /** Set names, in picker order. */
    names: string[],
    /** Index of the set key editing targets, -1 when there are none. */
    active: number,
    /** Whether the viewport is looking through the active set. */
    lookThrough: boolean
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

    constructor(events: Events) {
        this.events = events;

        // Rebuild the curve when timeline parameters change
        events.on('timeline.frames', () => {
            this.rebuildSpline();
        });

        events.on('timeline.smoothness', () => {
            this.rebuildSpline();
        });

        events.on('timeline.loop', () => {
            this.rebuildSpline();
        });
    }

    get keys(): readonly number[] {
        return this.poses.map(p => p.frame);
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
            fov: source.fov
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
        this.events.fire('track.keysCleared');
    }

    snapshot(): Pose[] {
        return this.poses.map(p => ({
            name: p.name,
            frame: p.frame,
            position: p.position.clone(),
            target: p.target.clone(),
            fov: p.fov
        }));
    }

    restore(snapshot: unknown): void {
        this.poses = (snapshot as Pose[]).map(p => ({
            name: p.name,
            frame: p.frame,
            position: p.position.clone(),
            target: p.target.clone(),
            fov: p.fov
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

    private rebuildSpline(): void {
        const duration = this.events.invoke('timeline.frames');
        const smoothness = this.events.invoke('timeline.smoothness');
        const loop = this.events.invoke('timeline.loop');

        const orderedPoses = this.poses.slice()
        .filter(a => a.frame < duration)
        .sort((a, b) => a.frame - b.frame);

        const times = orderedPoses.map(p => p.frame);
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
            const spline = loop ?
                CubicSpline.fromPointsLooping(duration, times, points, smoothness) :
                CubicSpline.fromPoints(times, points, smoothness);
            const result: number[] = [];
            const pose = { position: new Vec3(), target: new Vec3(), fov: 0 };

            this.onTimelineChange = (frame: number) => {
                if (!this.active) return;
                spline.evaluate(frame, result);
                pose.position.set(result[0], result[1], result[2]);
                pose.target.set(result[3], result[4], result[5]);
                pose.fov = result[6];
                this.events.fire('camera.setPose', pose, 0);
            };
        } else if (orderedPoses.length === 1) {
            // a single key can't form a spline; hold its pose at every frame
            const p = orderedPoses[0];
            const pose = { position: p.position.clone(), target: p.target.clone(), fov: p.fov };

            this.onTimelineChange = () => {
                if (!this.active) return;
                this.events.fire('camera.setPose', pose, 0);
            };
        } else {
            this.onTimelineChange = null;
        }

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

    // whether the viewport is looking through the active set
    let lookThrough = false;

    // the free camera pose captured when look-through began, restored on exit
    let freeView: View | null = null;

    const activeTrack = () => {
        return activeIndex >= 0 && activeIndex < sets.length ? sets[activeIndex].track : null;
    };

    const updateActivation = () => {
        sets.forEach((set, i) => {
            set.track.active = lookThrough && i === activeIndex;
        });
    };

    const notify = () => {
        events.fire('camera.sets', {
            names: sets.map(set => set.name),
            active: activeIndex,
            lookThrough
        } satisfies CameraSets);
    };

    // drive the viewport camera from the active set at the current frame
    const applyActivePose = () => {
        activeTrack()?.evaluate(events.invoke('timeline.frame') as number);
    };

    // only the set being looked through follows playback and scrubbing
    const onTimelineChange = (frame: number) => {
        if (lookThrough) {
            activeTrack()?.evaluate(frame);
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
     * Replace every set. Imported cameras take over the viewport so that an
     * import behaves like the single camera track it replaces; loading a
     * document keeps the free view it restored instead.
     */
    const loadSets = (incoming: Array<{ name: string, poses: Pose[] }>, lookThroughFirst: boolean) => {
        sets.length = 0;
        const taken = new Set<string>();
        incoming.forEach((entry) => {
            const track = new CameraAnimTrack(events);
            track.loadPoses(entry.poses);
            const name = uniqueName(entry.name, taken);
            taken.add(name);
            sets.push({ name, track });
        });

        if (lookThroughFirst && sets.length > 0) {
            // remember where the free camera was before a camera takes over
            freeView = lookThrough ? freeView : events.invoke('camera.getPose') as View;
            activeIndex = 0;
            lookThrough = true;
        } else {
            activeIndex = sets.length > 0 ? 0 : -1;
            lookThrough = false;
        }

        updateActivation();
        if (lookThrough) {
            applyActivePose();
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

    events.function('camera.sets', () => {
        return {
            names: sets.map(set => set.name),
            active: activeIndex,
            lookThrough
        };
    });

    // the single camera formats (inria json, colmap images.txt) import one set
    events.on('camera.loadPoses', (poses: Pose[]) => {
        loadSets([{ name: 'camera', poses }], true);
    });

    // an alembic file can hold several cameras, one set each
    events.on('camera.loadSets', (incoming: Array<{ name: string, poses: Pose[] }>) => {
        loadSets(incoming, true);
    });

    // selecting a set looks through it; -1 returns to the free camera, which
    // only changes the view - key editing keeps targeting the selected set
    events.on('camera.setActiveSet', (index: number) => {
        const next = index >= 0 && index < sets.length ? index : -1;
        const nextLookThrough = next >= 0;

        if (nextLookThrough === lookThrough && next === activeIndex) {
            return;
        }

        if (nextLookThrough && !lookThrough) {
            freeView = events.invoke('camera.getPose') as View;
        }

        if (next >= 0) {
            activeIndex = next;
        }
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
        const current = lookThrough ? activeIndex : -1;
        const next = current + 1;
        events.fire('camera.setActiveSet', next < sets.length ? next : -1);
    });

    events.on('scene.clear', () => {
        sets.length = 0;
        activeIndex = -1;
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
            poses: set.track.getPoses().map((pose) => {
                return {
                    name: pose.name,
                    frame: pose.frame,
                    position: pack3(pose.position),
                    target: pack3(pose.target),
                    fov: pose.fov
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
                poses: (set.poses ?? []).map((docPose: any, index: number) => {
                    return {
                        name: docPose.name,
                        frame: docPose.frame ?? (index * fps),
                        position: new Vec3(docPose.position),
                        target: new Vec3(docPose.target),
                        fov: docPose.fov ?? defaultFov
                    };
                })
            };
        });

        // the document also restores its saved view, so do not look through a
        // camera on load - the picker is one click away
        loadSets(loaded, false);
    });
};

export { registerCameraPosesEvents, CameraAnimTrack, Pose, CameraSets };
