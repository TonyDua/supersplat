import { Container, SelectInput } from '@playcanvas/pcui';

import { CameraSets } from '../camera-poses';
import { Events } from '../events';
import { i18n } from './localization';
import { Tooltips } from './tooltips';

// the free camera is the absence of a camera set
const FREE_VALUE = 'free';

/**
 * Viewport camera picker: the free camera or one of the camera sets, in the
 * top left of the viewport. Picking a set looks through it, which also stops
 * navigation so a shot camera stays where its animation puts it.
 */
class CameraPicker extends Container {
    constructor(events: Events, tooltips: Tooltips) {
        super({
            id: 'camera-picker',
            hidden: true
        });

        // keep pointer events off the canvas so using the picker does not also
        // move the camera underneath it
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        let names: string[] = [];

        // the value the picker is currently showing: writing it while syncing
        // from `camera.sets` must not be mistaken for a user choice
        let shownValue = FREE_VALUE;

        const select = new SelectInput({
            class: 'camera-picker-select'
        });

        i18n.bindOptions(select, () => [
            { v: FREE_VALUE, t: i18n.t('camera-picker.free') },
            ...names.map((name, i) => ({ v: `${i}`, t: name }))
        ]);

        select.on('change', (value: string) => {
            if (value === shownValue) {
                return;
            }
            events.fire('camera.setActiveSet', value === FREE_VALUE ? -1 : parseInt(value, 10));
        });

        tooltips.register(select, () => i18n.t('tooltip.camera-picker'), 'bottom');

        this.append(select);

        events.on('camera.sets', (state: CameraSets) => {
            names = state.names;
            shownValue = state.lookThrough ? `${state.active}` : FREE_VALUE;
            select.options = [
                { v: FREE_VALUE, t: i18n.t('camera-picker.free') },
                ...names.map((name, i) => ({ v: `${i}`, t: name }))
            ];
            select.value = shownValue;
            this.hidden = names.length === 0;
        });
    }
}

export { CameraPicker };
