-- 承認後、検証環境のイベントが未作成であることを確認して1回だけ適用する。
-- 既存データの更新は行わない。2026-10-18 23:59:59 JSTに失効。
-- 1ルーム、音楽24秒＋映像24秒を最大5セット、各$1.50、合計$7.50を予約上限とする。
insert into vdj_events(id,enabled,expires_at_ms,maximum_rooms,maximum_cents)
values('judge-staging',1,1792335599000,1,750);
