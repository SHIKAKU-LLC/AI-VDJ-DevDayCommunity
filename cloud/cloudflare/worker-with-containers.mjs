import {Container} from '@cloudflare/containers';
import {createNativeContainerClass} from './native-container.mjs';

export class NativeProcessor extends createNativeContainerClass(Container) {}
export {default} from './worker.mjs';
