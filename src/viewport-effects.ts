import { Events } from './events';

type ViewportEffects = {
    size: number;
    scaleX: number;
    scaleY: number;
    opacityVariation: number;
    seed: number;
};

const defaults: ViewportEffects = {
    size: 1,
    scaleX: 1,
    scaleY: 1,
    opacityVariation: 0,
    seed: 0
};

// Display-only controls. This state is not part of document serialization,
// edit history, or the splat resource and therefore cannot change exports.
const registerViewportEffects = (events: Events) => {
    let state = { ...defaults };
    events.function('viewportEffects', () => state);
    events.on('viewportEffects.set', (name: keyof ViewportEffects, value: number) => {
        const ranges: Record<keyof ViewportEffects, [number, number]> = {
            size: [0.05, 5],
            scaleX: [0.05, 5],
            scaleY: [0.05, 5],
            opacityVariation: [0, 1],
            seed: [0, 9999]
        };
        if (!Number.isFinite(value)) return;
        const [min, max] = ranges[name];
        const next = Math.max(min, Math.min(max, name === 'seed' ? Math.round(value) : value));
        if (state[name] === next) return;
        state = { ...state, [name]: next };
        events.fire('viewportEffects.changed', state);
    });
    events.on('viewportEffects.reset', () => {
        state = { ...defaults };
        events.fire('viewportEffects.changed', state);
    });
};

export { registerViewportEffects, type ViewportEffects };
