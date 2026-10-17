import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const artifact = bytes => ({data: bytes.toString('base64'), sha256: hash(bytes)});
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'ignore']});
    let output = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 90000);
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 65536) { failed = true; child.kill('SIGKILL'); } });
    child.on('error', () => { clearTimeout(timer); reject(Error('MEDIA_PROCESS_FAILED')); });
    child.on('close', code => { clearTimeout(timer); code === 0 && !failed ? resolve(output) : reject(Error('MEDIA_PROCESS_FAILED')); });
  });
}

// Only bounded bytes cross the private Container boundary. ffmpeg never receives
// a provider URL, arbitrary command, path, filter or argument from a caller.
export async function prepareMedia(bytes, kind, {ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', seconds = 24, contextSeconds = 16} = {}) {
  if (!['audio', 'video'].includes(kind) || ![12, 24].includes(seconds) || ![0, 12, 16].includes(contextSeconds) ||
      !bytes.length || bytes.length > 48 * 1024 * 1024) throw Error('MEDIA_INPUT_INVALID');
  const dir = await mkdtemp(join(tmpdir(), 'vdj-prepare-'));
  try {
    const input = join(dir, 'input'), output = join(dir, kind === 'audio' ? 'audio.wav' : 'video.mp4');
    await writeFile(input, bytes);
    const meta = JSON.parse(await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', input]));
    const stream = meta.streams?.find(s => s.codec_type === kind), duration = Number(meta.format?.duration);
    if (!stream || !Number.isFinite(duration)) throw Error('MEDIA_INPUT_INVALID');
    const common = ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-threads', '1', '-i', input];
    if (kind === 'audio') {
      if (duration < seconds - .1 || duration > seconds + contextSeconds + 1 || stream.channels > 2 || ![44100, 48000].includes(Number(stream.sample_rate))) throw Error('MEDIA_INPUT_INVALID');
      // Outpainting may include the submitted context before the new tail.
      // Some provider versions return only the new tail; both layouts are bounded.
      const seek = contextSeconds && duration >= seconds + contextSeconds - .1 ? contextSeconds : 0;
      if (duration > seconds + 1 && seek === 0) throw Error('MEDIA_INPUT_INVALID');
      await run(ffmpeg, [...common.slice(0, -2), '-ss', String(seek), '-i', input, '-t', String(seconds), '-vn', '-ac', '2', '-ar', '44100',
        '-af', `loudnorm=I=-14:TP=-1:LRA=9,aresample=44100,apad,atrim=duration=${seconds},afade=t=in:d=0.015,afade=t=out:st=${seconds - .015}:d=0.015`,
        '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-y', output]);
      const context = join(dir, 'context.wav');
      const tailSeconds = Math.min(16, seconds);
      await run(ffmpeg, ['-nostdin', '-v', 'error', '-i', output, '-ss', String(seconds - tailSeconds), '-t', String(tailSeconds), '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-y', context]);
      const audio = await readFile(output), tail = await readFile(context);
      if (audio.length > 5 * 1024 * 1024 || tail.length > 3 * 1024 * 1024) throw Error('MEDIA_RESULT_INVALID');
      return {audio: artifact(audio), context: artifact(tail), duration: seconds, sampleRate: 44100, channels: 2};
    }
    if (duration < seconds - .1 || duration > seconds + 1 || stream.width > 2048 || stream.height > 2048 || stream.width * stream.height > 2200000) throw Error('MEDIA_INPUT_INVALID');
    await run(ffmpeg, [...common, '-t', String(seconds), '-an', '-vf', `scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=1,trim=duration=${seconds},setpts=PTS-STARTPTS`,
      '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-map_metadata', '-1', '-y', output]);
    const video = await readFile(output);
    if (video.length > 16 * 1024 * 1024) throw Error('MEDIA_RESULT_INVALID');
    return {video: artifact(video), duration: seconds, width: 854, height: 480};
  } finally { await rm(dir, {recursive: true, force: true}); }
}
