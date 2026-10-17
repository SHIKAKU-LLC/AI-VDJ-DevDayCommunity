import {cueDigest, cueSourceIdentity} from '../../snapshot/app/runtime/intent-compiler.mjs';

const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const scoped = s => Object.fromEntries(['roomId', 'sessionId', 'controlRevision'].map(k => [k, s[k]]));
// Private preparation state, never a claim about a running output or credit.
export const isBootstrapPreparationSource = source => source?.playback?.actual === false &&
  source.playback.phase === 'PREPARING' && source.playback.revision === 0 && source.playback.playedUntilFrame === 0;
export function approvedBootstrapProfile(profile, parentSha256) {
  return profile?.method === 'pcm-endpoint-profile-v1' && profile.assetSha256 === parentSha256 &&
    profile.frameCount === 24 * 44100 && profile.sampleRate === 44100 && profile.channels === 2 &&
    Number.isFinite(profile.loudness?.truePeakDbtp) && profile.loudness.truePeakDbtp <= -.3 &&
    profile.nonfiniteSamples === 0 && Number.isFinite(profile.clippedFraction) && profile.clippedFraction <= .001 &&
    profile.activity?.effectiveSilence === false && Number.isFinite(profile.activity.maxQuietRunSeconds) &&
    profile.activity.maxQuietRunSeconds <= .5;
}

// Structural validation of a PRIVATE server permit, never a browser assertion.
// The producer must physically read the immutable bootstrap authority/assets;
// live dispatch authority additionally binds this evidence to the current scope.
export function verifiedBootstrapContext(context, source, {now = Date.now, expiresAtMs, scope} = {}) {
  const proof = context?.bootstrapEvidence;
  if (context?.originKind !== 'owner-supplied-bootstrap' || context.providerOriginVerified !== false ||
      context.serverAudioQC !== true || !proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
  const {evidenceSha256, ...body} = proof;
  const keys = ['kind', 'roomId', 'sessionId', 'controlRevision', 'expiresAtMs', 'authoritySha256',
    'qcEvidenceSha256', 'sourceEvidenceSha256', 'sourceSha256', 'profileSha256', 'parentAssetId', 'parentSha256',
    'contextAssetId', 'contextSha256', 'referenceAssetId', 'referenceSha256', 'playbackRevision', 'playedUntilFrame'];
  return Object.keys(body).length === keys.length && keys.every(k => Object.hasOwn(body, k)) &&
    ['verified-owner-bootstrap-context-v1', 'verified-owner-bootstrap-preparation-v1'].includes(body.kind) && sha(evidenceSha256) && cueDigest(body) === evidenceSha256 &&
    id(body.roomId) && id(body.sessionId) && Number.isSafeInteger(body.controlRevision) && body.controlRevision >= 0 &&
    (!scope || cueDigest(scoped(body)) === cueDigest(scoped(scope))) &&
    Number.isSafeInteger(body.expiresAtMs) && body.expiresAtMs > now() && body.expiresAtMs >= expiresAtMs &&
    [body.authoritySha256, body.qcEvidenceSha256, body.sourceEvidenceSha256].every(sha) &&
    body.sourceSha256 === cueDigest(cueSourceIdentity(source)) &&
    [body.parentAssetId, body.contextAssetId, body.referenceAssetId].every(id) &&
    body.parentAssetId === source.audioAssetId && body.parentSha256 === source.music.sha256 && sha(body.parentSha256) &&
    body.contextAssetId === source.contextAssetId && body.contextSha256 === source.music.contextSha256 &&
    body.referenceAssetId === source.referenceAssetId && body.referenceSha256 === source.video.referenceSha256 &&
    body.profileSha256 === cueDigest(source.music.profile) && approvedBootstrapProfile(source.music.profile, body.parentSha256) &&
    body.playbackRevision === 0 && source.playback?.revision === 0 &&
    (body.kind === 'verified-owner-bootstrap-preparation-v1' ?
      isBootstrapPreparationSource(source) && body.playedUntilFrame === 0 : source.playback.actual === true &&
    source.playback.phase === 'PLAYING' && Number.isSafeInteger(body.playedUntilFrame) && body.playedUntilFrame > 0 &&
    body.playedUntilFrame <= 24 * 44100 && Number.isSafeInteger(source.playback.playedUntilFrame) &&
    source.playback.playedUntilFrame >= body.playedUntilFrame && source.playback.playedUntilFrame <= 24 * 44100);
}
