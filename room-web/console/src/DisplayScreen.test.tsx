import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {DisplayScreen} from './DisplayScreen';
const player = vi.hoisted(() => ({start: vi.fn(),dispose: vi.fn()}));
vi.mock('../../judge-display-player.mjs', () => ({createDisplayPlayer: (options: any) => {
  player.start(options); options.onCredit('テスト投稿者'); return player.dispose;
}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('shows only the name, with fullscreen by click and keyboard and no audio or transport', () => {
  const {container,unmount}=render(<DisplayScreen id="display-test" />);
  expect(container.textContent).toContain('テスト投稿者');
  expect(container.textContent).not.toContain('このアイデアから生まれました');
  expect(container.querySelectorAll('button,input,audio,form')).toHaveLength(0);
  const stage=screen.getByLabelText('映像表示専用。クリックまたはFキーで全画面');
  stage.requestFullscreen=vi.fn(async()=>{});
  fireEvent.click(stage);fireEvent.keyDown(stage,{key:'f'});
  expect(stage.requestFullscreen).toHaveBeenCalledTimes(2);
  unmount();expect(player.dispose).toHaveBeenCalledTimes(1);
});
