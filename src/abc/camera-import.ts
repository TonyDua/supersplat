/**
 * Turn the camera animation of an Alembic archive into editor camera poses.
 *
 * A camera in an Alembic file is a transform object with a camera shape
 * underneath it, so the world transform of a sample is the chain of the
 * ancestor transforms at that sample time. Alembic follows Maya's camera
 * convention: the lens looks down the local -Z axis, and the world is Y-up,
 * so the poses map onto the editor's space without an axis swap.
 */

import { Vec3 } from 'playcanvas';

import type { Pose } from '../camera-poses';
import { AbcArchive, AbcObject, TimeSampling } from './archive';
import { XformSchema, asCamera, asXform, identityMatrix, multiply } from './schema';

// the editor only needs a point along the view direction to aim the camera;
// this matches the distance the other camera importers use
const TARGET_DISTANCE = 10;

// fallback when a file is not uniformly sampled and carries no frame rate
const DEFAULT_FRAME_RATE = 24;

type AbcCameraImport = {
    poses: Pose[];
    frameRate: number;
    cameraName: string;
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
    let result = identityMatrix();
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
 * Read the first camera of an archive as editor poses, one per sample.
 *
 * Sample times become frames starting at zero, at the frame rate of the file's
 * uniform time sampling, so playback matches the original shot length.
 * Non-uniform files fall back to 24 fps.
 */
const importAbcCamera = (buffer: ArrayBuffer): AbcCameraImport => {
    const archive = AbcArchive.open(buffer);
    const parents = new WeakMap<AbcObject, AbcObject>();
    const cameras = collectCameras(parents, archive.top, []);
    if (cameras.length === 0) {
        throw new AbcNoCameraError();
    }

    const cameraObject = cameras[0];
    const camera = asCamera(cameraObject)!;

    // the animated transform is the camera's own or its nearest parent that has
    // one, and its time sampling defines the frames
    let driver = asXform(cameraObject);
    for (let node = parents.get(cameraObject) ?? null; !driver && node; node = parents.get(node) ?? null) {
        const xform = asXform(node);
        if (xform && xform.numSamples > 0) {
            driver = xform;
        }
    }

    if (!driver || driver.numSamples === 0) {
        throw new Error('abc: the camera has no animated transform');
    }

    const uniform = driver.timeSampling.numSamplesPerCycle === 1 && driver.timeSampling.timePerCycle > 0;
    const frameRate = uniform ? 1 / driver.timeSampling.timePerCycle : DEFAULT_FRAME_RATE;
    const startTime = driver.timeSampling.timeOfSample(0);

    const poses: Pose[] = [];
    for (let i = 0; i < driver.numSamples; ++i) {
        const time = driver.timeSampling.timeOfSample(i);
        const matrix = worldMatrixAt(parents, cameraObject, time);

        const position = new Vec3(matrix[12], matrix[13], matrix[14]);
        // the lens looks down the local -Z axis, which is the negation of the
        // third row of the row vector rotation block
        const forward = new Vec3(-matrix[8], -matrix[9], -matrix[10]).normalize();

        const frame = Math.max(0, Math.round((time - startTime) * frameRate));
        const fov = camera.fieldOfViewAt(sampleIndexAt(camera, time));

        poses.push({
            name: `${cameraObject.name}@${frame}`,
            frame,
            position,
            target: position.clone().add(forward.mulScalar(TARGET_DISTANCE)),
            fov: fov ?? undefined
        });
    }

    // a repeated frame would overwrite its predecessor on the timeline
    const unique = poses.filter((pose, i) => i === 0 || pose.frame !== poses[i - 1].frame);

    return {
        poses: unique,
        frameRate,
        cameraName: cameraObject.name
    };
};

export { importAbcCamera, AbcCameraImport, AbcNoCameraError };
