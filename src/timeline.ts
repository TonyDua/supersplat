import { EventHandle } from 'playcanvas';

import { Events } from './events';

/**
 * Register global timeline events.
 * The timeline manages playback state (frames, frameRate, current frame, playing).
 * Key management is delegated to individual animation tracks via track.* events.
 */
const registerTimelineEvents = (events: Events) => {
    let frames = 180;
    let startFrame = 0;
    let frameRate = 30;
    let smoothness = 1;
    let loop = true;
    type InputRange = { start: number, end: number, name?: string, frameRate?: number };
    let plyInput: InputRange | null = null;
    let cameraInput: InputRange | null = null;
    let globalSource: 'default' | 'camera' | 'ply' | 'user' | 'document' = 'default';
    let frameRateUserEdited = false;

    // current frame
    let frame = 0;

    const setFrame = (value: number) => {
        value = Math.max(startFrame, Math.min(startFrame + frames - 1, Math.round(value)));
        if (value !== frame) {
            frame = value;
            events.fire('timeline.frame', frame);
        }
    };

    events.function('timeline.frame', () => {
        return frame;
    });

    events.on('timeline.setFrame', (value: number) => {
        setFrame(value);
    });

    // frames

    events.function('timeline.startFrame', () => startFrame);

    events.on('timeline.setStartFrame', (value: number) => {
        if (Number.isSafeInteger(value) && value !== startFrame) {
            globalSource = 'user';
            startFrame = value;
            setFrame(frame);
            events.fire('timeline.startFrame', startFrame);
        }
    });

    const setFrames = (value: number) => {
        if (value !== frames) {
            frames = value;
            // clamp a stranded playhead before announcing the new length so
            // 'timeline.frames' listeners observe a consistent frame/frames pair
            if (frame >= startFrame + frames) {
                setFrame(startFrame + frames - 1);
            }
            events.fire('timeline.frames', frames);
        }
    };

    events.function('timeline.frames', () => {
        return frames;
    });

    events.on('timeline.setFrames', (value: number) => {
        globalSource = 'user';
        setFrames(value);
    });

    // frame rate

    const setFrameRate = (value: number) => {
        if (value !== frameRate) {
            frameRate = value;
            events.fire('timeline.frameRate', frameRate);
        }
    };

    events.function('timeline.frameRate', () => {
        return frameRate;
    });

    events.on('timeline.setFrameRate', (value: number) => {
        frameRateUserEdited = true;
        setFrameRate(value);
    });

    const inputRanges = () => ({ ply: plyInput, camera: cameraInput });
    events.function('timeline.inputRanges', inputRanges);
    const setGlobalRange = (start: number, end: number) => {
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return;
        const oldStart = startFrame;
        const oldFrames = frames;
        startFrame = start;
        frames = end - start + 1;
        setFrame(frame);
        if (oldStart !== startFrame) events.fire('timeline.startFrame', startFrame);
        if (oldFrames !== frames) events.fire('timeline.frames', frames);
    };

    events.on('timeline.setGlobalRange', (start: number, end: number) => {
        globalSource = 'user';
        setGlobalRange(start, end);
    });
    events.on('timeline.setInputRange', (kind: 'ply' | 'camera', range: InputRange | null) => {
        if (range && (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.end < range.start)) return;
        if (kind === 'ply') plyInput = range;
        else cameraInput = range;
        events.fire('timeline.inputRanges', inputRanges());
        if (kind === 'camera' && range?.frameRate && !frameRateUserEdited) {
            setFrameRate(range.frameRate);
        }
        // The first source initializes the project range. A PLY sequence takes
        // precedence over a camera with layout handles unless the artist has
        // already set a Global range explicitly.
        if (range && (globalSource === 'default' || (kind === 'ply' && globalSource === 'camera'))) {
            globalSource = kind;
            setGlobalRange(range.start, range.end);
            events.fire('timeline.setFrame', range.start);
        }
    });

    // smoothness

    const setSmoothness = (value: number) => {
        if (value !== smoothness) {
            smoothness = value;
            events.fire('timeline.smoothness', smoothness);
        }
    };

    events.function('timeline.smoothness', () => {
        return smoothness;
    });

    events.on('timeline.setSmoothness', (value: number) => {
        setSmoothness(value);
    });

    // loop

    const setLoop = (value: boolean) => {
        if (value !== loop) {
            loop = value;
            events.fire('timeline.loop', loop);
        }
    };

    events.function('timeline.loop', () => {
        return loop;
    });

    events.on('timeline.setLoop', (value: boolean) => {
        setLoop(value);
    });

    // anim controls
    let animHandle: EventHandle = null;

    const play = () => {
        let time = frame;

        // handle application update tick
        animHandle = events.on('update', (dt: number) => {
            time = startFrame + ((time - startFrame + dt * frameRate) % frames);
            setFrame(Math.floor(time));
            events.fire('timeline.time', time);
        });
    };

    const stop = () => {
        animHandle.off();
        animHandle = null;
    };

    // playing state
    let playing = false;

    const setPlaying = (value: boolean) => {
        if (value !== playing) {
            playing = value;
            events.fire('timeline.playing', playing);
            if (playing) {
                play();
            } else {
                stop();
            }
        }
    };

    events.function('timeline.playing', () => {
        return playing;
    });

    events.on('timeline.setPlaying', (value: boolean) => {
        setPlaying(value);
    });

    // shortcut handlers
    events.on('timeline.togglePlay', () => {
        setPlaying(!playing);
    });

    events.on('timeline.prevFrame', () => {
        setFrame(startFrame + (frame - startFrame - 1 + frames) % frames);
    });

    events.on('timeline.nextFrame', () => {
        setFrame(startFrame + (frame - startFrame + 1) % frames);
    });

    // Key navigation - delegates to active track's keys
    const skipToKey = (dir: 'forward' | 'back') => {
        // ignore keys beyond the end of the timeline - they don't play
        const keys = (events.invoke('track.keys') as number[] ?? []).filter(k => k >= startFrame && k < startFrame + frames);

        if (keys.length > 0) {
            const orderedKeys = keys.slice().sort((a, b) => a - b);
            const l = orderedKeys.length;

            const nextKeyIndex = orderedKeys.findIndex(k => (dir === 'back' ? k >= frame : k > frame));

            if (nextKeyIndex === -1) {
                setFrame(orderedKeys[dir === 'back' ? l - 1 : 0]);
            } else {
                setFrame(orderedKeys[dir === 'back' ? (nextKeyIndex + l - 1) % l : nextKeyIndex]);
            }
        } else {
            setFrame(dir === 'back' ? startFrame : startFrame + frames - 1);
        }
    };

    events.on('timeline.prevKey', () => {
        skipToKey('back');
    });

    events.on('timeline.nextKey', () => {
        skipToKey('forward');
    });

    // clear timeline state when scene is cleared
    events.on('scene.clear', () => {
        plyInput = null;
        cameraInput = null;
        globalSource = 'default';
        frameRateUserEdited = false;
        events.fire('timeline.inputRanges', inputRanges());
        events.fire('timeline.frames', frames);
    });

    // Serialization - only global state, keys are owned by tracks

    events.function('docSerialize.timeline', () => {
        return {
            frames,
            startFrame,
            frameRate,
            frame,
            smoothness,
            loop
        };
    });

    events.function('docDeserialize.timeline', (data: any = {}) => {
        // Set values
        frames = data.frames ?? 180;
        startFrame = data.startFrame ?? 0;
        frameRate = data.frameRate ?? 30;
        frame = Math.max(startFrame, Math.min(startFrame + frames - 1, data.frame ?? startFrame));
        smoothness = data.smoothness ?? 1;
        loop = data.loop ?? true;
        globalSource = 'document';
        frameRateUserEdited = true;

        // Fire events to update UI (always fire to ensure rebuild)
        events.fire('timeline.frames', frames);
        events.fire('timeline.startFrame', startFrame);
        events.fire('timeline.frameRate', frameRate);
        events.fire('timeline.frame', frame);
        events.fire('timeline.smoothness', smoothness);
        events.fire('timeline.loop', loop);
    });
};

export { registerTimelineEvents };
