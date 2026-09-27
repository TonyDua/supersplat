/**
 * Readers for the two Alembic schemas an editor import needs: transforms and
 * cameras. Both follow the official AbcGeom semantics so results agree with
 * Maya, Houdini and the Alembic command line tools.
 *
 * Matrices use the row vector convention of Imath's M44d: a point is a row
 * vector and is transformed as `p * M`, which puts translation in row 3 and
 * makes the local axes of an object the rows of the rotation block.
 */

import { AbcObject, AbcProperty, TimeSampling } from './archive';

type Mat4 = Float64Array;

const identityMatrix = () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Row vector matrix product: (a * b)[i][j] = sum over k of a[i][k] * b[k][j],
 * matching Imath so op chains compose exactly like the official reader.
 */
const multiply = (a: Mat4, b: Mat4): Mat4 => {
    const result = new Float64Array(16);
    for (let i = 0; i < 4; ++i) {
        for (let j = 0; j < 4; ++j) {
            let sum = 0;
            for (let k = 0; k < 4; ++k) {
                sum += a[i * 4 + k] * b[k * 4 + j];
            }
            result[i * 4 + j] = sum;
        }
    }
    return result;
};

// XformOperationType, from AbcGeom/Foundation.h
const OP_SCALE = 0;
const OP_TRANSLATE = 1;
const OP_ROTATE = 2;
const OP_MATRIX = 3;
const OP_ROTATE_X = 4;
const OP_ROTATE_Y = 5;
const OP_ROTATE_Z = 6;

// channels consumed by each op type
const OP_CHANNELS = [3, 3, 4, 16, 1, 1, 1];

/**
 * Rotation of `angle` radians about an arbitrary axis, as Imath builds it.
 */
const axisAngle = (x: number, y: number, z: number, angle: number): Mat4 => {
    const len = Math.hypot(x, y, z) || 1;
    const ux = x / len;
    const uy = y / len;
    const uz = z / len;
    const s = Math.sin(angle);
    const c = Math.cos(angle);
    const t = 1 - c;

    return new Float64Array([
        ux * ux * t + c, ux * uy * t + uz * s, ux * uz * t - uy * s, 0,
        ux * uy * t - uz * s, uy * uy * t + c, uy * uz * t + ux * s, 0,
        ux * uz * t + uy * s, uy * uz * t - ux * s, uz * uz * t + c, 0,
        0, 0, 0, 1
    ]);
};

/**
 * Build the matrix of one op from its channel values.
 */
const opMatrix = (op: number, values: Float64Array, at: number): Mat4 => {
    switch (op) {
        case OP_TRANSLATE: {
            const m = identityMatrix();
            m[12] = values[at];
            m[13] = values[at + 1];
            m[14] = values[at + 2];
            return m;
        }
        case OP_SCALE: {
            const m = new Float64Array(16);
            m[0] = values[at];
            m[5] = values[at + 1];
            m[10] = values[at + 2];
            m[15] = 1;
            return m;
        }
        case OP_MATRIX: {
            const m = new Float64Array(16);
            for (let i = 0; i < 16; ++i) {
                m[i] = values[at + i];
            }
            return m;
        }
        case OP_ROTATE_X:
            return axisAngle(1, 0, 0, values[at] * Math.PI / 180);
        case OP_ROTATE_Y:
            return axisAngle(0, 1, 0, values[at] * Math.PI / 180);
        case OP_ROTATE_Z:
            return axisAngle(0, 0, 1, values[at] * Math.PI / 180);
        case OP_ROTATE:
            return axisAngle(values[at], values[at + 1], values[at + 2], values[at + 3] * Math.PI / 180);
        default:
            throw new Error(`abc: unknown transform op ${op}`);
    }
};

/**
 * An `AbcGeom_Xform_v3` object. Recent exports store a chain of ops with
 * their values; older ones store a matrix, so both layouts are supported.
 */
class XformSchema {
    private readonly opsProperty: AbcProperty | null;
    private readonly valsProperty: AbcProperty | null;
    private readonly inheritsProperty: AbcProperty | null;
    private readonly sampleProperty: AbcProperty;

    constructor(readonly property: AbcProperty) {
        const nested = (name: string) => property.properties.find(p => p.header.name === name) ?? null;
        const compound = property.header.propertyType === 'compound';

        this.opsProperty = compound ? nested('.ops') : null;
        this.valsProperty = compound ? nested('.vals') : null;
        this.inheritsProperty = compound ? nested('.inherits') : null;

        // whatever carries the samples defines the sample times
        this.sampleProperty = this.valsProperty ?? this.opsProperty ?? property;
    }

