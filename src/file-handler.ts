import { path, Quat, Vec3 } from 'playcanvas';

import { AbcNoCameraError, importAbcCameras } from './abc/camera-import';
import type { Pose } from './camera-poses';
import { CreateDropHandler, resolveHandleFiles } from './drop-handler';
import { ElementType } from './element';
import { Events } from './events';
import { buildExportOptions, ExportChoices, ExportDialogResult, ExportType, SceneExportOptions } from './export-options';
import { ExportSettings, loadExportSettings, saveExportSettings } from './export-settings';
import { BlobReadSource, BrowserFileSystem, MappedReadFileSystem, pickWriteTarget, sourcesOf, WriteTarget } from './io';
import { recentImports, RecentImport } from './recent-files';
import { Scene } from './scene';
import { Splat } from './splat';
import { serializeSog, serializeSpz, serializeViewer, SogSettings, SpzSettings, WebGPUUnavailableError, writeSplatFile } from './splat-serialize';
import { i18n } from './ui/localization';

// ts compiler and vscode find this type, but eslint does not
type FilePickerAcceptType = unknown;

type FileType = 'ply' | 'compressedPly' | 'splat' | 'sog' | 'spz' | 'htmlViewer' | 'packageViewer';

const filePickerTypes: { [key: string]: FilePickerAcceptType } = {
    'ply': {
        description: 'PLY (Gaussian Splat or Point Cloud)',
        accept: {
            'application/ply': ['.ply']
        }
    },
    'compressedPly': {
        description: 'Compressed Gaussian Splat PLY File',
        accept: {
            'application/ply': ['.ply']
        }
    },
    'sog': {
        description: 'SOG Scene',
        accept: {
            'application/x-gaussian-splat': ['.json', '.sog'],
            'image/webp': ['.webp']
        }
    },
    'lcc': {
        description: 'LCC Scene',
        accept: {
            'application/x-lcc': ['.lcc', '.lcc2', '.bin']
        }
    },
    'splat': {
        description: 'Splat File',
        accept: {
            'application/x-gaussian-splat': ['.splat']
        }
    },
    'ksplat': {
        description: 'KSplat File',
        accept: {
            'application/x-gaussian-splat': ['.ksplat']
        }
    },
    'spz': {
        description: 'SPZ File (Niantic)',
        accept: {
            'application/x-gaussian-splat': ['.spz']
        }
    },
    'indexTxt': {
        description: 'Colmap Poses (Images.txt)',
        accept: {
            'text/plain': ['.txt']
        }
    },
    'abc': {
        description: 'Alembic Camera File',
        accept: {
            'application/x-alembic': ['.abc']
        }
    },
    'htmlViewer': {
        description: 'Viewer HTML',
        accept: {
            'text/html': ['.html']
        }
    },
    'packageViewer': {
        description: 'Viewer ZIP',
        accept: {
            'application/zip': ['.zip']
        }
    }
};

const allImportTypes = {
    description: 'Supported Files',
    accept: {
        'application/ply': ['.ply'],
        'application/x-gaussian-splat': ['.json', '.sog', '.splat', '.ksplat', '.spz'],
        'image/webp': ['.webp'],
        'application/x-lcc': ['.lcc', '.lcc2', '.bin'],
        'application/x-alembic': ['.abc'],
        'text/plain': ['.txt']
    }
};

// determine if all files share a common filename prefix followed by
// a frame number, e.g. "frame0001.ply", "frame0002.ply", etc.
const plyFrame = (filename: string) => {
    const match = filename.toLowerCase().match(/\d+(\.compressed)?\.ply$/);
    if (!match) return null;
    const digits = match[0].match(/^\d+/)![0];
    return { prefix: filename.slice(0, match.index), frame: Number(digits), compressed: !!match[1] };
};

const frameNumberFromName = (filename: string): number | undefined => {
    const stem = filename.replace(/\.(?:exr|png|jpe?g|tiff?|bmp|webp)$/i, '');
    const match = stem.match(/(\d+)$/);
    return match ? Number(match[1]) : undefined;
};

const fitTimelineToPoses = (events: Events, poses: Pose[]) => {
    if (poses.length === 0) return;
    const start = poses.reduce((value, pose) => Math.min(value, pose.frame), Infinity);
    const end = poses.reduce((value, pose) => Math.max(value, pose.frame), -Infinity);
    events.fire('timeline.setInputRange', 'camera', { start, end });
};

