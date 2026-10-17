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
export async function prepareMedia(bytes, kind, {ffmpeg = 'ffmpeg', ffprobe = 'ffprobe'} = {}) {
  if (!['audio', 'video'].includes(kind) || !bytes.length || bytes.length > 20 * 1024 * 1024) throw Error('MEDIA_INPUT_INVALID');
  const dir = await mkdtemp(join(tmpdir(), 'vdj-prepare-'));
  try {
    const input = join(dir, 'input'), output = join(dir, kind === 'audio' ? 'audio.wav' : 'video.mp4');
    await writeFile(input, bytes);
    const meta = JSON.parse(await run(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', input]));
    const stream = meta.streams?.find(s => s.codec_type === kind), duration = Number(meta.format?.duration);
    if (!stream || !Number.isFinite(duration)) throw Error('MEDIA_INPUT_INVALID');
    const common = ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-threads', '1', '-i', input];
    if (kind === 'audio') {
      if (duration < 23.9 || duration > 41 || stream.channels > 2 || ![44100, 48000].includes(Number(stream.sample_rate))) throw Error('MEDIA_INPUT_INVALID');
      // Outpainting returns the 16-second context followed by 24 new seconds.
      // Some provider versions return only the new tail; both layouts are bounded.
      const seek = duration >= 39.9 ? 16 : 0;
      if (duration > 25 && seek === 0) throw Error('MEDIA_INPUT_INVALID');
      await run(ffmpeg, [...common.slice(0, -2), '-ss', String(seek), '-i', input, '-t', '24', '-vn', '-ac', '2', '-ar', '44100',
        '-af', 'loudnorm=I=-14:TP=-1:LRA=9,aresample=44100,apad,atrim=duration=24,afade=t=in:d=0.015,afade=t=out:st=23.985:d=0.015',
        '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-y', output]);
      const context = join(dir, 'context.wav');
      await run(ffmpeg, ['-nostdin', '-v', 'error', '-i', output, '-ss', '8', '-t', '16', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-y', context]);
      const audio = await readFile(output), tail = await readFile(context);
      if (audio.length > 5 * 1024 * 1024 || tail.length > 3 * 1024 * 1024) throw Error('MEDIA_RESULT_INVALID');
      return {audio: artifact(audio), context: artifact(tail), duration: 24, sampleRate: 44100, channels: 2};
    }
    if (duration < 11.9 || duration > 13 || stream.width > 2048 || stream.height > 2048 || stream.width * stream.height > 2200000) throw Error('MEDIA_INPUT_INVALID');
    await run(ffmpeg, [...common, '-t', '12', '-an', '-vf', 'scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=1,trim=duration=12,setpts=PTS-STARTPTS',
      '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-map_metadata', '-1', '-y', output]);
    const video = await readFile(output);
    if (video.length > 8 * 1024 * 1024) throw Error('MEDIA_RESULT_INVALID');
    const frame = join(dir, 'last.jpg');
    await run(ffmpeg, ['-nostdin', '-v', 'error', '-ss', String(287 / 24), '-i', output, '-frames:v', '1', '-q:v', '2', '-y', frame]);
    return {video: artifact(video), frame: artifact(await readFile(frame)), duration: 12, width: 854, height: 480};
  } finally { await rm(dir, {recursive: true, force: true}); }
}

export async function joinVideoParts(first, second, {ffmpeg = 'ffmpeg', ffprobe = 'ffprobe'} = {}) {
  if (![first, second].every(b => b.length > 0 && b.length <= 8 * 1024 * 1024)) throw Error('MEDIA_INPUT_INVALID');
  const dir = await mkdtemp(join(tmpdir(), 'vdj-video-join-'));
  try {
    await writeFile(join(dir, 'first.mp4'), first); await writeFile(join(dir, 'second.mp4'), second);
    for (const name of ['first.mp4', 'second.mp4']) {
      const meta = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', join(dir, name)]));
      const s = meta.streams?.[0];
      if (meta.streams?.length !== 1 || s.codec_name !== 'h264' || s.width !== 854 || s.height !== 480 ||
          Math.abs(Number(meta.format.duration) - 12) > .01 || s.avg_frame_rate !== '24/1') throw Error('MEDIA_INPUT_INVALID');
    }
    const output = join(dir, 'joined.mp4');
    await run(ffmpeg, ['-nostdin', '-v', 'error', '-i', join(dir, 'first.mp4'), '-i', join(dir, 'second.mp4'),
      '-filter_complex', '[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-an', '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-map_metadata', '-1', '-y', output]);
    const video = await readFile(output);
    if (video.length > 16 * 1024 * 1024) throw Error('MEDIA_RESULT_INVALID');
    return {video: artifact(video), duration: 24, width: 854, height: 480};
  } finally { await rm(dir, {recursive: true, force: true}); }
}
