/**
 * Alembic object model on top of the Ogawa container.
 *
 * The root group of an Ogawa archive holds, in order:
 *
 *   0  archive version (i32)          3  archive metadata (string)
 *   1  file version (i32, >= 9999)    4  time samplings
 *   2  top object                     5  indexed metadata
 *
 * An object is a group whose last child is the object header stream (two
 * 16 byte digests trail it) and whose first child is a compound property
 * group. Children objects start at index 1, in header order.
 *
 * A compound property group holds one node per property followed by a data
 * node with the property headers. Scalar and array properties back their
 * samples with a group: child i is sample i, each sample being a 16 byte
 * digest followed by the value bytes.
 */

import { OgawaData, OgawaFile, OgawaGroup } from './ogawa';

// Plain old data types, in the order Alembic encodes them.
enum Pod {
    Boolean, Uint8, Int8, Uint16, Int16, Uint32, Int32, Uint64, Int64,
    Float16, Float32, Float64, String, Wstring
}

const POD_BYTES = [1, 1, 1, 2, 2, 4, 4, 8, 8, 2, 4, 8, 0, 0];

const ACYCLIC_NUM_SAMPLES = 0xffffffff;

const PROPERTY_TYPES = ['compound', 'scalar', 'array'] as const;

type MetaData = Record<string, string>;

/**
 * Metadata strings are `key=value` pairs separated by semicolons.
 */
const parseMetaData = (text: string) => {
    const result: MetaData = {};
    for (const entry of text.split(';')) {
        if (entry.length === 0) {
            continue;
        }
        const at = entry.indexOf('=');
        if (at > 0) {
            result[entry.substring(0, at)] = entry.substring(at + 1);
        }
    }
    return result;
};

/**
 * Sample times of one time sampling. The archive stores them once and
 * properties reference them by index.
 */
class TimeSampling {
    readonly numSamplesPerCycle: number;
    readonly timePerCycle: number;
    readonly sampleTimes: Float64Array;

    constructor(numSamplesPerCycle: number, timePerCycle: number, sampleTimes: Float64Array) {
        this.numSamplesPerCycle = numSamplesPerCycle;
        this.timePerCycle = timePerCycle;
        this.sampleTimes = sampleTimes;
    }

    timeOfSample(i: number): number {
        // acyclic: every sample time is stored
        if (this.numSamplesPerCycle === ACYCLIC_NUM_SAMPLES) {
            if (i >= this.sampleTimes.length) {
                throw new Error(`abc: acyclic time sampling has no sample ${i}`);
            }
            return this.sampleTimes[i];
        }
        // one sample per cycle is the uniform case: the first stored time is
        // the offset and every sample advances by one cycle
        if (this.numSamplesPerCycle === 1) {
            return this.sampleTimes[0] + i * this.timePerCycle;
        }
        // cyclic: the stored times describe one cycle that repeats
        const cycle = Math.floor(i / this.numSamplesPerCycle);
        return this.sampleTimes[i % this.numSamplesPerCycle] + cycle * this.timePerCycle;
    }
}

class PropertyHeader {
    readonly name: string;
    readonly propertyType: 'compound' | 'scalar' | 'array';
    readonly pod: Pod;
    readonly extent: number;
    readonly metaData: MetaData;
    readonly numSamples: number;
    readonly timeSampling: TimeSampling;
    private readonly firstChangedIndex: number;
    private readonly lastChangedIndex: number;

    constructor(
        name: string,
        propertyType: 'compound' | 'scalar' | 'array',
        pod: Pod,
        extent: number,
        metaData: MetaData,
        numSamples: number,
        timeSampling: TimeSampling,
        firstChangedIndex: number,
        lastChangedIndex: number
    ) {
        this.name = name;
        this.propertyType = propertyType;
        this.pod = pod;
        this.extent = extent;
        this.metaData = metaData;
        this.numSamples = numSamples;
        this.timeSampling = timeSampling;
        this.firstChangedIndex = firstChangedIndex;
        this.lastChangedIndex = lastChangedIndex;
    }

    /**
     * Map a logical sample index onto the stored one. Unchanged samples are
     * not written again, so sample 0 covers the head of the range and the
     * last written sample covers the tail.
     */
    storedIndex(i: number): number {
        if (i < this.firstChangedIndex) {
            return 0;
        }
        if (this.firstChangedIndex === 0 && this.lastChangedIndex === 0) {
            return 0;
        }
        if (i >= this.lastChangedIndex) {
            return this.lastChangedIndex - this.firstChangedIndex + 1;
        }
        return i - this.firstChangedIndex + 1;
    }
}

