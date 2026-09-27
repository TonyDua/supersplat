import { Container, Label, NumericInput } from '@playcanvas/pcui';

import { CameraLens, CameraSets } from '../camera-poses';
import { Events } from '../events';
import { i18n } from './localization';
import arrowSvg from './svg/arrow.svg';
import cameraSvg from './svg/camera-frame-selection.svg';
import importSvg from './svg/import.svg';
import { Tooltips } from './tooltips';

const svg = (source: string) => new DOMParser().parseFromString(
    decodeURIComponent(source.substring('data:image/svg+xml,'.length)), 'image/svg+xml'
).documentElement;

class CameraPanel extends Container {
    constructor(events: Events, tooltips: Tooltips) {
        super({ class: 'camera-panel-section' });

        const header = new Container({ class: ['panel-header', 'camera-panel-header'] });
        const icon = new Label({ class: 'panel-header-icon' });
        icon.dom.append(svg(cameraSvg));
        const title = new Label({ class: 'panel-header-label' });
        i18n.bindText(title, 'panel.cameras');
        const importButton = new Container({ class: 'panel-header-button' });
        importButton.dom.append(svg(importSvg));
        importButton.dom.setAttribute('role', 'button');
        importButton.dom.setAttribute('tabindex', '0');
        importButton.dom.setAttribute('aria-label', i18n.t('panel.cameras.import'));
        importButton.on('click', (event: MouseEvent) => {
            event.stopPropagation();
            events.invoke('scene.importCamera');
        });
        importButton.dom.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                events.invoke('scene.importCamera');
            }
        });
        tooltips.register(importButton, () => i18n.t('panel.cameras.import'), 'top');
        const arrow = new Label({ class: 'camera-panel-collapse' });
        arrow.dom.append(svg(arrowSvg));
        header.append(icon);
        header.append(title);
        header.append(importButton);
        header.append(arrow);

        const content = new Container({ class: 'camera-panel-content' });
        const list = document.createElement('div');
        list.className = 'camera-panel-list';
        const details = document.createElement('div');
        details.className = 'camera-panel-details';
        content.dom.append(list, details);

        const row = (labelKey: string) => {
            const element = document.createElement('div');
            element.className = 'camera-panel-detail';
            const label = document.createElement('span');
            label.textContent = i18n.t(labelKey);
            const value = document.createElement('span');
            value.className = 'camera-panel-detail-value';
            value.textContent = '—';
            element.append(label, value);
            details.append(element);
            return value;
        };
        const focal = row('panel.cameras.focal-length');
        const filmBack = row('panel.cameras.film-back');
        const resolution = row('panel.cameras.resolution');
        const fov = row('panel.cameras.fov');
        const clip = row('panel.cameras.clipping');
        const aperture = row('panel.cameras.aperture');
        const scaleRow = document.createElement('div');
        scaleRow.className = 'camera-panel-detail';
        const scaleLabel = document.createElement('span');
        scaleLabel.textContent = i18n.t('panel.cameras.world-scale');
        const scale = new NumericInput({
            class: 'camera-panel-scale',
            value: 1,
            min: 0.000001,
            max: 100000,
            precision: 6
        });
        scaleRow.append(scaleLabel, scale.dom);
        details.append(scaleRow);
        let updatingScale = false;
        scale.on('change', (value: number) => {
            if (!updatingScale) events.fire('camera.setWorldScale', value);
        });

        const format = (value?: number) => {
            return Number.isFinite(value) && value > 0 ? Number(value.toFixed(2)).toString() : '—';
        };
        const updateDetails = () => {
            const selected = events.invoke('camera.selectedDetails') as { fov?: number,
                lens: CameraLens, worldScale: number } | null;
            const lens = selected?.lens;
            focal.textContent = lens?.focalLength ? `${format(lens.focalLength)} mm` : '—';
            filmBack.textContent = lens?.filmBackWidth && lens.filmBackHeight ?
                `${format(lens.filmBackWidth)} × ${format(lens.filmBackHeight)} mm` : '—';
            resolution.textContent = lens?.resolutionWidth && lens.resolutionHeight ?
                `${lens.resolutionWidth} × ${lens.resolutionHeight}` : i18n.t('panel.cameras.no-resolution');
            fov.textContent = selected?.fov ? `${format(selected.fov)}°` : '—';
            clip.textContent = lens?.nearClip && lens.farClip ?
                `${format(lens.nearClip)} – ${format(lens.farClip)}` : '—';
            aperture.textContent = lens?.fStop ? `f/${format(lens.fStop)}` : '—';
            updatingScale = true;
            scale.value = selected?.worldScale ?? 1;
            updatingScale = false;
            details.hidden = !selected;
        };

        const updateList = (state: CameraSets) => {
            list.replaceChildren();
            const add = (name: string, index: number, selected: boolean) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `camera-panel-item${selected ? ' selected' : ''}`;
                button.textContent = name;
                button.onclick = () => events.fire(index < 0 ? 'camera.setActiveSet' : 'camera.selectSet', index);
                if (index >= 0) {
                    button.title = i18n.t('panel.cameras.focus');
                    button.ondblclick = () => events.fire('camera.focusSelected');
                }
                list.append(button);
            };
            add(i18n.t('camera-picker.free'), -1, state.active < 0);
            state.names.forEach((name, index) => add(name, index, state.active === index));
            updateDetails();
        };
        events.on('camera.sets', updateList);
        events.on('timeline.frame', updateDetails);
        updateList(events.invoke('camera.sets'));

        this.append(header);
        this.append(content);
        header.dom.setAttribute('role', 'button');
        header.dom.setAttribute('tabindex', '0');
        header.dom.setAttribute('aria-expanded', 'true');
        const toggle = () => {
            content.hidden = !content.hidden;
            arrow.class[content.hidden ? 'remove' : 'add']('expanded');
            header.dom.setAttribute('aria-expanded', String(!content.hidden));
        };
        arrow.class.add('expanded');
        header.on('click', toggle);
        header.dom.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
            }
        });
    }
}

export { CameraPanel };
