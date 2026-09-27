import {
    ChunkData,
    ChunkLayer,
    ChunkSource,
    ChunkSourceMetadata,
    ReadRequest,
    createChunkDataPool
} from '@playcanvas/splat-transform';

const SH_C0 = 0.28209479177387814;
const geometricLayout = {
    stride: 32,
    fields: {
        rotation: { byteOffset: 0, components: 4, type: 'float32' as const },
        scale: { byteOffset: 16, components: 3, type: 'float32' as const },
        opacity: { byteOffset: 28, components: 1, type: 'float32' as const }
    }
};
const colorLayout = {
    stride: 12,
    fields: { dc: { byteOffset: 0, components: 3, type: 'float32' as const } }
};

/**
 * A point cloud has positions (and often RGB), but no Gaussian covariance.
 * Supply a small isotropic footprint so the existing viewport renderer can
 * display it. The file-backed parent remains the authority for source values.
 */
class PointCloudSource implements ChunkSource {
    readonly meta: ChunkSourceMetadata;
    private readonly pool;

    private constructor(private readonly parent: ChunkSource, private readonly radius: number) {
        const missingGeometric = !parent.meta.availableLayers.has('geometric');
        const missingColor = !parent.meta.availableLayers.has('color');
        this.meta = {
            ...parent.meta,
            shBands: missingColor ? 0 : parent.meta.shBands,
            availableLayers: new Set<ChunkLayer>([...parent.meta.availableLayers, 'geometric', 'color']),
            layouts: {
                ...parent.meta.layouts,
                ...(missingGeometric ? { geometric: geometricLayout } : {}),
                ...(missingColor ? { color: colorLayout } : {})
            }
        };
        this.pool = createChunkDataPool({ chunkSize: parent.meta.chunkSize,
            maxPooledBytes: parent.meta.chunkSize * (parent.meta.layouts.other?.stride ?? 0) });
    }

    static async create(parent: ChunkSource): Promise<PointCloudSource> {
        if (parent.meta.numGaussians === 0) throw new Error('Point cloud has no vertices');
        // A sparse read estimates point spacing without materializing the PLY.
        // The viewport's Point Size control can then refine the result.
        const count = Math.min(64, parent.meta.numGaussians);
        const pool = createChunkDataPool({ chunkSize: parent.meta.chunkSize, maxPooledBytes: 0 });
        const position = pool.acquire('position', parent.meta.layouts.position, count);
        try {
            const indices = new Uint32Array(count);
            for (let i = 0; i < count; ++i) {
                indices[i] = Math.floor(i * (parent.meta.numGaussians - 1) / Math.max(1, count - 1));
            }
            await parent.read({ indices, indexOffset: 0, count, position });
            const values = new Float32Array(position.data);
            const min = [Infinity, Infinity, Infinity];
            const max = [-Infinity, -Infinity, -Infinity];
            for (let i = 0; i < count; ++i) {
                for (let axis = 0; axis < 3; ++axis) {
                    const value = values[i * 3 + axis];
                    if (Number.isFinite(value)) {
                        min[axis] = Math.min(min[axis], value);
                        max[axis] = Math.max(max[axis], value);
                    }
                }
            }
            const extent = Math.max(...max.map((value, axis) => value - min[axis]));
            const radius = Number.isFinite(extent) && extent > 0 ?
                Math.max(1e-6, extent / Math.sqrt(parent.meta.numGaussians) * 0.6) : 0.001;
            return new PointCloudSource(parent, radius);
        } finally {
            position.release();
            pool.destroy();
        }
    }

    async read(request: ReadRequest): Promise<void> {
        const count = 'indices' in request ? request.count :
            Math.min(this.meta.chunkSize, this.meta.numGaussians - request.chunkIndex * this.meta.chunkSize);
        const synthGeometric = !!request.geometric && !this.parent.meta.availableLayers.has('geometric');
        const synthColor = !!request.color && !this.parent.meta.availableLayers.has('color');
        const other = (synthColor || synthGeometric) && this.parent.meta.availableLayers.has('other') ?
            request.other ?? this.pool.acquire('other', this.parent.meta.layouts.other, count) : request.other;
        try {
            const target = {
                position: request.position,
                geometric: synthGeometric ? undefined : request.geometric,
                color: synthColor ? undefined : request.color,
                other
            };
            if ('indices' in request) {
                await this.parent.read({ ...target, indices: request.indices, indexOffset: request.indexOffset, count });
            } else {
                await this.parent.read({ ...target, chunkIndex: request.chunkIndex });
            }
            if (synthGeometric) this.fillGeometric(request.geometric, other, count);
            if (synthColor) this.fillColor(request.color, other, count);
        } finally {
            if (other && other !== request.other) other.release();
        }
    }

    private channel(other: ChunkData | undefined, view: DataView | undefined,
        name: string, row: number, fallback: number): number {
        const field = other?.fields[name];
        if (!field || !view) return fallback;
        const offset = row * other.stride + field.byteOffset;
        const raw = field.type === 'uint32' ? view.getUint32(offset, true) : view.getFloat32(offset, true);
        return Math.max(0, Math.min(1, field.type === 'uint32' || raw > 1 ? raw / 255 : raw));
    }

    private fillGeometric(output: ChunkData, other: ChunkData | undefined, count: number): void {
        const data = new Float32Array(output.data);
        const view = other ? new DataView(other.data) : undefined;
        const logRadius = Math.log(this.radius);
        for (let i = 0; i < count; ++i) {
            const base = i * 8;
            data[base] = 1;
            data[base + 1] = 0;
            data[base + 2] = 0;
            data[base + 3] = 0;
            data[base + 4] = logRadius;
            data[base + 5] = logRadius;
            data[base + 6] = logRadius;
            const alpha = this.channel(other, view, 'alpha', i, 1);
            data[base + 7] = alpha <= 0 ? -Infinity : alpha >= 1 ? Infinity : Math.log(alpha / (1 - alpha));
        }
    }

    private fillColor(output: ChunkData, other: ChunkData | undefined, count: number): void {
        const data = new Float32Array(output.data);
        const view = other ? new DataView(other.data) : undefined;
        for (let i = 0; i < count; ++i) {
            const base = i * 3;
            data[base] = (this.channel(other, view, 'red', i, 1) - 0.5) / SH_C0;
            data[base + 1] = (this.channel(other, view, 'green', i, 1) - 0.5) / SH_C0;
            data[base + 2] = (this.channel(other, view, 'blue', i, 1) - 0.5) / SH_C0;
        }
    }

    async close(): Promise<void> {
        this.pool.destroy();
        await this.parent.close();
    }
}

export { PointCloudSource };