/**
 * One property of an object: its header plus the node that backs its samples.
 * Compound properties (`.geom`, `.transform`) nest further properties, which
 * are parsed eagerly because they are few and shallow.
 */
class AbcProperty {
    readonly header: PropertyHeader;
    readonly node: OgawaGroup | null;
    readonly properties: AbcProperty[];

    constructor(header: PropertyHeader, node: OgawaGroup | null, properties: AbcProperty[] = []) {
        this.header = header;
        this.node = node;
        this.properties = properties;
    }

    /**
     * Read a scalar sample of a numeric property as numbers (float32 and
     * float64 read directly, the integer types convert).
     */
    readNumbers(index: number): Float64Array | null {
        if (!this.node) {
            return null;
        }
        const header = this.header;
        if (header.propertyType !== 'scalar' || header.pod > Pod.Float64) {
            throw new Error(`abc: ${header.name} is not a numeric scalar property`);
        }

        const data = this.node.data(header.storedIndex(index));
        const bytes = data ? data.size - 16 : 0;
        if (!data || bytes <= 0) {
            return null;
        }

        const count = Math.min(header.extent, Math.floor(bytes / POD_BYTES[header.pod]));
        const result = new Float64Array(count);
        const view = data.view;
        // values start after the 16 byte digest
        for (let i = 0; i < count; ++i) {
            const at = 16 + i * POD_BYTES[header.pod];
            switch (header.pod) {
                case Pod.Float32:
                    result[i] = view.getFloat32(at, true);
                    break;
                case Pod.Float64:
                    result[i] = view.getFloat64(at, true);
                    break;
                case Pod.Uint8:
                case Pod.Boolean:
                    result[i] = view.getUint8(at);
                    break;
                case Pod.Int8:
                    result[i] = view.getInt8(at);
                    break;
                case Pod.Uint16:
                    result[i] = view.getUint16(at, true);
                    break;
                case Pod.Int16:
                    result[i] = view.getInt16(at, true);
                    break;
                case Pod.Uint32:
                    result[i] = view.getUint32(at, true);
                    break;
                case Pod.Int32:
                    result[i] = view.getInt32(at, true);
                    break;
                default:
                    throw new Error(`abc: unsupported numeric type for ${header.name}`);
            }
        }
        return result;
    }

    /**
     * Read a scalar sample of a string property. Alembic stores the strings
     * NUL separated and unterminated after the digest.
     */
    readStrings(index: number): string[] {
        const header = this.header;
        if (header.propertyType !== 'scalar' || header.pod !== Pod.String) {
            throw new Error(`abc: ${header.name} is not a string scalar property`);
        }
        if (!this.node) {
            return [];
        }

        const data = this.node.data(header.storedIndex(index));
        if (!data || data.size <= 16) {
            return [];
        }

        const values: string[] = [];
        let start = 16;
        for (let i = 16; i < data.size && values.length < header.extent; ++i) {
            if (data.view.getUint8(i) === 0) {
                const bytes = data.bytes.subarray(start, i);
                values.push(new TextDecoder('latin1').decode(bytes));
                start = i + 1;
            }
        }
        return values;
    }

    /**
     * Read one sample of an array property as numbers. Array samples are
     * stored as a pair: the value node, then a node holding the dimensions.
     */
    readArrayNumbers(index: number): Float64Array | null {
        if (!this.node) {
            return null;
        }
        const header = this.header;
        if (header.propertyType !== 'array' || header.pod > Pod.Float64) {
            throw new Error(`abc: ${header.name} is not a numeric array property`);
        }

        const at = header.storedIndex(index) * 2;
        const data = this.node.data(at);
        const bytes = data ? data.size - 16 : 0;
        if (!data || bytes <= 0) {
            return null;
        }

        const view = data.view;
        const count = Math.floor(bytes / POD_BYTES[header.pod]);
        const result = new Float64Array(count);
        for (let i = 0; i < count; ++i) {
            const offset = 16 + i * POD_BYTES[header.pod];
            result[i] = header.pod === Pod.Float32 ? view.getFloat32(offset, true) :
                header.pod === Pod.Float64 ? view.getFloat64(offset, true) :
                    header.pod === Pod.Uint32 ? view.getUint32(offset, true) :
                        view.getUint8(offset);
        }
        return result;
    }
}

class AbcObject {
    readonly name: string;
    readonly fullName: string;
    readonly metadata: MetaData;
    readonly properties: AbcProperty[];
    readonly children: AbcObject[];

