/**
 * Turn the camera animation of an Alembic archive into editor camera poses.
 *
 * A camera in an Alembic file is a transform object with a camera shape
 * underneath it, so the world transform of a sample is the chain of the
 * ancestor transforms at that sample time. Alembic follows Maya's camera
 * convention: the lens looks down the local -Z axis, and the world is Y-up,
 * so the poses map onto the editor's space without an axis swap.
 */

import { Mat4 as PcMat4, Quat, Vec3 } from 'playcanvas';

import type { Pose } from '../camera-poses';
import { AbcArchive, AbcObject, TimeSampling } from './archive';
import { XformSchema, asCamera, asXform, identityMatrix, multiply, Mat4 } from './schema';

// the editor only needs a point along the view direction to aim the camera;
// this matches the distance the other camera importers use
const TARGET_DISTANCE = 10;

// fallback when a file is not uniformly sampled and carries no frame rate
const DEFAULT_FRAME_RATE = 24;

/** One camera of an archive: the name shown in the picker and its poses. */
type AbcCameraSet = {
    name: string,
    poses: Pose[]
};

type AbcCameraImport = {
    cameras: AbcCameraSet[];
    frameRate: number;
    startFrame: number;
};

/**
 * Thrown when an archive holds no camera, so callers can show a translated
 * message instead of the parser's own wording.
 */
class AbcNoCameraError extends Error {
    constructor() {
        super('abc: no camera found in this file');
        this.name = 'AbcNoCameraError';
    }
}

/** Anything sampled over time: a transform or the lens parameters. */
type Sampled = {
    readonly numSamples: number;
    readonly timeSampling: TimeSampling;
};

/**
 * Index of the sample at or just before `time`. Sample times are monotonic, so
 * a binary search is safe for every sampling mode.
 */
const sampleIndexAt = (sampled: Sampled, time: number) => {
    const last = sampled.numSamples - 1;
    if (last <= 0) {
        return 0;
    }
    if (time <= sampled.timeSampling.timeOfSample(0)) {
        return 0;
    }
    if (time >= sampled.timeSampling.timeOfSample(last)) {
        return last;
    }

    let low = 0;
    let high = last;
    while (low + 1 < high) {
        const mid = (low + high) >> 1;
        if (sampled.timeSampling.timeOfSample(mid) <= time) {
            low = mid;
        } else {
            high = mid;
        }
    }
    return low;
};

/**
 * World matrix of an object at `time`, walking up the ancestor chain until a
 * node stops inheriting its parent's transform.
 */
const worldMatrixAt = (parents: WeakMap<AbcObject, AbcObject>, object: AbcObject, time: number) => {
    let result: Mat4 = identityMatrix();
    let first = true;

    for (let node: AbcObject | null = object; node; node = parents.get(node) ?? null) {
        const xform = asXform(node);
        if (!xform || xform.numSamples === 0) {
            continue;
        }

        const index = sampleIndexAt(xform, time);
        // row vector convention: the leaf transform applies first, so ancestors
        // accumulate on the right
        result = first ? xform.matrixAt(index) : multiply(result, xform.matrixAt(index));
        first = false;

        if (!xform.inheritsAt(index)) {
            break;
        }
    }

    return result;
};

// object parents are not stored, so remember them while walking the tree
const collectCameras = (parents: WeakMap<AbcObject, AbcObject>, object: AbcObject, out: AbcObject[]) => {
    for (const child of object.children) {
        parents.set(child, object);
        collectCameras(parents, child, out);
    }
    if (asCamera(object)) {
        out.push(object);
    }
    return out;
};

/**
 * Display name for a camera: its own object name, or the parent transform's
 * when the camera is a maya style `...Shape` child.
 */
const asCameraName = (object: AbcObject, parents: WeakMap<AbcObject, AbcObject>) => {
    const parent = parents.get(object);
    return object.name.endsWith('Shape') && parent ? parent.name : object.name;
};

