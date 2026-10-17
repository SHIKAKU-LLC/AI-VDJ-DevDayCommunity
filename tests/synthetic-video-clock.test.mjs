import test from 'node:test';
import assert from 'node:assert/strict';
import {createVideoAdapter} from '../snapshot/ui/app/scene-video-adapter.mjs';
import {waitForFixtureProgress} from './fixture-progress.mjs';
import {SyntheticVideo, waitForSyntheticVideoProgress} from './synthetic-video-clock.mjs';

async function staged() {
  const videos = [];
  const adapter = createVideoAdapter({container: {append() {}}, loopOverlap: false, crossfadeMs: 0, decodedFrameTimeoutMs: 20,
    videoFactory: () => {const video = new SyntheticVideo(); videos.push(video); return video;}, fetchImpl: () => assert.fail('network')});
  await adapter.stage({version: 1, playbackRevision: 1, url: 'blob:example_synthetic', durationSeconds: 5,
    source: 'fake', requestId: 'example_request', assetId: 'example_asset', jobId: 'example_job'});
  adapter.onBeat({index: 1, timeMs: 0});
  // acceptedPlayback is asynchronous: the decoded callback is registered after
  // this last manual presentation, just like after the VM's final PCM block.
  videos.forEach(video => video.present());
  return {videos, adapter};
}

test('a PCM-only fixture clock reproduces decoded-frame timeout after the last manual presentation', async () => {
  const f = await staged();
  try {
    await assert.rejects(waitForFixtureProgress({ready: () => f.adapter.getState().phase === 'playing', timeoutMs: 100,
      terminal: () => f.adapter.getState().phase === 'timeout' ? {code: 'VIDEO_PRESENTATION_FAILED'} : null}),
    error => error.terminalCode === 'VIDEO_PRESENTATION_FAILED');
    assert.equal(f.adapter.getState().reason, 'decoded_frame_timeout');
    assert.equal(f.videos.reduce((sum, video) => sum + video.presentedWhilePlaying, 0), 0);
  } finally {f.adapter.dispose();}
});

test('independent synthetic video clock delivers late callbacks and respects paused, cancelled and removed decks', async () => {
  const f = await staged();
  try {
    await waitForSyntheticVideoProgress({videos: f.videos, ready: () => f.adapter.getState().phase === 'playing', timeoutMs: 100,
      terminal: () => f.adapter.getState().phase === 'timeout' ? {code: 'VIDEO_PRESENTATION_FAILED'} : null});
    assert.equal(f.adapter.getState().phase, 'playing');
    assert.equal(f.videos.reduce((sum, video) => sum + video.presentedWhilePlaying, 0), 1);
    const playing = f.videos.find(video => !video.paused); let callbacks = 0;
    const id = playing.requestVideoFrameCallback(() => callbacks++); playing.pause(); playing.present(); assert.equal(callbacks, 0);
    await playing.play(); playing.cancelVideoFrameCallback(id); playing.present(); assert.equal(callbacks, 0);
    playing.requestVideoFrameCallback(() => callbacks++); playing.remove(); playing.present(); assert.equal(callbacks, 0);
  } finally {f.adapter.dispose();}
});