    get schema(): string {
        return this.property.header.metaData.schema ?? 'AbcGeom_Xform_v3';
    }

    get numSamples(): number {
        return this.sampleProperty.header.numSamples;
    }

    get timeSampling(): TimeSampling {
        return this.sampleProperty.header.timeSampling;
    }

    /**
     * Whether the object inherits its parent's transform. Only recent exports
     * write this; missing means inherit, which is the Alembic default.
     */
    inheritsAt(index: number): boolean {
        if (!this.inheritsProperty) {
            return true;
        }
        const values = this.inheritsProperty.readNumbers(index);
        return values ? values[0] !== 0 : true;
    }

    matrixAt(index: number): Mat4 {
        // legacy layout: the transform is written as a matrix
        if (!this.opsProperty || !this.valsProperty) {
            const matrix = this.property.readNumbers(index);
            return matrix && matrix.length >= 16 ? matrix : identityMatrix();
        }

        const ops = this.opsProperty.readNumbers(index);
        const vals = this.valsProperty.header.propertyType === 'array' ?
            this.valsProperty.readArrayNumbers(index) : this.valsProperty.readNumbers(index);

        if (!ops || !vals) {
            return identityMatrix();
        }

        // ops apply in order, each pre-multiplying the accumulated matrix; the
        // stored byte packs the op type in the high nibble and its hint in the
        // low one
        let result: Mat4 = identityMatrix();
        let at = 0;
        for (let i = 0; i < ops.length; ++i) {
            const op = ops[i] >> 4;
            if (op < 0 || op >= OP_CHANNELS.length || at + OP_CHANNELS[op] > vals.length) {
                throw new Error(`abc: transform op ${op} (${ops[i]}) is missing channel values`);
            }
            result = multiply(opMatrix(op, vals, at), result);
            at += OP_CHANNELS[op];
        }
        return result;
    }
}

/**
 * An `AbcGeom_Camera_v1` object. The lens parameters live in the `.geom`
 * compound: `.core` holds sixteen doubles whose meaning is fixed by the
 * schema, and the optional film back ops transform the film back.
 */
class CameraSchema {
    private readonly coreProperty: AbcProperty;
    private readonly coreValues: Float64Array | null;

    constructor(readonly property: AbcProperty) {
        const core = property.properties.find(p => p.header.name === '.core');
        if (!core) {
            throw new Error('abc: camera is missing its .core property');
        }
        this.coreProperty = core;
        // lens parameters are normally constant, so one read covers them all
        this.coreValues = core.readNumbers(0);
    }

    get numSamples(): number {
        return this.coreProperty.header.numSamples;
    }

    get timeSampling(): TimeSampling {
        return this.coreProperty.header.timeSampling;
    }

    coreAt(index: number): Float64Array | null {
        return this.coreProperty.header.numSamples === 1 ? this.coreValues : this.coreProperty.readNumbers(index);
    }

    lensAt(index: number) {
        const core = this.coreAt(index);
        if (!core || core.length < 16) return {};
        return {
            focalLength: core[0],
            filmBackWidth: core[1] * 10,
            filmBackHeight: core[3] * 10,
            filmOffsetX: core[2] * 10,
            filmOffsetY: core[4] * 10,
            lensSqueeze: core[5],
            fStop: core[10],
            focusDistance: core[11],
            nearClip: core[14],
            farClip: core[15]
        };
    }

    /**
     * Horizontal field of view in degrees, as the official reader computes it:
     * Alembic stores the film aperture in centimetres while the focal length is
     * in millimetres, hence the factor of ten.
     */
    fieldOfViewAt(index: number): number | null {
        const core = this.coreAt(index);
        if (!core || core.length < 4 || core[0] === 0) {
            return null;
        }
        const focalLength = core[0];
        const horizontalAperture = core[1];
        return 2 * Math.atan(horizontalAperture * 10 / (2 * focalLength)) * 180 / Math.PI;
    }
}

/**
 * True when the object is a camera: an `AbcGeom_Camera_v1` shape, recognised
 * by its `.geom` compound carrying a `.core` property.
 */
const asCamera = (object: AbcObject): CameraSchema | null => {
    const geom = object.getProperty('.geom');
    if (!geom || geom.header.propertyType !== 'compound' || !geom.properties.some(p => p.header.name === '.core')) {
        return null;
    }
    return new CameraSchema(geom);
};

const asXform = (object: AbcObject): XformSchema | null => {
    const xform = object.getProperty('.xform');
    return xform ? new XformSchema(xform) : null;
};

export { CameraSchema, XformSchema, asCamera, asXform, identityMatrix, multiply, Mat4 };
