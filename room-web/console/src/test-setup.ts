import {vi} from 'vitest';
Object.defineProperty(window,'matchMedia',{value:vi.fn(()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()}))});
class ResizeObserver {observe(){} unobserve(){} disconnect(){}}
vi.stubGlobal('ResizeObserver',ResizeObserver);
vi.stubGlobal('IntersectionObserver',class {observe(){} unobserve(){} disconnect(){}});

vi.stubGlobal('localStorage',window.localStorage);
vi.stubGlobal('sessionStorage',window.sessionStorage);
