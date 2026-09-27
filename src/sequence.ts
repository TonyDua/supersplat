import { Asset, Quat } from 'playcanvas';

import { EditorSplatResource } from './editor-splat-resource';
import { Events } from './events';
import { loadSplatSource, MappedReadFileSystem } from './io';
import { Scene } from './scene';
import { Splat } from './splat';

type FrameData = {
    asset: Asset;
    rotation: Quat;
};

type CacheStatus = {
    available: boolean;
    enabled: boolean;
    loading: boolean;
    capacity: number;
    cached: number;
    total: number;
    ranges: Array<[number, number]>;
};

// A source of animation frames. getFrame produces a ready gsplat Asset (plus the
// orientation to apply when the persistent splat is first created) for a frame.
interface FrameSource {
    readonly frameCount: number;
    readonly startFrame: number;
    getFrame(frame: number): Promise<FrameData>;
    setCacheEnabled(value: boolean, focusFrame?: number): void;
    prefetch(frame: number): void;
    cacheStatus(): CacheStatus;
    destroy(): void;
}

// PLY sequence: a set of frameNNNN.ply files, sorted by trailing frame number.
class PlyFrameSource implements FrameSource {
    private files: File[];
    private scene: Scene;
    readonly startFrame: number;
    private frameNumbers: number[];
    private cache = new Map<number, FrameData>();
    private inflight = new Map<number, Promise<FrameData>>();
    private cacheEnabled = false;
    private caching = false;
    private disposed = false;
    private focusIndex = 0;
    private readonly cacheCapacity = 100;
    private readonly onCacheStatus: (status: CacheStatus) => void;

    constructor(files: File[], scene: Scene, onCacheStatus: (status: CacheStatus) => void) {
        this.scene = scene;
        this.onCacheStatus = onCacheStatus;
        const key = (f: File) => Number(f.name.match(/(\d+)(?:\.compressed)?\.ply$/i)?.[1]);
        this.files = files.slice().sort((a, b) => {
            return key(a) - key(b);
        });
        this.frameNumbers = this.files.map(key);
        this.startFrame = this.frameNumbers[0];
    }

    get frameCount() {
        return this.frameNumbers[this.frameNumbers.length - 1] - this.startFrame + 1;
    }

    async getFrame(frame: number): Promise<FrameData> {
        // Missing frames hold the preceding sample, as in a DCC timeline.
        const index = this.indexAt(frame);
        const cached = this.cache.get(index);
        if (cached) return cached;
        const pending = this.inflight.get(index);
        if (pending) return pending;
        const promise = this.loadFrame(index);
        this.inflight.set(index, promise);
        try {
            const data = await promise;
            if (this.cacheEnabled && !this.disposed) {
                // The cache owns one resource reference; the displayed Splat
                // owns another. Swapping frames therefore keeps cached GPU data.
                const resource = data.asset.resource as EditorSplatResource;
                if (this.cache.size >= this.cacheCapacity) this.evictFarthest();
                resource.acquire();
                this.cache.set(index, data);
                this.onCacheStatus(this.cacheStatus());
            }
            return data;
        } finally {
            this.inflight.delete(index);
        }
    }

    private indexAt(frame: number): number {
        let index = this.frameNumbers.length - 1;
        while (index > 0 && this.frameNumbers[index] > frame) index--;
        return Math.max(0, index);
    }

    private evictFarthest(): void {
        const count = this.files.length;
        let victim = -1;
        let farthest = -1;
        for (const index of this.cache.keys()) {
            const distance = (index - this.focusIndex + count) % count;
            if (distance > farthest) {
                farthest = distance;
                victim = index;
            }
        }
        const data = this.cache.get(victim);
        if (!data) return;
        this.cache.delete(victim);
        const resource = data.asset.resource as EditorSplatResource;
        if (resource.release()) {
            data.asset.registry?.remove(data.asset);
            data.asset.unload();
        }
    }