const isPlySequence = (filenames: string[]) => {
    if (filenames.length < 2) {
        return false;
    }

    const baseMatch = plyFrame(filenames[0]);
    if (!baseMatch) {
        return false;
    }

    for (let i = 1; i < filenames.length; i++) {
        const thisMatch = plyFrame(filenames[i]);
        if (!thisMatch || thisMatch.prefix !== baseMatch.prefix || thisMatch.compressed !== baseMatch.compressed) {
            return false;
        }
    }

    return true;
};

// SOG has a meta.json file; streamed SOG has a lod-meta.json file.
const isSog = (filenames: string[]) => {
    const count = (extension: string) => filenames.reduce((sum, f) => sum + (f.endsWith(extension) ? 1 : 0), 0);
    return count('lod-meta.json') === 1 || count('meta.json') === 1;
};

// The LCC file contains meta.lcc, index.bin, data.bin and shcoef.bin (optional).
// LCC2 comprises a meta.lcc2 file and .sog/.spz chunk files.
const isLcc = (filenames: string[]) => {
    const count = (extension: string) => filenames.reduce((sum, f) => sum + (f.endsWith(extension) ? 1 : 0), 0);
    return count('.lcc') === 1 || count('.lcc2') === 1;
};

// The file that names a model: SOG meta, LCC meta, else the first (single file case).
const findMainIndex = (filenames: string[]) => {
    const isMeta = (f: string) => f === 'meta.json' || f === 'lod-meta.json';
    const isLccMeta = (f: string) => f.endsWith('.lcc') || f.endsWith('.lcc2');
    if (filenames.some(isMeta)) return filenames.findIndex(isMeta);
    if (filenames.some(isLccMeta)) return filenames.findIndex(isLccMeta);
    return 0;
};

type ImportFile = {
    filename: string;
    url?: string;
    contents?: File;
    handle?: FileSystemFileHandle;
    // the picked or dropped item this file came from, when it is an enclosing folder
    root?: FileSystemHandle;
};

// Remember what the user picked, dropped or launched for Import Recent. Files
// from one dropped folder share a root and count once; several files picked
// together that make up one model (unbundled SOG, LCC, PLY sequence) count once.
// Documents are tracked by Open Recent instead.
const recordImports = (files: ImportFile[]) => {
    const roots = Array.from(new Set(files.map(f => f.root ?? f.handle)));
    if (roots.length === 0 || roots.some(root => !root)) {
        // url loads and document layers have no handles
        return;
    }

    const filenames = files.map(f => f.filename.toLowerCase());
    if (roots.length > 1 && (isPlySequence(filenames) || isSog(filenames) || isLcc(filenames))) {
        recentImports.add({ name: files[findMainIndex(filenames)].filename, handles: roots });
    } else {
        roots.filter(root => !root.name.toLowerCase().endsWith('.ssproj'))
        .forEach(root => recentImports.add({ name: root.name, handles: [root] }));
    }
};

const vec = new Vec3();

// url imports carry no contents, but the camera importers read the file body
// directly, so fetch it when only a url is available
const resolveContents = async (file: ImportFile) => {
    if (file.contents) {
        return file.contents;
    }
    if (!file.url) {
        throw new Error('no file contents');
    }
    const response = await fetch(file.url);
    if (!response.ok) {
        throw new Error(`http ${response.status} while fetching '${file.url}'`);
    }
    return response.blob();
};

// load an alembic camera animation, one set per camera in the file
const loadAbcCameras = async (file: ImportFile, events: Events, scene: Scene) => {
    const contents = await resolveContents(file);
    const imported = importAbcCameras(await contents.arrayBuffer());
    const { cameras, frameRate } = imported;
    // Maya's default world unit is centimetres. Alembic does not declare a
    // global scene unit, so choose the centimetre-to-metre conversion only
    // when an existing splat bound makes that interpretation unambiguous.
    const bound = scene.bound;
    const radius = bound.halfExtents.length();
    const samplePosition = cameras[0]?.poses[0]?.position;
    const hasSplats = scene.getElementsByType(ElementType.splat).length > 0;
    const unscaledDistance = samplePosition?.distance(bound.center) ?? 0;
    const scaledDistance = samplePosition?.clone().mulScalar(0.01).distance(bound.center) ?? 0;
    const worldScale = hasSplats && radius > 0.001 &&
        unscaledDistance > radius * 20 && scaledDistance < radius * 20 &&
        scaledDistance < unscaledDistance / 10 ? 0.01 : 1;
    if (worldScale !== 1) {
        cameras.forEach(camera => camera.poses.forEach((pose) => {
            pose.position.mulScalar(worldScale);
            pose.target.mulScalar(worldScale);
            if (pose.lens?.nearClip) pose.lens.nearClip *= worldScale;
            if (pose.lens?.farClip) pose.lens.farClip *= worldScale;
            if (pose.lens?.focusDistance) pose.lens.focusDistance *= worldScale;
        }));
    }
    // Some DCC exports normalize Alembic sample times to zero. A trailing
    // shot-frame suffix provides the original start when the archive does not.
    const filenameFrame = file.filename.match(/[._-](\d{3,})\.abc$/i);
    const offset = imported.startFrame === 0 && filenameFrame ? Number(filenameFrame[1]) : 0;
    if (offset) {
        cameras.forEach(camera => camera.poses.forEach((pose) => {
            pose.frame += offset;
        }));
    }
    const startFrame = imported.startFrame + offset;

    // Alembic samples describe the camera Input range, including layout
    // handles. They must not expand an existing PLY project's Global range.
    const endFrame = cameras.reduce((max, camera) => {
        return camera.poses.reduce((end, pose) => Math.max(end, pose.frame), max);
    }, -Infinity);
    events.fire('timeline.setInputRange', 'camera', {
        start: startFrame,
        end: endFrame,
        frameRate,
        name: file.filename
    });
    events.fire('camera.loadSets', cameras.map(camera => ({ ...camera, worldScale })));
};

