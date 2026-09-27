/**
 * Reader for the Ogawa container used by Alembic 1.6 and later.
 *
 * Everything is little endian and byte aligned. Offsets are absolute and point
 * at one of two node types:
 *
 *   header    'Ogawa' (5) | frozen flag (1) | version (2) | root offset (u64)
 *   group     child count (u64) | child offsets (u64 x count)
 *   data      byte count (u64) | bytes
 *
 * The top bit of an offset marks a data node, the low 63 bits hold the offset.
 * Zero is the empty group and 0x8000000000000000 the empty data node. Nothing
 * is compressed, so every read is a view into the source buffer.
 */

const MAGIC = [0x4f, 0x67, 0x61, 0x77, 0x61];   // 'Ogawa'
const VERSION = 1;
const DATA_FLAG = 0x80000000;

// u64 values are read as two halves so results stay inside the safe integer
// range: real archives stay far below 2^53 bytes, and anything larger is
// rejected rather than silently truncated.
const readUint64 = (view: DataView, pos: number, allowDataFlag: boolean) => {
    const lo = view.getUint32(pos, true);
    const hi = view.getUint32(pos + 4, true);

    if (!allowDataFlag && hi >= 0x200000) {
        throw new Error('abc: value exceeds 2^53');
    }

    return {
        value: (hi & 0x7fffffff) * 0x100000000 + lo,
        isData: (hi & DATA_FLAG) !== 0
    };
};

/**
 * A byte stream node: the size field followed by the payload.
 */
class OgawaData {
    /** Payload bytes, excluding the size field. */
    readonly bytes: Uint8Array;

    /** A view over `bytes`, so callers can read typed values in place. */
    readonly view: DataView;

    readonly size: number;

    constructor(fileBytes: Uint8Array, fileView: DataView, pos: number) {
        this.size = readUint64(fileView, pos, false).value;
        if (pos + 8 + this.size > fileBytes.length) {
            throw new Error('abc: data node extends past the end of the file');
        }
        this.bytes = fileBytes.subarray(pos + 8, pos + 8 + this.size);
        this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    }

    /**
     * Decode the payload as text. Alembic writes names and metadata as plain
     * ASCII, so latin1 round trips them and cannot throw on stray bytes.
     */
    text(): string {
        return new TextDecoder('latin1').decode(this.bytes);
    }
}

/**
 * A group node: an ordered list of child offsets.
 */
class OgawaGroup {
    readonly pos: number;
    readonly numChildren: number;

    private readonly fileBytes: Uint8Array;
    private readonly fileView: DataView;
    private readonly children: Uint8Array;

    constructor(fileBytes: Uint8Array, fileView: DataView, pos: number) {
        const count = readUint64(fileView, pos, false).value;
        if (count === 0 || count > fileBytes.length / 8) {
            throw new Error(`abc: group has an implausible child count (${count})`);
        }
        if (pos + 8 + count * 8 > fileBytes.length) {
            throw new Error('abc: group children extend past the end of the file');
        }

        this.pos = pos;
        this.numChildren = count;
        this.fileBytes = fileBytes;
        this.fileView = fileView;
        this.children = fileBytes.subarray(pos + 8, pos + 8 + count * 8);
    }

    /**
     * Decode the offset of one child. Returns null when the index is out of
     * range, so callers can probe for optional children.
     */
    child(i: number) {
        if (i < 0 || i >= this.numChildren) {
            return null;
        }

        const at = i * 8;
        const c = this.children;
        const lo = (c[at] | (c[at + 1] << 8) | (c[at + 2] << 16) | (c[at + 3] << 24)) >>> 0;
        const hi = (c[at + 4] | (c[at + 5] << 8) | (c[at + 6] << 16) | (c[at + 7] << 24)) >>> 0;

        return {
            offset: (hi & 0x7fffffff) * 0x100000000 + lo,
            isData: (hi & DATA_FLAG) !== 0
        };
    }

    group(i: number): OgawaGroup | null {
        const child = this.child(i);
        // an empty group is encoded as a zero offset with no node to read
        if (!child || child.isData || child.offset === 0) {
            return null;
        }
        return new OgawaGroup(this.fileBytes, this.fileView, child.offset);
    }

    data(i: number): OgawaData | null {
        const child = this.child(i);
        if (!child || !child.isData) {
            return null;
        }
        return new OgawaData(this.fileBytes, this.fileView, child.offset);
    }
}

/**
 * An opened Ogawa archive.
 */
class OgawaFile {
    readonly root: OgawaGroup;

    /** True once the writer closed the file; open files are still readable. */
    readonly frozen: boolean;

    readonly version: number;

    private constructor(fileBytes: Uint8Array, fileView: DataView, rootOffset: number, frozen: boolean, version: number) {
        this.root = new OgawaGroup(fileBytes, fileView, rootOffset);
        this.frozen = frozen;
        this.version = version;
    }

    static open(buffer: ArrayBuffer): OgawaFile {
        if (buffer.byteLength < 16) {
            throw new Error('abc: file is too small to be an Alembic archive');
        }

        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);

        for (let i = 0; i < MAGIC.length; ++i) {
            if (bytes[i] !== MAGIC[i]) {
                throw new Error('abc: not an Ogawa archive (HDF5 based Alembic files are not supported)');
            }
        }

        const version = (bytes[6] << 8) | bytes[7];
        if (version !== VERSION) {
            throw new Error(`abc: unsupported Ogawa version ${version}`);
        }

        const rootOffset = readUint64(view, 8, true).value;
        if (rootOffset === 0 || rootOffset >= buffer.byteLength) {
            throw new Error('abc: missing root group');
        }

        return new OgawaFile(bytes, view, rootOffset, bytes[5] === 0xff, version);
    }
}

export { OgawaFile, OgawaGroup, OgawaData };
