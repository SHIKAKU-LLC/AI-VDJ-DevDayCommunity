import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const artifact = bytes => ({data: bytes.toString('base64'), sha256: hash(bytes)});
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', diagnostic = '', failed = false, failure = 'MEDIA_PROCESS_FAILED';
    const timer = setTimeout(() => { failed = true; failure = 'MEDIA_PROCESS_TIMEOUT'; child.kill('SIGKILL'); }, 90000);
    child.stderr.on('data', bytes => { if (diagnostic.length < 8192) diagnostic += bytes.toString().slice(0, 8192 - diagnostic.length); });
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 65536) { failed = true; child.kill('SIGKILL'); } });
    child.on('error', () => { clearTimeout(timer); reject(Error('MEDIA_PROCESS_FAILED')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && !failed) return resolve(output);
      if (/Resource temporarily unavailable|pthread_create/i.test(diagnostic)) failure = 'MEDIA_PROCESS_RESOURCES';
      else if (/Invalid data found|Invalid argument/i.test(diagnostic)) failure = 'MEDIA_DECODE_FAILED';
      // Return only a fixed code, never stderr, input metadata or file paths.
      reject(Error(failure));
    });
  });
}

// Only bounded bytes cross the private Container boundary. ffmpeg never receives
// a provider URL, arbitrary command, path, filter or argument from a caller.
export async function prepareMedia(bytes, kind, {ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', seconds = 24, contextSeconds = 16, mediaProfile = 'legacy'} = {}) {
  if (!['legacy', 'club-hd-v1', 'club-flow-v1'].includes(mediaProfile) || !['audio', 'video'].includes(kind) || !(kind === 'audio' ? [12, 24, 60] : [12, 24]).includes(seconds) || ![0, 12, 16].includes(contextSeconds) ||
      !bytes.length || bytes.length > 48 * 1024 * 1024) throw Error('MEDIA_INPUT_INVALID');
  const highQuality = mediaProfile !== 'legacy';
  const width = highQuality ? 1920 : 854, height = highQuality ? 1080 : 480;
  const audioTone = highQuality ? 'highpass=f=28,bass=g=3:f=85:w=0.7,equalizer=f=250:t=q:w=0.7:g=-1.5,' : '';
  const dir = await mkdtemp(join(tmpdir(), 'vdj-prepare-'));
  try {
    const input = join(dir, 'input'), output = join(dir, kind === 'audio' ? 'audio.wav' : 'video.mp4');
    await writeFile(input, bytes);
    const meta = JSON.parse(await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', input]));
    const stream = meta.streams?.find(s => s.codec_type === kind), duration = Number(meta.format?.duration);
    if (!stream || !Number.isFinite(duration)) throw Error('MEDIA_INPUT_INVALID');
    const common = ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1', '-i', input];
    if (kind === 'audio') {
      if (duration < seconds - .1 || duration > seconds + contextSeconds + 1 || stream.channels > 2 || ![44100, 48000].includes(Number(stream.sample_rate))) throw Error('MEDIA_INPUT_INVALID');
      // Outpainting may include the submitted context before the new tail.
      // Some provider versions return only the new tail; both layouts are bounded.
      const seek = contextSeconds && duration >= seconds + contextSeconds - .1 ? contextSeconds : 0;
      if (duration > seconds + 1 && seek === 0) throw Error('MEDIA_INPUT_INVALID');
      await run(ffmpeg, [...common.slice(0, -2), '-ss', String(seek), '-i', input, '-t', String(seconds), '-vn', '-ac', '2', '-ar', '44100',
        '-af', `${audioTone}loudnorm=I=${highQuality ? -11 : -14}:TP=-1.5:LRA=9,aresample=44100,apad,atrim=duration=${seconds},afade=t=in:d=0.015,afade=t=out:st=${seconds - .015}:d=0.015`,
        '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-y', output]);
      const context = join(dir, 'context.wav');
      const tailSeconds = Math.min(16, seconds);
      await run(ffmpeg, ['-nostdin', '-v', 'error', '-i', output, '-ss', String(seconds - tailSeconds), '-t', String(tailSeconds), '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-y', context]);
      const audio = await readFile(output), tail = await readFile(context);
      if (audio.length > 12 * 1024 * 1024 || tail.length > 3 * 1024 * 1024) throw Error('MEDIA_RESULT_INVALID');
      return {audio: artifact(audio), context: artifact(tail), duration: seconds, sampleRate: 44100, channels: 2};
    }
    if (duration < seconds - .1 || duration > seconds + 1 || stream.width > 2048 || stream.height > 2048 || stream.width * stream.height > 2200000) throw Error('MEDIA_INPUT_INVALID');
    const rate = String(stream.avg_frame_rate).split('/').map(Number);
    const copyVideo = mediaProfile === 'club-flow-v1' && bytes.length <= 16 * 1024 * 1024 && stream.codec_name === 'h264' && stream.width === 1920 && [1080, 1088].includes(stream.height) && Math.abs(rate[0] / rate[1] - 24) < .001;
    if (copyVideo) {
      await run(ffmpeg, [...common, '-map', '0:v:0', '-an', '-frames:v', String(seconds * 24), '-c:v', 'copy', '-movflags', '+faststart', '-map_metadata', '-1', '-y', output]);
    } else await run(ffmpeg, [...common, '-t', String(seconds), '-an', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=1,trim=duration=${seconds},setpts=PTS-STARTPTS`,
      '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', highQuality ? '18' : '22', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-map_metadata', '-1', '-y', output]);
    const video = await readFile(output);
    if (video.length > 16 * 1024 * 1024) throw Error('MEDIA_RESULT_INVALID');
    return {video: artifact(video), duration: seconds, width: copyVideo ? stream.width : width, height: copyVideo ? stream.height : height, copiedVideo: copyVideo};
  } finally { await rm(dir, {recursive: true, force: true}); }
}
