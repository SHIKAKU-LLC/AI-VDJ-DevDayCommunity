import {waitForFixtureProgress} from './fixture-progress.mjs';

// Test-only video frame clock. PCM still advances only through the real VM
// worklet pump. A browser's video callbacks continue independently while the
// owner is awaiting an asynchronous server guard; the synthetic fixture must
// deliver those callbacks during its waits too, not just during PCM pumping.
export class SyntheticVideo {
  constructor() {this.style = {}; this.videoWidth = 160; this.videoHeight = 90; this.readyState = 3; this.currentTime = 0;
    this.frames = new Map(); this.next = 0; this.paused = true; this.removed = false; this.presentedWhilePlaying = 0;}
  get currentSrc(){return this.src;}
  setAttribute() {} removeAttribute(k) {if (k === 'src') delete this.src;}
  addEventListener() {} removeEventListener() {} load() {} pause() {this.paused = true;} remove() {this.removed = true;}
  play() {this.paused = false; return Promise.resolve();}
  requestVideoFrameCallback(fn) {const id = ++this.next; this.frames.set(id, fn); return id;}
  cancelVideoFrameCallback(id) {this.frames.delete(id);}
  present() {
    if (this.paused || this.removed) return;
    for (const [id, fn] of [...this.frames]) {this.frames.delete(id); this.presentedWhilePlaying++; fn(0, {});}
  }
}

export async function waitForSyntheticVideoProgress({videos, ...progress}) {
  return waitForFixtureProgress({...progress, yieldTurn: async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    for (const video of videos) video.present();
  }});
}
