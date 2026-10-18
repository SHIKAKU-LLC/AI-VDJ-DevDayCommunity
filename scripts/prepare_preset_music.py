#!/usr/bin/env python3
"""承認済みの匿名素材一覧からD1用SQLを用意する。通信・生成・DB更新は行わない。"""
import argparse
import json
import re
import uuid
from pathlib import Path


def prepare(data):
    if not re.fullmatch(r'judge-[a-z0-9-]{1,60}', data.get('eventId', '')):
        raise ValueError('イベントIDが不正です。')
    room = str(uuid.UUID(data['roomId']))
    videos = data['videoSha256']
    if len(videos) != 38 or len(set(videos)) != 38 or any(not re.fullmatch(r'[a-f0-9]{64}', v) for v in videos):
        raise ValueError('承認済み映像のSHA-256を、重複なしで38件指定してください。')
    colours = ['cyan chrome', 'violet glass', 'warm copper', 'ultraviolet crystal', 'teal liquid', 'magenta lattice']
    sounds = ['resonant acid hook', 'rhythmic FM pluck', 'glassy percussive stab', 'rolling metallic arpeggio', 'elastic filtered synth', 'short detuned lead', 'syncopated laser motif']
    items = [{'id': str(uuid.uuid4()), 'videoSha': video,
              'prompt': f'{colours[i % len(colours)]} kinetic dance sculpture, {sounds[(i // len(colours)) % len(sounds)]}, distinctive instrumental club motif {i+1}, full bass groove from the first beat.'}
             for i, video in enumerate(videos)]
    batch = str(uuid.uuid4())
    quote = lambda value: "'" + value.replace("'", "''") + "'"
    document = json.dumps({'items': items}, separators=(',', ':'), ensure_ascii=False)
    sql = ('-- 承認後に適用する。38曲・合計$4の一括予約は開始時に行う。\n'
           'insert into vdj_preset_batches(event_id,batch_id,room_id,enabled,document) values('
           + ','.join([quote(data['eventId']), quote(batch), quote(room), '1', quote(document)]) + ');\n')
    return batch, sql


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    batch, sql = prepare(json.loads(args.input.read_text()))
    args.output.write_text(sql)
    print(f'承認用SQLを作成しました。バッチID: {batch}。通信・生成・DB更新は未実施です。')


if __name__ == '__main__':
    main()
