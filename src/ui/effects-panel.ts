import { Button, Container, Label, NumericInput, SliderInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { type ViewportEffects } from '../viewport-effects';
import { i18n } from './localization';
import effectsSvg from './svg/effects.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decoded = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decoded, 'image/svg+xml').documentElement;
};

class EffectsPanel extends Container {
    constructor(events: Events, tooltips: Tooltips) {
        super({ id: 'effects-panel', class: ['panel', 'options-panel'], hidden: true });

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((name) => {
            this.dom.addEventListener(name, (event: Event) => event.stopPropagation());
        });

        const header = new Container({ class: 'panel-header' });
        const icon = new Label({ class: 'panel-header-icon' });
        icon.dom.appendChild(createSvg(effectsSvg));
        const title = new Label({ class: 'panel-header-label' });
        i18n.bindText(title, 'panel.effects');
        const close = new Button({ class: 'effects-panel-close', text: '×' });
        i18n.onChange(() => close.dom.setAttribute('aria-label', i18n.t('panel.effects.close')), close);
        close.on('click', () => events.fire('effectsPanel.setVisible', false));
        header.append(icon);
        header.append(title);
        header.append(close);
        this.append(header);

        const note = new Label({ class: 'effects-panel-note' });
        i18n.bindText(note, 'panel.effects.note');
        this.append(note);

        const controls: Array<{ name: keyof ViewportEffects, input: SliderInput | NumericInput }> = [];
        const slider = (name: keyof ViewportEffects, labelKey: string, min: number, max: number, value: number) => {
            const row = new Container({ class: 'settings-panel-row' });
            const label = new Label({ class: 'settings-panel-row-label' });
            i18n.bindText(label, labelKey);
            const input = new SliderInput({ class: 'settings-panel-row-slider', min, max, precision: 2, value });
            input.on('change', (next: number) => events.fire('viewportEffects.set', name, next));
            row.append(label);
            row.append(input);
            this.append(row);
            controls.push({ name, input });
            tooltips.register(label, () => i18n.t(`${labelKey}.tooltip`), 'left');
        };

        slider('size', 'panel.effects.size', 0.05, 5, 1);
        slider('scaleX', 'panel.effects.scale-x', 0.05, 5, 1);
        slider('scaleY', 'panel.effects.scale-y', 0.05, 5, 1);
        slider('opacityVariation', 'panel.effects.opacity-variation', 0, 1, 0);

        const seedRow = new Container({ class: 'settings-panel-row' });
        const seedLabel = new Label({ class: 'settings-panel-row-label' });
        i18n.bindText(seedLabel, 'panel.effects.seed');
        const seed = new NumericInput({ class: 'effects-panel-seed', min: 0, max: 9999, precision: 0, value: 0 });
        seed.on('change', (value: number) => events.fire('viewportEffects.set', 'seed', value));
        seedRow.append(seedLabel);
        seedRow.append(seed);
        this.append(seedRow);
        controls.push({ name: 'seed', input: seed });

        const reset = new Button({ class: 'effects-panel-reset' });
        i18n.bindText(reset, 'panel.effects.reset');
        reset.on('click', () => events.fire('viewportEffects.reset'));
        this.append(reset);

        const sync = (state: ViewportEffects) => {
            controls.forEach(({ name, input }) => {
                input.value = state[name];
            });
        };
        events.on('viewportEffects.changed', sync);
        sync(events.invoke('viewportEffects'));

        const setVisible = (visible: boolean) => {
            if (this.hidden === visible) {
                this.hidden = !visible;
                events.fire('effectsPanel.visible', visible);
            }
        };
        events.function('effectsPanel.visible', () => !this.hidden);
        events.on('effectsPanel.setVisible', setVisible);
        events.on('effectsPanel.toggleVisible', () => setVisible(this.hidden));
        ['appearancePanel.visible', 'overlaysPanel.visible', 'settingsPanel.visible'].forEach((event) => {
            events.on(event, (visible: boolean) => {
                if (visible) setVisible(false);
            });
        });
    }
}

export { EffectsPanel };
