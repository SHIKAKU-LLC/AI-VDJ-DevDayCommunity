import {useEffect, useRef, useState} from 'react';
import {CreditName} from './components/credit-name';
import {createDisplayPlayer} from '../../judge-display-player.mjs';

export function DisplayScreen({id}: {id: string}) {
  const root = useRef<HTMLDivElement>(null);
  const videos = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [credit, setCredit] = useState('');
  useEffect(() => {
    document.title = 'AI VDJ · 上映専用';
    root.current?.focus({preventScroll: true});
    return createDisplayPlayer({id, videos: videos.current!, canvas: canvas.current!, onCredit: setCredit});
  }, [id]);
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void root.current?.requestFullscreen().catch(() => {});
  };
  return <div ref={root} className="display-screen" tabIndex={0} aria-label="映像表示専用。クリックまたはFキーで全画面"
    onClick={fullscreen} onKeyDown={event => {
      if (!event.ctrlKey && !event.metaKey && ['f', 'enter', ' '].includes(event.key.toLowerCase())) {event.preventDefault(); fullscreen();}
    }}>
    <div className="videos" ref={videos} />
    <canvas className="display-vj" ref={canvas} aria-hidden="true" />
    {credit && <aside className="stage-credit display-credit" aria-label="この曲のアイデア投稿者"><CreditName name={credit} /></aside>}
  </div>;
}
