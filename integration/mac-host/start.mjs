import {fileURLToPath} from 'node:url';
import {startIndependentProcess} from './process-owner.mjs';

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2) throw Error('ROOM_ID_AND_OPTIONAL_ORIGIN_REQUIRED');
try {
  const ready = await startIndependentProcess({entry: fileURLToPath(new URL('./launch.mjs', import.meta.url)), args});
  console.log(JSON.stringify({started: true, ...ready}));
} catch {
  console.error('Macホストを開始できません。既存の待受と診断記録を確認してください。');
  process.exitCode = 1;
}