    private async loadFrame(index: number): Promise<FrameData> {
        const file = this.files[index];
        const fileSystem = new MappedReadFileSystem();
        fileSystem.addFile(file.name, file);

        // skipReorder: animation frames prioritise load speed over morton ordering
        const { source, transform } = await loadSplatSource(file.name, fileSystem, true);
        const resource = await EditorSplatResource.create(this.scene.graphicsDevice, source);
        const asset = this.scene.assetLoader.createGSplatAsset(resource, file.name);
        return { asset, rotation: transform.rotation };
    }

    cacheStatus(): CacheStatus {
        return {
            available: true,
            enabled: this.cacheEnabled,
            loading: this.caching,
            capacity: this.cacheCapacity,
            cached: this.cache.size,
            total: this.files.length,
            ranges: [...this.cache.keys()].map(index => [
                this.frameNumbers[index],
                (this.frameNumbers[index + 1] ?? (this.startFrame + this.frameCount)) - 1
            ])
        };
    }

    setCacheEnabled(value: boolean, focusFrame = this.startFrame) {
        if (this.cacheEnabled === value) return;
        this.cacheEnabled = value;
        if (value) {
            this.prefetch(focusFrame);
        } else {
            for (const { asset } of this.cache.values()) {
                const resource = asset.resource as EditorSplatResource;
                if (resource.release()) {
                    asset.registry?.remove(asset);
                    asset.unload();
                }
            }
            this.cache.clear();
        }
        this.onCacheStatus(this.cacheStatus());
    }

    prefetch(frame: number): void {
        if (!this.cacheEnabled || this.disposed) return;
        this.focusIndex = this.indexAt(frame);
        this.preload();
    }

    private async preload() {
        if (this.caching) return;
        this.caching = true;
        this.onCacheStatus(this.cacheStatus());
        try {
            while (this.cacheEnabled && !this.disposed) {
                let index = -1;
                for (let offset = 0; offset < Math.min(this.files.length, this.cacheCapacity); ++offset) {
                    const candidate = (this.focusIndex + offset) % this.files.length;
                    if (!this.cache.has(candidate)) {
                        index = candidate;
                        break;
                    }
                }
                if (index < 0) break;
                const data = await this.getFrame(this.frameNumbers[index]);
                if (!this.cache.has(index)) {
                    // A cancelled preload may leave a frame with no owner.
                    setTimeout(() => {
                        const resource = data.asset.resource as EditorSplatResource;
                        if (!this.cache.has(index) && resource && resource.referenceCount === 0) {
                            data.asset.registry?.remove(data.asset);
                            data.asset.unload();
                        }
                    }, 0);
                }
            }
        } catch (error) {
            console.error(error);
        } finally {
            this.caching = false;
            this.onCacheStatus(this.cacheStatus());
        }
    }

    destroy() {
        this.disposed = true;
        this.setCacheEnabled(false);
    }
}

/**
 * Manages animation-sequence playback (PLY sequence).
 *
 * A sequence is rendered by a single persistent Splat element whose gaussian data
 * is swapped in place each frame (Splat.replaceData). This keeps the user's
 * whole-model transform and visual properties across frames and avoids the full
 * element teardown/recreate (and scene-reset prompt) of the previous approach.
 */