/**
 * Read every camera of an archive as editor poses, one per sample.
 *
 * Sample times retain their absolute shot frame at the file's frame rate.
 * Non-uniform files fall back to 24 fps.
 */
const importAbcCameras = (buffer: ArrayBuffer): AbcCameraImport => {
    const archive = AbcArchive.open(buffer);
    const parents = new WeakMap<AbcObject, AbcObject>();
    const cameraObjects = collectCameras(parents, archive.top, []);
    if (cameraObjects.length === 0) {
        throw new AbcNoCameraError();
    }

    // the camera's own transform drives the samples, or its nearest parent that
    // has one when the transform sits above the camera shape
    const driverOf = (object: AbcObject) => {
        let driver: XformSchema | null = null;
        for (let node: AbcObject | null = object; node; node = parents.get(node) ?? null) {
            const xform = asXform(node);
            if (xform && xform.numSamples > 1 && (!driver || xform.numSamples > driver.numSamples)) {
                driver = xform;
            }
        }
        return driver;
    };

    const drivers = cameraObjects.map(driverOf);
    const cameraSchemas = cameraObjects.map(object => asCamera(object)!);
    const samplings = cameraSchemas.map((camera, index): Sampled => {
        const driver = drivers[index];
        return driver && driver.numSamples > camera.numSamples ? driver : camera;
    });

    // every camera in a shot shares its time base, so the first one that
    // animates defines both the frame rate and the frame numbering
    const first = samplings.find(sampled => sampled.numSamples > 1) ?? samplings[0];
    const uniform = first.timeSampling.numSamplesPerCycle === 1 && first.timeSampling.timePerCycle > 0;
    const frameRate = uniform ? 1 / first.timeSampling.timePerCycle : DEFAULT_FRAME_RATE;
    const cameras = cameraObjects.map((cameraObject, index) => {
        const camera = cameraSchemas[index];
        const sampling = samplings[index];

        const poses: Pose[] = [];
        for (let i = 0; i < sampling.numSamples; ++i) {
            const time = sampling.timeSampling.timeOfSample(i);
            const matrix = worldMatrixAt(parents, cameraObject, time);

            const position = new Vec3(matrix[12], matrix[13], matrix[14]);
            // Imath's row-vector matrix has the same flat storage as the
            // transposed column-vector matrix expected by PlayCanvas.
            const rotationMatrix = new PcMat4();
            rotationMatrix.data.set(matrix);
            const rotation = new Quat().setFromMat4(rotationMatrix).normalize();
            // the lens looks down the local -Z axis, which is the negation of
            // the third row of the row vector rotation block
            const forward = new Vec3(-matrix[8], -matrix[9], -matrix[10]).normalize();

            const frame = Math.round(time * frameRate);
            const fov = camera.fieldOfViewAt(sampleIndexAt(camera, time));
            const lens = camera.lensAt(sampleIndexAt(camera, time));

            poses.push({
                name: `${cameraObject.name}@${frame}`,
                frame,
                position,
                target: position.clone().add(forward.mulScalar(TARGET_DISTANCE)),
                fov: fov ?? undefined,
                lens,
                rotation
            });
        }

        // a repeated frame would overwrite its predecessor on the timeline
        const unique = poses.filter((pose, i) => i === 0 || pose.frame !== poses[i - 1].frame);

        return {
            // maya writes the camera node and a `...Shape` child; the node name
            // is the one an artist recognises
            name: asCameraName(cameraObject, parents),
            poses: unique
        };
    });

    const startFrame = cameras.reduce((start, camera) => {
        return camera.poses.reduce((value, pose) => Math.min(value, pose.frame), start);
    }, Infinity);
    if (!Number.isFinite(startFrame)) throw new Error('abc: camera has no samples');
    return { cameras, frameRate, startFrame };
};

export { importAbcCameras, AbcCameraImport, AbcNoCameraError };
