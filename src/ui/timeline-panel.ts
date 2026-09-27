import { Button, Container, Element, Label, NumericInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { i18n } from './localization';
import { Tooltips } from './tooltips';

class Ticks extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'ticks'
        };

        super(args);

        const workArea = new Container({
            id: 'ticks-area'
        });

        this.append(workArea);

        let frameFromOffset: (offset: number) => number;
        let moveCursor: (frame: number) => void;
        let cacheRanges: Array<[number, number]> = [];

        const updateCacheRanges = () => {
            workArea.dom.querySelectorAll('.sequence-cache-range').forEach(el => el.remove());
            if (!cacheRanges.length) return;
            const count = events.invoke('timeline.frames') as number;
            const start = events.invoke('timeline.startFrame') as number;
            const width = workArea.dom.getBoundingClientRect().width - 40;
            for (const [from, to] of cacheRanges) {
                const bar = document.createElement('div');
                bar.className = 'sequence-cache-range';
                const left = 20 + (from - start) / Math.max(1, count - 1) * width;
                const right = 20 + (to - start) / Math.max(1, count - 1) * width;
                bar.style.left = `${left}px`;
                bar.style.width = `${Math.max(2, right - left + 2)}px`;
                workArea.dom.append(bar);
            }
        };

        // pcui wrappers around key markers, kept so their tooltips unregister
        // (via the destroy event) when the timeline is rebuilt
        let keyElements: Element[] = [];

        // rebuild the timeline
        const rebuild = () => {
            // clear existing labels
            keyElements.forEach(el => el.destroy());
            keyElements = [];
            workArea.dom.innerHTML = '';

            const numFrames = events.invoke('timeline.frames');
            const startFrame = events.invoke('timeline.startFrame');
            const endFrame = startFrame + numFrames - 1;
            const currentFrame = events.invoke('timeline.frame');

            const padding = 20;
            const width = this.dom.getBoundingClientRect().width - padding * 2;

            // round the smallest step that keeps labels ~50px apart up to the
            // 1/2/5 * 10^n series so labels land on round frame numbers
            const minStep = Math.max(1, numFrames / Math.max(1, Math.floor(width / 50)));
            const magnitude = 10 ** Math.floor(Math.log10(minStep));
            const labelStep = [1, 2, 5, 10].map(m => m * magnitude).find(s => s >= minStep) ?? 10 * magnitude;

            // subdivide labels with minor ticks (fifths, or halves for 1/2 steps)
            const tickStep = labelStep === 1 ? 0 : labelStep / (labelStep % 5 === 0 ? 5 : 2);

            const offsetFromFrame = (frame: number) => {
                return padding + Math.floor((frame - startFrame) / Math.max(1, numFrames - 1) * width);
            };

            frameFromOffset = (offset: number) => {
                return Math.max(startFrame, Math.min(endFrame, startFrame + Math.floor((offset - padding) / width * (numFrames - 1))));
            };

            // timeline labels

            for (let frame = Math.ceil(startFrame / labelStep) * labelStep; frame <= endFrame; frame += labelStep) {
                const label = document.createElement('div');
                label.classList.add('time-label');
                label.style.left = `${offsetFromFrame(frame)}px`;
                label.textContent = frame.toString();
                workArea.dom.appendChild(label);
            }

            // minor ticks

            if (tickStep > 0) {
                for (let frame = Math.ceil(startFrame / tickStep) * tickStep; frame <= endFrame; frame += tickStep) {
                    if (frame % labelStep !== 0) {
                        const tick = document.createElement('div');
                        tick.classList.add('time-tick');
                        tick.style.left = `${offsetFromFrame(frame)}px`;
                        workArea.dom.appendChild(tick);
                    }
                }
            }

            // keys - get from active track
            const keys = events.invoke('track.keys') as number[] ?? [];

            // Source handles outside the Global playback range remain valid.
            const inRangeKeys = keys.filter(k => k >= startFrame && k <= endFrame);
            const outOfRangeKeys = keys.filter(k => k < startFrame || k > endFrame).sort((a, b) => a - b);

            // center of a pinned marker: 10px right of the last frame, staggered
            // 2px per extra marker, capped so the 8px diamond stays inside the
            // 20px right padding
            const pinnedOffset = (index: number) => {
                return padding + width + 10 + Math.min(index, 3) * 2;
            };

            const createKey = (keyFrame: number, pinnedIndex = -1) => {
                const outOfRange = pinnedIndex !== -1;

                const label = document.createElement('div');
                label.classList.add('time-label', 'key');
                if (outOfRange) {
                    label.classList.add('out-of-range');
                }
                label.style.left = `${outOfRange ? pinnedOffset(pinnedIndex) : offsetFromFrame(keyFrame)}px`;
                label.dataset.frame = keyFrame.toString();

                const wrapper = new Element({ dom: label });
                tooltips.register(wrapper, () => (outOfRange ?
                    i18n.t('tooltip.timeline.key-out-of-range', { frame: keyFrame }) :
                    i18n.t('tooltip.timeline.key')), 'top');
                keyElements.push(wrapper);
                let dragging = false;
                let copying = false;
                let clone: HTMLElement = null;
                let toFrame = -1;

                label.addEventListener('pointerdown', (event) => {
                    if (!dragging && event.isPrimary) {
                        dragging = true;
                        copying = event.shiftKey;
                        label.setPointerCapture(event.pointerId);
                        event.stopPropagation();

                        if (copying) {
                            // create a visual clone to drag; original stays in place
                            clone = document.createElement('div');
                            clone.classList.add('time-label', 'key', 'dragging');
                            clone.style.left = label.style.left;
                            workArea.dom.appendChild(clone);
                            label.classList.add('copying');
                        } else {
                            label.classList.add('dragging');
                        }
                    }
                });

                label.addEventListener('pointermove', (event: PointerEvent) => {
                    if (dragging) {
                        toFrame = frameFromOffset(parseInt(label.style.left, 10) + event.offsetX);
                        if (copying) {
                            clone.style.left = `${offsetFromFrame(toFrame)}px`;
                        } else {
                            // once dragged, the key can only land in range
                            label.classList.remove('out-of-range');
                            label.style.left = `${offsetFromFrame(toFrame)}px`;
                        }
                    } else {
                        // hint that ctrl+click overwrites the key with the current pose
                        label.classList.toggle('stamping', event.ctrlKey);
                    }
                });

                label.addEventListener('pointerup', (event: PointerEvent) => {
                    if (dragging && event.isPrimary) {
                        const fromFrame = parseInt(label.dataset.frame, 10);

                        // Clean up DOM state before firing events, since event
                        // handlers may call rebuild() which clears workArea.
                        if (copying) {
                            workArea.dom.removeChild(clone);
                            clone = null;
                            label.classList.remove('copying');
                        } else {
                            label.classList.remove('dragging');
                        }

                        label.releasePointerCapture(event.pointerId);

                        if (event.ctrlKey && (toFrame < 0 || toFrame === fromFrame)) {
                            // ctrl+click without dragging: overwrite this key
                            // with the current camera pose
                            events.fire('track.addKey', fromFrame);
                        } else if (fromFrame !== toFrame && toFrame >= 0) {
                            if (copying) {
                                events.fire('track.copyKey', fromFrame, toFrame);
                            } else {
                                events.fire('track.moveKey', fromFrame, toFrame);
                            }
                        }

                        copying = false;
                        dragging = false;
                    }
                });

                workArea.dom.appendChild(label);
            };

            inRangeKeys.forEach((keyFrame: number) => {
                createKey(keyFrame);
            });

            // ascending order so the marker for the largest frame renders topmost
            outOfRangeKeys.forEach((keyFrame: number, index: number) => {
                createKey(keyFrame, index);
            });

            // cursor

            const cursor = document.createElement('div');
            cursor.classList.add('time-label', 'cursor');
            cursor.style.left = `${offsetFromFrame(currentFrame)}px`;
            cursor.textContent = currentFrame.toString();
            workArea.dom.appendChild(cursor);

            updateCacheRanges();

            moveCursor = (frame: number) => {
                cursor.style.left = `${offsetFromFrame(frame)}px`;
                cursor.textContent = frame.toString();
            };
        };

        // handle scrubbing

        let scrubbing = false;

        workArea.dom.addEventListener('pointerdown', (event: PointerEvent) => {
            if (!scrubbing && event.isPrimary) {
                scrubbing = true;
                workArea.dom.setPointerCapture(event.pointerId);
                events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
            }
        });

        workArea.dom.addEventListener('pointermove', (event: PointerEvent) => {
            if (scrubbing) {
                events.fire('timeline.setFrame', frameFromOffset(event.offsetX));
            }
        });

        workArea.dom.addEventListener('pointerup', (event: PointerEvent) => {
            if (scrubbing && event.isPrimary) {
                workArea.dom.releasePointerCapture(event.pointerId);
                scrubbing = false;
            }
        });

        // update the stamp cursor hint when ctrl changes while already
        // hovering a key (pointermove alone misses a stationary pointer)
        const updateStamping = (down: boolean) => {
            const hovered = workArea.dom.querySelector('.key:hover');
            workArea.dom.querySelectorAll('.key.stamping').forEach((el) => {
                if (!down || el !== hovered) el.classList.remove('stamping');
            });
            if (down && hovered) hovered.classList.add('stamping');
        };

        const onCtrlDown = (event: KeyboardEvent) => {
            if (event.key === 'Control' && !event.repeat) updateStamping(true);
        };

        const onCtrlUp = (event: KeyboardEvent) => {
            if (event.key === 'Control') updateStamping(false);
        };

        // ctrl released while the window is unfocused never fires keyup
        const onBlur = () => updateStamping(false);

        window.addEventListener('keydown', onCtrlDown);
        window.addEventListener('keyup', onCtrlUp);
        window.addEventListener('blur', onBlur);

        this.on('destroy', () => {
            keyElements.forEach(el => el.destroy());
            keyElements = [];
            window.removeEventListener('keydown', onCtrlDown);
            window.removeEventListener('keyup', onCtrlUp);
            window.removeEventListener('blur', onBlur);
        });

        // rebuild the timeline on dom resize
        new ResizeObserver(() => rebuild()).observe(workArea.dom);

        // rebuild when timeline frames change
        events.on('timeline.frames', () => {
            rebuild();
        });

        events.on('timeline.startFrame', () => rebuild());

        events.on('timeline.frame', (frame: number) => {
            moveCursor(frame);
        });

        events.on('sequence.cacheStatus', (status: { ranges: Array<[number, number]> }) => {
            cacheRanges = status.ranges;
            updateCacheRanges();
        });

        // rebuild when track keys change
        events.on('track.keyAdded', () => {
            rebuild();
        });

        events.on('track.keyRemoved', () => {
            rebuild();
        });

        events.on('track.keyMoved', () => {
            rebuild();
        });

        events.on('track.keyUpdated', () => {
            rebuild();
        });

        events.on('track.keysLoaded', () => {
            rebuild();
        });

        events.on('track.keysCleared', () => {
            rebuild();
        });
    }
}

class TimelinePanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'timeline-panel'
        };

        super(args);

        // play controls

        const prev = new Button({
            class: 'button',
            text: '\uE162'
        });

        const play = new Button({
            class: 'button',
            text: '\uE131'
        });

        const next = new Button({
            class: 'button',
            text: '\uE164'
        });

        // key controls

        const addKey = new Button({
            class: 'button',
            text: '\uE120'
        });

        const removeKey = new Button({
            class: 'button',
            text: '\uE121',
            enabled: false
        });

        const buttonControls = new Container({
            id: 'button-controls'
        });
        buttonControls.append(prev);
        buttonControls.append(play);
        buttonControls.append(next);
        buttonControls.append(addKey);
        buttonControls.append(removeKey);

        // settings

        const cache = new Button({
            id: 'sequence-cache',
            text: i18n.t('timeline.cache'),
            enabled: false
        });
        cache.on('click', () => events.fire('sequence.toggleCache'));
        const updateCache = (status: { available: boolean, enabled: boolean, loading: boolean,
            cached: number, total: number, capacity: number }) => {
            cache.enabled = status.available;
            cache.class[status.enabled ? 'add' : 'remove']('active');
            cache.text = status.loading ?
                `${i18n.t('timeline.cache')} ${status.cached}/${Math.min(status.total, status.capacity)}` :
                i18n.t('timeline.cache');
        };
        events.on('sequence.cacheStatus', updateCache);

        const inputRange = new Label({ id: 'input-range' });
        const updateInputRange = (ranges: { ply?: { start: number, end: number } | null,
            camera?: { start: number, end: number } | null }) => {
            const parts = [];
            if (ranges.ply) parts.push(`PLY ${ranges.ply.start}–${ranges.ply.end}`);
            if (ranges.camera) parts.push(`CAM ${ranges.camera.start}–${ranges.camera.end}`);
            inputRange.text = `${i18n.t('timeline.input')}: ${parts.join(' · ') || '—'}`;
        };
        events.on('timeline.inputRanges', updateInputRange);
        updateInputRange(events.invoke('timeline.inputRanges'));
        const globalLabel = new Label({ id: 'global-range', text: i18n.t('timeline.global') });

        const speed = new NumericInput({
            id: 'speed',
            value: 30,
            min: 1,
            max: 240,
            precision: 3
        });

        speed.on('change', (value: number) => {
            events.fire('timeline.setFrameRate', value);
        });

        events.on('timeline.frameRate', (frameRate: number) => {
            speed.value = frameRate;
        });

        const startFrame = new NumericInput({
            id: 'startFrame',
            value: events.invoke('timeline.startFrame'),
            min: -1000000,
            max: 1000000,
            precision: 0
        });

        startFrame.on('change', (value: number) => {
            const end = events.invoke('timeline.startFrame') + events.invoke('timeline.frames') - 1;
            events.fire('timeline.setGlobalRange', Math.min(value, end), end);
        });
        events.on('timeline.startFrame', (value: number) => {
            startFrame.value = value;
        });

        const endFrame = new NumericInput({
            id: 'endFrame',
            value: events.invoke('timeline.startFrame') + events.invoke('timeline.frames') - 1,
            min: -1000000,
            max: 1000000,
            precision: 0
        });
        endFrame.on('change', (value: number) => {
            const start = events.invoke('timeline.startFrame');
            events.fire('timeline.setGlobalRange', start, Math.max(start, value));
        });
        const syncEnd = () => {
            endFrame.value = events.invoke('timeline.startFrame') + events.invoke('timeline.frames') - 1;
        };
        events.on('timeline.startFrame', syncEnd);
        events.on('timeline.frames', syncEnd);

        const frames = new NumericInput({
            id: 'totalFrames',
            value: events.invoke('timeline.frames'),
            min: 1,
            max: 1000000,
            precision: 0,
            enabled: false
        });

        events.on('timeline.frames', (framesIn: number) => {
            frames.value = framesIn;
        });

        // smoothness

        const smoothness = new NumericInput({
            id: 'smoothness',
            min: 0,
            max: 1,
            step: 0.05,
            value: 1,
            enabled: false
        });

        smoothness.on('change', (value: number) => {
            events.fire('timeline.setSmoothness', value);
        });

        events.on('timeline.smoothness', (smoothnessIn: number) => {
            smoothness.value = smoothnessIn;
        });

        // loop

        const loop = new Button({
            id: 'loop',
            text: '\uE128'
        });

        loop.on('click', () => {
            events.fire('timeline.setLoop', !events.invoke('timeline.loop'));
        });

        events.on('timeline.loop', (loopIn: boolean) => {
            loop.class[loopIn ? 'add' : 'remove']('active');
        });

        if (events.invoke('timeline.loop')) {
            loop.class.add('active');
        }

        const settingsControls = new Container({
            id: 'settings-controls'
        });
        settingsControls.append(cache);
        settingsControls.append(inputRange);
        settingsControls.append(globalLabel);
        settingsControls.append(new Label({ class: 'field-label', text: i18n.t('timeline.fps') }));
        settingsControls.append(speed);
        settingsControls.append(new Label({ class: 'field-label', text: i18n.t('timeline.start') }));
        settingsControls.append(startFrame);
        settingsControls.append(new Label({ class: 'field-label', text: i18n.t('timeline.end') }));
        settingsControls.append(endFrame);
        settingsControls.append(new Label({ class: 'field-label', text: i18n.t('timeline.count') }));
        settingsControls.append(frames);
        settingsControls.append(new Label({ class: 'field-label', text: i18n.t('timeline.smooth') }));
        settingsControls.append(smoothness);
        settingsControls.append(loop);

        // append control groups

        const controlsWrap = new Container({
            id: 'controls-wrap'
        });

        const spacerL = new Container({
            class: 'spacer'
        });

        const spacerR = new Container({
            class: 'spacer'
        });
        spacerR.append(settingsControls);

        controlsWrap.append(spacerL);
        controlsWrap.append(buttonControls);
        controlsWrap.append(spacerR);

        const ticks = new Ticks(events, tooltips);

        this.append(controlsWrap);
        this.append(ticks);

        // ui handlers

        prev.on('click', (evt: MouseEvent) => {
            if (evt.shiftKey) {
                events.fire('timeline.prevKey');
            } else {
                events.fire('timeline.prevFrame');
            }
        });

        next.on('click', (evt: MouseEvent) => {
            if (evt.shiftKey) {
                events.fire('timeline.nextKey');
            } else {
                events.fire('timeline.nextFrame');
            }
        });

        play.on('click', () => {
            if (events.invoke('timeline.playing')) {
                events.fire('timeline.setPlaying', false);
            } else {
                events.fire('timeline.setPlaying', true);
            }
        });

        // Sync play button icon when playing state changes (e.g. via keyboard shortcut)
        events.on('timeline.playing', (isPlaying: boolean) => {
            play.text = isPlaying ? '\uE135' : '\uE131';
        });

        events.on('sequence.cacheStatus', (status: { loading: boolean }) => {
            play.enabled = !status.loading;
        });

        addKey.on('click', () => {
            events.fire('track.addKey');
        });

        removeKey.on('click', () => {
            const frame = events.invoke('timeline.frame');
            events.fire('track.removeKey', frame);
        });

        // Helper to check if the current frame has a key
        const canDeleteKey = () => {
            const keys = events.invoke('track.keys') as number[] ?? [];
            const frame = events.invoke('timeline.frame');
            return keys.includes(frame);
        };

        // Update key button states
        const updateKeyButtonStates = () => {
            removeKey.enabled = canDeleteKey();
        };

        // Update button states when frame changes
        events.on('timeline.frame', () => {
            updateKeyButtonStates();
        });

        // Update button states when track keys change
        events.on('track.keyAdded', () => {
            updateKeyButtonStates();
        });

        events.on('track.keyRemoved', () => {
            updateKeyButtonStates();
        });

        events.on('track.keyMoved', () => {
            updateKeyButtonStates();
        });

        events.on('track.keyUpdated', () => {
            updateKeyButtonStates();
        });

        events.on('track.keysLoaded', () => {
            updateKeyButtonStates();
        });

        events.on('track.keysCleared', () => {
            updateKeyButtonStates();
        });

        // cancel animation playback if user interacts with camera
        events.on('camera.controller', (type: string) => {
            if (events.invoke('timeline.playing')) {
                // stop
            }
        });

        // tooltips
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const tooltip = (localeKey: string, shortcutId?: string) => () => {
            const text = i18n.t(localeKey);
            if (shortcutId) {
                const shortcut = shortcutManager.formatShortcut(shortcutId);
                if (shortcut) {
                    return i18n.formatTooltipWithShortcut(text, shortcut);
                }
            }
            return text;
        };

        tooltips.register(prev, tooltip('tooltip.timeline.prev-frame', 'timeline.prevFrame'), 'top');
        tooltips.register(play, tooltip('tooltip.timeline.play', 'timeline.togglePlay'), 'top');
        tooltips.register(next, tooltip('tooltip.timeline.next-frame', 'timeline.nextFrame'), 'top');
        tooltips.register(addKey, tooltip('tooltip.timeline.add-key', 'track.addKey'), 'top');
        tooltips.register(removeKey, tooltip('tooltip.timeline.remove-key', 'track.removeKey'), 'top');
        tooltips.register(speed, () => i18n.t('tooltip.timeline.frame-rate'), 'top');
        tooltips.register(cache, () => i18n.t('tooltip.timeline.cache'), 'top');
        tooltips.register(startFrame, () => i18n.t('tooltip.timeline.start-frame'), 'top');
        tooltips.register(endFrame, () => i18n.t('timeline.end'), 'top');
        tooltips.register(frames, () => i18n.t('tooltip.timeline.total-frames'), 'top');
        tooltips.register(smoothness, () => i18n.t('tooltip.timeline.smoothness'), 'top');
        tooltips.register(loop, () => i18n.t('tooltip.timeline.loop'), 'top');
    }
}

export { TimelinePanel };