const registerSequenceEvents = (events: Events, scene: Scene) => {
    let source: FrameSource | null = null;
    let splat: Splat | null = null;
    let currentFrame = -1;
    let nextFrame = -1;
    let loadingPromise: Promise<Splat | null> | null = null;
    let viewportPump: Promise<void> | null = null;
    let offline = false;
    const emptyCacheStatus: CacheStatus = {
        available: false,
        enabled: false,
        loading: false,
        capacity: 100,
        cached: 0,
        total: 0,
        ranges: []
    };

    // apply a frame's data to the persistent splat, creating it on the first frame
    const applyFrame = async (data: FrameData) => {
        if (!splat) {
            splat = new Splat(data.asset, data.rotation);
            await scene.add(splat);
        } else {
            // in-place swap: preserves entity transform, visual props and selection
            await splat.replaceData(data.asset);
        }
    };

    // release an asset whose load was abandoned (source switched mid-load)
    const discardAsset = (asset: Asset) => {
        asset.registry?.remove(asset);
        asset.unload();
    };

    const setSource = (newSource: FrameSource) => {
        source?.destroy();
        source = newSource;
        currentFrame = -1;
        nextFrame = -1;

        // tear down the previous sequence's splat so the new source's first frame
        // is bound as an initial load (applying its rotation/name) rather than
        // swapped onto the old element
        if (splat) {
            splat.destroy();
            splat = null;
        }

        events.fire('timeline.setInputRange', 'ply', {
            start: source.startFrame,
            end: source.startFrame + source.frameCount - 1
        });
        events.fire('sequence.cacheStatus', source.cacheStatus());
    };

    // The viewport and the video renderer must never replace the same splat
    // concurrently. Keep one load/swap in flight and let the viewport coalesce
    // scrubbing requests while an offline render waits for the current swap.
    const loadFrame = async (frame: number): Promise<Splat | null> => {
        if (!source || frame < source.startFrame || frame >= source.startFrame + source.frameCount) {
            return null;
        }

        // An awaited swap clears this shared promise in its finally block.
        // eslint-disable-next-line no-unmodified-loop-condition
        while (loadingPromise) {
            await loadingPromise;
        }

        if (!source || frame < source.startFrame || frame >= source.startFrame + source.frameCount) {
            return null;
        }

        if (frame === currentFrame) {
            return null;
        }

        const loadSource = source;
        loadingPromise = (async () => {
            const data = await loadSource.getFrame(frame);
            if (source !== loadSource) {
                discardAsset(data.asset);
                return null;
            }
            await applyFrame(data);
            currentFrame = frame;
            return splat;
        })();
        try {
            return await loadingPromise;
        } finally {
            loadingPromise = null;
        }
    };

    const requestViewportFrame = (frame: number) => {
        if (offline || !source || frame < source.startFrame || frame >= source.startFrame + source.frameCount) return;
        nextFrame = frame;
        if (viewportPump) return;

        viewportPump = (async () => {
            // Offline mode can begin while this pump awaits a frame swap.
            // eslint-disable-next-line no-unmodified-loop-condition
            while (!offline && nextFrame !== -1) {
                const requested = nextFrame;
                nextFrame = -1;
                try {
                    await loadFrame(requested);
                    source?.prefetch(requested);
                } catch (error) {
                    console.error(error);
                }
            }
        })().finally(() => {
            viewportPump = null;
            if (!offline && nextFrame !== -1) requestViewportFrame(nextFrame);
        });
    };

    events.on('sequence.setPlyFrames', (files: File[]) => {
        setSource(new PlyFrameSource(files, scene, status => events.fire('sequence.cacheStatus', status)));
    });

    events.function('sequence.cacheStatus', () => source?.cacheStatus() ?? emptyCacheStatus);
    events.on('sequence.toggleCache', () => {
        if (!source) return;
        const enable = !source.cacheStatus().enabled;
        if (enable) events.fire('timeline.setPlaying', false);
        source.setCacheEnabled(enable, events.invoke('timeline.frame'));
    });

    events.on('timeline.frame', requestViewportFrame);

    events.function('plysequence.beginOffline', async () => {
        offline = true;
        nextFrame = -1;
        if (viewportPump) await viewportPump;
    });
    events.on('plysequence.endOffline', () => {
        offline = false;
    });

    // drop references when the scene is cleared (scene.clear destroys the splat)
    events.on('scene.clear', () => {
        source?.destroy();
        source = null;
        splat = null;
        currentFrame = -1;
        nextFrame = -1;
        events.fire('sequence.cacheStatus', emptyCacheStatus);
    });

    // Offline rendering propagates load errors instead of encoding a blank frame.
    events.function('plysequence.setFrameAsync', loadFrame);
};

export { registerSequenceEvents };