// load inria camera poses from json file
const loadCameraPoses = async (file: ImportFile, events: Events) => {
    const response = new Response(await resolveContents(file));
    const json = await response.json();

    if (json.length > 0) {
        // sort entries by trailing number if it exists
        const sorter = (a: any, b: any) => {
            const avalue = a.id ?? a.img_name?.match(/\d*$/)?.[0];
            const bvalue = b.id ?? b.img_name?.match(/\d*$/)?.[0];
            return (avalue && bvalue) ? parseInt(avalue, 10) - parseInt(bvalue, 10) : 0;
        };

        const poses: Pose[] = [];
        json.sort(sorter).forEach((pose: any, i: number) => {
            if (pose.hasOwnProperty('position') && pose.hasOwnProperty('rotation')) {
                const p = new Vec3(pose.position);
                const z = new Vec3(pose.rotation[0][2], pose.rotation[1][2], pose.rotation[2][2]);

                // Use fixed offset along Z-axis direction instead of variable dot product
                vec.copy(z).mulScalar(10).add(p);

                // compute max FOV from intrinsics (vertical or horizontal, whichever is larger)
                let fov: number | undefined;
                if (pose.fx && pose.fy && pose.width && pose.height) {
                    const fovX = 2 * Math.atan(pose.width / (2 * pose.fx)) * (180 / Math.PI);
                    const fovY = 2 * Math.atan(pose.height / (2 * pose.fy)) * (180 / Math.PI);
                    fov = Math.max(fovX, fovY);
                }

                poses.push({
                    name: pose.img_name ?? `${file.filename}_${i}`,
                    frame: frameNumberFromName(pose.img_name ?? '') ?? i,
                    position: new Vec3(-p.x, -p.y, p.z),
                    target: new Vec3(-vec.x, -vec.y, vec.z),
                    fov,
                    lens: {
                        resolutionWidth: pose.width,
                        resolutionHeight: pose.height
                    }
                });
            }
        });

        if (poses.length > 0) {
            fitTimelineToPoses(events, poses);
            events.fire('camera.loadPoses', poses);
        }
    }
};

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

// https://colmap.github.io/format.html#images-txt
const loadImagesTxt = async (file: ImportFile, events: Events) => {
    const response = new Response(await resolveContents(file));
    const text = await response.text();

    // split into lines, remove comments and empty lines
    const poses = text.split('\n')
    .map(line => line.trim())
    .filter(line => !line.startsWith('#'))      // remove comments
    .filter((_, i) => i % 2 === 0)              // remove every second line
    .map((line, i) => {
        const parts = line.split(' ');
        if (parts.length !== 10) {
            return null;
        }
        const name = parts[9];
        const order = parseInt(removeExtension(name).match(/\d+$/)?.[0], 10);
        return {
            w: parseFloat(parts[1]),
            x: parseFloat(parts[2]),
            y: parseFloat(parts[3]),
            z: parseFloat(parts[4]),
            tx: parseFloat(parts[5]),
            ty: parseFloat(parts[6]),
            tz: parseFloat(parts[7]),
            name: name ?? `${file.filename}_${i}`,
            order: isFinite(order) ? order : i
        };
    })
    .filter(entry => !!entry)
    .sort((a, b) => (a.order < b.order ? -1 : 1));

    const q = new Quat();
    const t = new Vec3();

    const cameraPoses = poses.map((pose, i) => {
        const { w, x, y, z, tx, ty, tz } = pose;

        q.set(x, y, z, w).normalize().invert();
        t.set(-tx, -ty, -tz);
        q.transformVector(t, t);

        q.transformVector(Vec3.BACK, vec);
        vec.mulScalar(10).add(t);

        return {
            name: pose.name,
            frame: frameNumberFromName(pose.name) ?? i,
            position: new Vec3(-t.x, -t.y, t.z),
            target: new Vec3(-vec.x, -vec.y, vec.z)
        };
    });

    if (cameraPoses.length > 0) {
        fitTimelineToPoses(events, cameraPoses);
        events.fire('camera.loadPoses', cameraPoses);
    }
};

