export const sceneKey = index => index === 0 ? 'video' : `video-${index}`;
export const sceneKeys = job => Array.from({length: job.sceneCount ?? 1}, (_, index) => sceneKey(index));
export const partKeys = job => ['audio', ...sceneKeys(job)];
export const mediaKind = key => key === 'audio' ? 'audio' : 'video';
export function publicAssets(job) {
  const scenes = sceneKeys(job).filter(key => job.assets?.[key]).map(key => ({key, ...job.assets[key]}));
  const descriptor = file => ({sha256: file.sha256, duration: file.duration, byteLength: file.byteLength,
    contentType: file.contentType, ...(file.width ? {width: file.width, height: file.height} : {})});
  return {...(job.assets?.audio ? {audio: descriptor(job.assets.audio)} : {}),
    ...(scenes.length ? {video: descriptor(scenes[0]), scenes: scenes.map(scene => ({key: scene.key, ...descriptor(scene)}))} : {})};
}