    private constructor(name: string, fullName: string, metadata: MetaData) {
        this.name = name;
        this.fullName = fullName;
        this.metadata = metadata;
        this.properties = [];
        this.children = [];
    }

    getProperty(name: string): AbcProperty | null {
        return this.properties.find(p => p.header.name === name) ?? null;
    }

    /**
     * Walk the group backing one object: first child is the compound property
     * group, the last is the object header stream, the ones between are child
     * objects in header order.
     */
    static parse(group: OgawaGroup, fullName: string, metadata: MetaData, timeSamplings: TimeSampling[], indexedMetaData: MetaData[]): AbcObject {
        const object = new AbcObject(fullName.substring(fullName.lastIndexOf('/') + 1), fullName, metadata);
        const count = group.numChildren;

        if (count > 0 && group.child(0) && !group.child(0).isData) {
            object.properties = AbcObject.parseProperties(group.group(0), timeSamplings, indexedMetaData);
        }

        if (count > 0 && group.child(count - 1).isData) {
            const headerData = group.data(count - 1);
            // the stream ends with two 16 byte digests
            const text = new TextDecoder('latin1').decode(headerData.bytes.subarray(0, Math.max(0, headerData.size - 32)));
            const headers = AbcObject.parseObjectHeaders(text, indexedMetaData);

            headers.forEach((header, i) => {
                const childGroup = group.group(i + 1);
                if (childGroup) {
                    object.children.push(AbcObject.parse(childGroup, `${fullName}/${header.name}`, header.metaData, timeSamplings, indexedMetaData));
                }
            });
        }

        return object;
    }

    private static parseObjectHeaders(text: string, indexedMetaData: MetaData[]) {
        const headers: Array<{ name: string, metaData: MetaData }> = [];
        const view = new DataView(new TextEncoder().encode(text).buffer);
        let pos = 0;

        while (pos + 4 < text.length) {
            const nameSize = view.getUint32(pos, true);
            pos += 4;
            const name = new TextDecoder('latin1').decode(new Uint8Array(view.buffer, view.byteOffset + pos, nameSize));
            pos += nameSize;

            const metaDataIndex = text.charCodeAt(pos);
            pos += 1;

            let metaData: MetaData = {};
            if (metaDataIndex === 0xff) {
                const size = view.getUint32(pos, true);
                pos += 4;
                metaData = parseMetaData(new TextDecoder('latin1').decode(new Uint8Array(view.buffer, view.byteOffset + pos, size)));
                pos += size;
            } else {
                metaData = indexedMetaData[metaDataIndex] ?? {};
            }

            headers.push({ name, metaData });
        }

        return headers;
    }

    /**
     * Parse the compound property group: one node per property, the trailing
     * data node holding the headers.
     */
    private static parseProperties(group: OgawaGroup | null, timeSamplings: TimeSampling[], indexedMetaData: MetaData[]): AbcProperty[] {
        if (!group) {
            return [];
        }

        const count = group.numChildren;
        if (count === 0 || !group.child(count - 1).isData) {
            return [];
        }

        const headers = AbcObject.parsePropertyHeaders(group.data(count - 1), timeSamplings, indexedMetaData);
        return headers.map((header, i) => {
            const node = group.group(i);
            const nested = header.propertyType === 'compound' ?
                AbcObject.parseProperties(node, timeSamplings, indexedMetaData) : [];
            return new AbcProperty(header, node, nested);
        });
    }