// initialize file handler events
const initFileHandler = (scene: Scene, events: Events, dropTarget: HTMLElement) => {

    const showLoadError = async (message: string, filename: string) => {
        await events.invoke('showPopup', {
            type: 'error',
            header: i18n.t('popup.error-loading'),
            message: `${message} while loading '${filename}'`
        });
    };

    // import splat model(s) - handles single files, SOG, and LCC formats
    const importSplatModel = async (files: ImportFile[], animationFrame: boolean) => {
        try {
            const filenames = files.map(f => f.filename.toLowerCase());

            const mainFile = files[findMainIndex(filenames)];
            const baseUrl = mainFile.url ? new URL('.', new URL(mainFile.url, window.location.href)).href : undefined;

            // Create file system with all local files, falling back to URL loading
            const fileSystem = new MappedReadFileSystem(baseUrl);
            files.forEach((f) => {
                if (f.contents) fileSystem.addFile(f.filename, f.contents, f.handle ?? null);
            });

            // Multi-file container formats must load by their relative name so the
            // library resolves sibling files against the file system's baseUrl
            // (path-joining a full URL corrupts the 'http://' prefix)
            const lowerMainFilename = mainFile.filename.toLowerCase();
            const isContainer = lowerMainFilename === 'meta.json' || lowerMainFilename === 'lod-meta.json' || lowerMainFilename.endsWith('.lcc') || lowerMainFilename.endsWith('.lcc2');

            // For URL-only single file, use full URL as filename
            const filename = (files.length === 1 && !mainFile.contents && mainFile.url && !isContainer) ?
                mainFile.url :
                mainFile.filename;

            const model = await scene.assetLoader.load(filename, fileSystem, animationFrame);
            if (!model) {
                // user cancelled the load
                return null;
            }
            model.resource.fileSources = fileSystem.sources;
            await scene.add(model);
            return model;
        } catch (error) {
            const displayName = files[0]?.filename ?? 'unknown';
            await showLoadError(error.message ?? error, displayName);
        }
    };

    // figure out what the set of files are (ply sequence, document, sog set, ply) and then import them
    const importFiles = async (files: ImportFile[], animationFrame = false) => {
        const filenames = files.map(f => f.filename.toLowerCase());

        const result: Splat[] = [];

        if (isPlySequence(filenames)) {
            // handle ply sequence
            events.fire('sequence.setPlyFrames', files.map(f => f.contents));
            events.fire('timeline.setFrame', plyFrame(files[0].filename)!.frame);
        } else if (isSog(filenames) || isLcc(filenames)) {
            const model = await importSplatModel(files, animationFrame);
            if (model) result.push(model);
        } else {
            // check for unrecognized file types
            for (let i = 0; i < filenames.length; i++) {
                const filename = filenames[i].toLowerCase();
                if (['.ssproj', '.ply', '.splat', '.sog', '.webp', 'images.txt', '.json', '.abc', '.ksplat', '.spz'].every(ext => !filename.endsWith(ext))) {
                    await showLoadError('Unrecognized file type', filename);
                    return;
                }
            }

            // handle multiple files as independent imports
            for (let i = 0; i < files.length; i++) {
                const filename = filenames[i].toLowerCase();

                if (filename.endsWith('.ssproj')) {
                    // load ssproj document. doc.load expects a File (the zip
                    // reader needs its size), so wrap url fetches in one
                    const contents = files[i].contents ??
                        new File([await (await fetch(files[i].url)).blob()], files[i].filename);
                    await events.invoke('doc.load', contents, files[i].handle);
                } else if (['.ply', '.splat', '.sog', '.ksplat', '.spz'].some(ext => filename.endsWith(ext))) {
                    // load gaussian splat model
                    const model = await importSplatModel([files[i]], animationFrame);
                    if (model) result.push(model);
                } else if (['images.txt', '.json', '.abc'].some(ext => filename.endsWith(ext))) {
                    // load camera data: colmap frames, inria poses or an
                    // alembic camera animation. these read the file directly,
                    // so failures surface here rather than in the splat loader
                    try {
                        if (filename.endsWith('images.txt')) {
                            await loadImagesTxt(files[i], events);
                        } else if (filename.endsWith('.json')) {
                            await loadCameraPoses(files[i], events);
                        } else {
                            await loadAbcCameras(files[i], events, scene);
                        }
                    } catch (error) {
                        const message = error instanceof AbcNoCameraError ?
                            i18n.t('popup.error-no-camera') : (error.message ?? error);
                        await showLoadError(message, files[i].filename);
                    }
                }
            }
        }

        if (!animationFrame) {
            recordImports(files);
        }

        return result;
    };

    events.function('import', (files: ImportFile[], animationFrame = false) => {
        return importFiles(files, animationFrame);
    });

    // create a file selector element as fallback when showOpenFilePicker isn't available
    let fileSelector: HTMLInputElement;
    if (!window.showOpenFilePicker) {
        fileSelector = document.createElement('input');
        fileSelector.setAttribute('id', 'file-selector');
        fileSelector.setAttribute('type', 'file');
        fileSelector.setAttribute('accept', '.ply,.splat,meta.json,.json,.webp,.sog,.lcc,.lcc2,.bin,.txt,.ksplat,.spz,.abc');
        fileSelector.setAttribute('multiple', 'true');

        fileSelector.onchange = () => {
            const files = [];
            for (let i = 0; i < fileSelector.files.length; i++) {
                const file = fileSelector.files[i];
                files.push({
                    filename: file.name,
                    contents: file
                });
            }
            importFiles(files);
            fileSelector.value = '';
        };
        document.body.append(fileSelector);
    }

    // create the file drag & drop handler
    CreateDropHandler(dropTarget, (entries, shift) => {
        importFiles(entries.map((e) => {
            return {
                filename: e.filename,
                contents: e.file,
                handle: e.handle,
                root: e.root
            };
        }));
    });

    // get the list of visible splats containing gaussians
    const getSplats = () => {
        return (scene.getElementsByType(ElementType.splat) as Splat[])
        .filter(splat => splat.visible)
        .filter(splat => splat.numSplats > 0);
    };

    events.function('scene.allSplats', () => {
        return (scene.getElementsByType(ElementType.splat) as Splat[]);
    });

    events.function('scene.splats', () => {
        return getSplats();
    });

    events.function('scene.empty', () => {
        return getSplats().length === 0;
    });

    // Include the document archive as well as imported files, including hidden layers.
    events.function('scene.sourcesOf', (handle: FileSystemFileHandle) => {
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        return sourcesOf(splats.flatMap(splat => splat.resource.fileSources).concat(events.invoke('doc.fileSources')), handle);
    });

    // Shared by document and splat writes. The document may exclude
    // its own archive source because an in-place save rebinds it afterwards.
    events.function('scene.pickWriteTarget', async (
        location: FileSystemDirectoryHandle,
        filename: string,
        confirm: (handle: FileSystemFileHandle) => Promise<boolean>,
        exclude?: BlobReadSource
    ) => {
        const target = await pickWriteTarget(location, filename);
        if (target.exists) {
            const sources = (await events.invoke('scene.sourcesOf', target.handle) as BlobReadSource[])
            .filter(source => source !== exclude);
            if (sources.length > 0) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.error'),
                    message: i18n.t('popup.overwrite-source')
                });
                return null;
            }
            if (!await confirm(target.handle)) return null;
        }
        return target;
    });

    const importSelectedSequence = async () => {
        const directory = await window.showDirectoryPicker({ id: 'SuperSplatPlySequence', mode: 'read' });
        const candidates: ImportFile[] = [];
        for await (const handle of directory.values()) {
            if (handle.kind === 'file' && plyFrame(handle.name)) {
                candidates.push({ filename: handle.name, handle, contents: await handle.getFile() });
            }
        }
        const groups = new Map<string, ImportFile[]>();
        candidates.forEach((candidate) => {
            const match = plyFrame(candidate.filename)!;
            const key = `${match.prefix}|${match.compressed}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(candidate);
        });
        const sequences = Array.from(groups.values())
        .filter(group => group.length > 1)
        .map(group => group.sort((a, b) => plyFrame(a.filename)!.frame - plyFrame(b.filename)!.frame));
        if (sequences.length === 0) {
            throw new Error(i18n.t('scene.no-ply-sequence'));
        }

        // A file picker handle cannot reveal its parent directory. Once the
        // directory is granted, let the artist select the first frame here.
        const dialog = document.createElement('dialog');
        dialog.className = 'ply-sequence-dialog';
        const title = document.createElement('p');
        title.textContent = i18n.t('scene.select-first-frame');
        const select = document.createElement('select');
        sequences.forEach((sequence, index) => {
            const option = document.createElement('option');
            option.value = `${index}`;
            option.textContent = sequence[0].filename;
            select.append(option);
        });
        const confirm = document.createElement('button');
        confirm.textContent = i18n.t('scene.import-sequence');
        const cancel = document.createElement('button');
        cancel.textContent = i18n.t('scene.cancel-sequence');
        dialog.append(title, select, confirm, cancel);
        document.body.append(dialog);
        const selection = await new Promise<number | null>((resolve) => {
            confirm.onclick = () => resolve(Number(select.value));
            cancel.onclick = () => resolve(null);
            dialog.oncancel = () => resolve(null);
            dialog.showModal();
        });
        if (dialog.open) dialog.close();
        dialog.remove();
        if (selection !== null) await importFiles(sequences[selection]);
    };

    const chooseImportMode = async (): Promise<boolean | null> => {
        const dialog = document.createElement('dialog');
        dialog.className = 'ply-sequence-dialog';
        const title = document.createElement('h2');
        title.textContent = i18n.t('scene.import-files');
        const option = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.disabled = !window.showDirectoryPicker;
        option.append(checkbox, document.createTextNode(i18n.t('scene.select-sequence')));
        const browse = document.createElement('button');
        browse.textContent = i18n.t('scene.choose-files');
        checkbox.onchange = () => {
            browse.textContent = i18n.t(checkbox.checked ? 'scene.choose-folder' : 'scene.choose-files');
        };
        const cancel = document.createElement('button');
        cancel.textContent = i18n.t('scene.cancel-sequence');
        dialog.append(title, option, browse, cancel);
        document.body.append(dialog);
        const result = await new Promise<boolean | null>((resolve) => {
            browse.onclick = () => resolve(checkbox.checked);
            cancel.onclick = () => resolve(null);
            dialog.oncancel = () => resolve(null);
            dialog.showModal();
        });
        if (dialog.open) dialog.close();
        dialog.remove();
        return result;
    };

    events.function('scene.import', async () => {
        const selectSequence = await chooseImportMode();
        if (selectSequence === null) return;
        if (selectSequence && window.showDirectoryPicker) {
            try {
                await importSelectedSequence();
            } catch (error) {
                if (error.name !== 'AbortError') await showLoadError(error.message ?? error, 'PLY sequence');
            }
            return;
        }
        if (fileSelector) {
            fileSelector.click();
        } else {
            try {
                const handles = await window.showOpenFilePicker({
                    id: 'SuperSplatFileImport',
                    multiple: true,
                    excludeAcceptAllOption: false,
                    types: [
                        allImportTypes,
                        filePickerTypes.ply,
                        filePickerTypes.compressedPly,
                        filePickerTypes.splat,
                        filePickerTypes.sog,
                        filePickerTypes.lcc,
                        filePickerTypes.ksplat,
                        filePickerTypes.spz,
                        filePickerTypes.indexTxt,
                        filePickerTypes.abc
                    ]
                });

                const files = [];
                for (let i = 0; i < handles.length; i++) {
                    files.push({
                        filename: handles[i].name,
                        contents: await handles[i].getFile(),
                        handle: handles[i]
                    });
                }

                importFiles(files);

            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error(error);
                }
            }
        }
    });

    events.function('scene.importCamera', async () => {
        try {
            if (window.showOpenFilePicker) {
                const handles = await window.showOpenFilePicker({
                    id: 'SuperSplatCameraImport',
                    multiple: false,
                    types: [filePickerTypes.abc, filePickerTypes.indexTxt, {
                        description: 'Camera Poses JSON',
                        accept: { 'application/json': ['.json'] }
                    }]
                });
                await importFiles(await Promise.all(handles.map(async handle => ({
                    filename: handle.name,
                    contents: await handle.getFile(),
                    handle
                }))));
            } else {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.abc,.json,.txt';
                input.hidden = true;
                document.body.append(input);
                input.onchange = async () => {
                    const file = input.files?.[0];
                    if (file) await importFiles([{ filename: file.name, contents: file }]);
                    input.remove();
                };
                input.addEventListener('cancel', () => input.remove());
                input.click();
            }
        } catch (error) {
            if (error.name !== 'AbortError') console.error(error);
        }
    });

    // import a recent entry again, restoring read access to its items first
    events.function('scene.importRecent', async (entry: RecentImport) => {
        try {
            for (const handle of entry.handles) {
                if (await handle.queryPermission({ mode: 'read' }) !== 'granted' &&
                    await handle.requestPermission({ mode: 'read' }) !== 'granted') {
                    return;
                }
            }

            const files = (await resolveHandleFiles(entry.handles)).map((f) => {
                return {
                    filename: f.filename,
                    contents: f.file,
                    handle: f.handle,
                    root: f.root
                };
            });
            await importFiles(files);
        } catch (error) {
            if (error.name !== 'AbortError') {
                await showLoadError(error.message ?? error, entry.name);
            }
        }
    });

    // open a folder
    events.function('scene.openAnimation', async () => {
        try {
            const handle = await window.showDirectoryPicker({
                id: 'SuperSplatFileOpenAnimation',
                mode: 'readwrite'
            });

            if (handle) {
                const files = [];
                for await (const value of handle.values()) {
                    if (value.kind === 'file') {
                        const file = await value.getFile();
                        if (file.name.toLowerCase().endsWith('.ply')) {
                            files.push(file);
                        }
                    }
                }
                if (files.length > 0 && isPlySequence(files.map(file => file.name))) {
                    events.fire('sequence.setPlyFrames', files);
                    events.fire('timeline.setFrame', events.invoke('timeline.startFrame'));
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error(error);
            }
        }
    });

    let exportSettings: ExportSettings = {};
    const exportSettingsReady = loadExportSettings().then((settings) => {
        exportSettings = settings;
    }).catch((error) => {
        console.warn('Export settings could not be restored', error);
    });

    const persistExportSettings = () => saveExportSettings(exportSettings).catch((error) => {
        console.warn('Export settings could not be saved', error);
    });

    events.function('scene.pickExportDirectory', async (reuse = false) => {
        await exportSettingsReady;
        try {
            if (reuse && exportSettings.directory) {
                await exportSettings.directory.requestPermission({ mode: 'readwrite' });
                return await events.invoke('scene.getExportDirectory');
            }

            exportSettings.directory = await window.showDirectoryPicker({
                id: 'SuperSplatFileExport',
                mode: 'readwrite',
                startIn: exportSettings.directory
            });
            await persistExportSettings();
            return exportSettings.directory;
        } catch (error) {
            if (error.name !== 'AbortError') {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.error'),
                    message: `${error.message ?? error}`
                });
            }
            return null;
        }
    });

    events.function('scene.getExportDirectory', async () => {
        await exportSettingsReady;
        let directory = exportSettings.directory;
        if (directory) {
            try {
                const permission = await directory.queryPermission({ mode: 'readwrite' });
                // Keep the handle so the folder button can restore access.
                if (permission === 'prompt') return undefined;
                if (permission !== 'granted') {
                    directory = undefined;
                } else {
                    // A saved handle can outlive the folder it refers to.
                    await directory.values().next();
                }
            } catch {
                directory = undefined;
            }
            if (!directory) {
                exportSettings.directory = undefined;
                await persistExportSettings();
            }
        }
        return directory;
    });

    const showExportError = async (error: any) => {
        if (error.name !== 'AbortError') {
            console.error(error);
            await events.invoke('showPopup', {
                type: 'error',
                header: i18n.t('popup.error'),
                message: `${error.message ?? error}`
            });
        }
    };

    // Write the scene with the export dialog's choices: to the picked file or,
    // without the File System Access API, as a download. Returns true when written.
    const exportScene = async (exportType: ExportType, choices: ExportChoices, fileTarget?: WriteTarget) => {
        const options = buildExportOptions(events, exportType, choices);

        const fileType: FileType =
            (exportType === 'viewer') ? (options.viewerExportSettings!.type === 'zip' ? 'packageViewer' : 'htmlViewer') :
                (exportType === 'ply') ? (options.compressedPly ? 'compressedPly' : 'ply') :
                    (exportType === 'sog') ? 'sog' :
                        (exportType === 'spz') ? 'spz' : 'splat';

        if (!fileTarget) {
            return await events.invoke('scene.write', fileType, options) as boolean;
        }

        let written = false;
        try {
            try {
                written = await events.invoke('scene.write', fileType, options, await fileTarget.handle.createWritable());
            } finally {
                if (!written) await fileTarget.discard?.();
            }
        } catch (error) {
            await showExportError(error);
        }
        return written;
    };

    // the last successful export, so it can be repeated with the same choices
    let lastExport: { exportType: ExportType, choices: ExportChoices, directory?: FileSystemDirectoryHandle } = null;

    const setLastExport = (value: typeof lastExport) => {
        lastExport = value;
        events.fire('scene.lastExport', lastExport);
    };

    events.on('scene.clear', () => {
        setLastExport(null);
    });

    // One export at a time: the progress overlays don't take focus, so the
    // re-export shortcut could otherwise start a second write mid-export.
    let exporting = false;

    events.function('scene.export', async (exportType: ExportType) => {
        if (exporting) return;
        exporting = true;
        try {
            const splats = getSplats();
            const hasFilePicker = !!window.showDirectoryPicker;

            await exportSettingsReady;
            const directory = hasFilePicker ? await events.invoke('scene.getExportDirectory') : undefined;

            const result = await events.invoke('show.exportPopup', exportType, splats.map(s => s.name), { directory }) as ExportDialogResult;

            // return if user cancelled
            if (!result) {
                return;
            }

            const { directory: exportDirectory, fileTarget, ...choices } = result;
            if (await exportScene(exportType, choices, fileTarget)) {
                setLastExport({ exportType, choices, directory: exportDirectory });
            }
        } finally {
            exporting = false;
        }
    });

    // Repeat the last export against the current scene, overwriting its file.
    // A file the scene still reads from is refused as usual.
    events.on('scene.reexport', async () => {
        if (exporting || !lastExport || getSplats().length === 0) return;
        exporting = true;
        try {
            const { exportType, choices, directory } = lastExport;
            let fileTarget: WriteTarget;
            if (directory) {
                fileTarget = await events.invoke('scene.pickWriteTarget', directory, choices.filename, () => Promise.resolve(true));
                if (!fileTarget) return;
            }
            await exportScene(exportType, choices, fileTarget);
        } catch (error) {
            await showExportError(error);
        } finally {
            exporting = false;
        }
    });

    events.function('scene.write', async (fileType: FileType, options: SceneExportOptions, stream?: FileSystemWritableFileStream) => {
        // SOG, SPZ and viewer exports have their own progress UI, other formats use spinner
        const useSpinner = fileType !== 'sog' && fileType !== 'spz' && fileType !== 'htmlViewer' && fileType !== 'packageViewer';

        if (useSpinner) {
            events.fire('startSpinner');
        }

        try {
            // setTimeout so spinner/progress has a chance to activate
            await new Promise<void>((resolve) => {
                setTimeout(resolve);
            });

            const { filename, splatIdx, serializeSettings, viewerExportSettings } = options;

            // Create FileSystem for output
            const fs = new BrowserFileSystem(filename, stream);

            const splats = splatIdx === 'all' ? getSplats() : [getSplats()[splatIdx]];

            switch (fileType) {
                case 'ply':
                    await writeSplatFile(splats, serializeSettings, 'ply', 'output.ply', {}, fs);
                    break;
                case 'compressedPly':
                    serializeSettings.minOpacity = 1 / 255;
                    serializeSettings.removeInvalid = true;
                    await writeSplatFile(splats, serializeSettings, 'compressed-ply', 'output.compressed.ply', {}, fs);
                    break;
                case 'splat':
                    await writeSplatFile(splats, serializeSettings, 'splat', 'output.splat', {}, fs);
                    break;
                case 'sog': {
                    const sogSettings: SogSettings = {
                        ...serializeSettings,
                        minOpacity: 1 / 255,
                        removeInvalid: true,
                        iterations: options.sogIterations ?? 10,
                        events
                    };
                    await serializeSog(splats, sogSettings, fs);
                    break;
                }
                case 'spz': {
                    const spzSettings: SpzSettings = {
                        ...serializeSettings,
                        minOpacity: 1 / 255,
                        removeInvalid: true,
                        version: options.spzVersion ?? 4,
                        events
                    };
                    await serializeSpz(splats, spzSettings, fs);
                    break;
                }
                case 'htmlViewer':
                case 'packageViewer':
                    await serializeViewer(splats, serializeSettings, { ...viewerExportSettings!, events }, fs);
                    break;
            }
            return true;
        } catch (error) {
            // Release the writable stream before a newly created target is removed.
            await stream?.abort().catch(() => { /* the writer may already have aborted */ });
            if (error instanceof WebGPUUnavailableError) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.error'),
                    message: i18n.t('popup.webgpu-unavailable')
                });
            } else {
                const message = error instanceof Error ? error.message : String(error);
                await events.invoke('showPopup', {
                    type: 'error',
                    header: i18n.t('popup.error'),
                    message: `${message} while saving file`
                });
            }
            return false;
        } finally {
            if (useSpinner) {
                events.fire('stopSpinner');
            }
        }
    });
};

export { initFileHandler };