    private static parsePropertyHeaders(data: OgawaData, timeSamplings: TimeSampling[], indexedMetaData: MetaData[]): PropertyHeader[] {
        const headers: PropertyHeader[] = [];
        const view = data.view;
        // the cursor lives outside the loop so the readers below stay stable
        const cursor = { pos: 0 };
        const readUint = (implied: number) => {
            const value = implied === 1 ? view.getUint8(cursor.pos) :
                implied === 2 ? view.getUint16(cursor.pos, true) : view.getUint32(cursor.pos, true);
            cursor.pos += implied;
            return value;
        };
        const readText = (size: number) => {
            const text = new TextDecoder('latin1').decode(data.bytes.subarray(cursor.pos, cursor.pos + size));
            cursor.pos += size;
            return text;
        };

        while (cursor.pos + 4 <= data.size) {
            const info = view.getUint32(cursor.pos, true);
            cursor.pos += 4;

            const typeIndex = info & 0x3;
            const sizeHint = (info & 0xc) >> 2;
            const implied = [1, 2, 4][sizeHint];

            let pod = Pod.Boolean;
            let extent = 0;
            let numSamples = 0;
            let timeSampling = timeSamplings[0];
            let firstChangedIndex = 0;
            let lastChangedIndex = 0;

            if (typeIndex !== 0) {
                pod = (info & 0xf0) >> 4;
                extent = (info & 0xff000) >> 12;
                numSamples = readUint(implied);

                if (info & 0x200) {
                    firstChangedIndex = readUint(implied);
                    lastChangedIndex = readUint(implied);
                } else if (info & 0x800) {
                    // identical across every sample: only one is stored
                    firstChangedIndex = 0;
                    lastChangedIndex = 0;
                } else {
                    firstChangedIndex = 1;
                    lastChangedIndex = numSamples - 1;
                }

                if (info & 0x100) {
                    timeSampling = timeSamplings[readUint(implied)];
                }
            }

            const name = readText(readUint(implied));

            let metaData: MetaData = {};
            const metaDataIndex = (info & 0xff00000) >> 20;
            if (metaDataIndex === 0xff) {
                metaData = parseMetaData(readText(readUint(implied)));
            } else {
                metaData = indexedMetaData[metaDataIndex] ?? {};
            }

            headers.push(new PropertyHeader(
                name,
                PROPERTY_TYPES[typeIndex],
                pod,
                extent,
                metaData,
                numSamples,
                timeSampling,
                firstChangedIndex,
                lastChangedIndex
            ));
        }

        return headers;
    }
}

/**
 * An opened Alembic archive.
 */
class AbcArchive {
    readonly archiveVersion: number;
    readonly metadata: MetaData;
    readonly timeSamplings: TimeSampling[];
    readonly top: AbcObject;

    private constructor(archiveVersion: number, metadata: MetaData, timeSamplings: TimeSampling[], top: AbcObject) {
        this.archiveVersion = archiveVersion;
        this.metadata = metadata;
        this.timeSamplings = timeSamplings;
        this.top = top;
    }

    static open(buffer: ArrayBuffer): AbcArchive {
        const file = OgawaFile.open(buffer);
        const root = file.root;

        if (root.numChildren < 6) {
            throw new Error('abc: archive is missing its root groups');
        }

        const archiveVersionData = root.data(0);
        const fileVersionData = root.data(1);
        const archiveVersion = archiveVersionData && archiveVersionData.size === 4 ?
            archiveVersionData.view.getInt32(0, true) : 0;
        const fileVersion = fileVersionData && fileVersionData.size === 4 ?
            fileVersionData.view.getInt32(0, true) : 0;

        if (fileVersion < 9999) {
            throw new Error(`abc: unsupported Alembic version ${fileVersion}`);
        }

        const timeSamplings = AbcArchive.parseTimeSamplings(root.data(4));
        const indexedMetaData = AbcArchive.parseIndexedMetaData(root.data(5));

        const metadataData = root.data(3);
        const metadata = metadataData ? parseMetaData(metadataData.text()) : {};

        const topGroup = root.group(2);
        if (!topGroup) {
            throw new Error('abc: archive has no top object');
        }

        // the top object carries no header of its own: it is the archive root
        const top = AbcObject.parse(topGroup, '/', metadata, timeSamplings, indexedMetaData);

        return new AbcArchive(archiveVersion, metadata, timeSamplings, top);
    }

    private static parseTimeSamplings(data: OgawaData | null): TimeSampling[] {
        const result: TimeSampling[] = [];
        if (!data || data.size === 0) {
            return result;
        }

        const view = data.view;
        let pos = 0;
        while (pos + 16 <= data.size) {
            // the first field is the largest sample count the archive recorded,
            // which is descriptive only: property headers carry the real counts
            pos += 4;
            const timePerCycle = view.getFloat64(pos, true);
            pos += 8;
            const samplesPerCycle = view.getUint32(pos, true);
            pos += 4;

            const times = new Float64Array(samplesPerCycle);
            for (let i = 0; i < samplesPerCycle; ++i) {
                times[i] = view.getFloat64(pos, true);
                pos += 8;
            }

            result.push(new TimeSampling(samplesPerCycle, timePerCycle, times));
        }
        return result;
    }

    private static parseIndexedMetaData(data: OgawaData | null): MetaData[] {
        const result: MetaData[] = [{}];
        if (!data || data.size === 0) {
            return result;
        }

        let pos = 0;
        while (pos < data.size) {
            const size = data.view.getUint8(pos);
            pos += 1;
            result.push(parseMetaData(new TextDecoder('latin1').decode(data.bytes.subarray(pos, pos + size))));
            pos += size;
        }
        return result;
    }
}

export { AbcArchive, AbcObject, AbcProperty, PropertyHeader, TimeSampling, Pod };
