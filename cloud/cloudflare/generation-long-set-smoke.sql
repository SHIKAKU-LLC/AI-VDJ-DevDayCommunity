-- 音楽60秒・映像12秒ループの5セット検証。追加承認後だけ適用する。
-- 既存の3ルームと費用予約は保持し、追加は最大$5までとする。
update vdj_events set maximum_rooms=4, maximum_cents=2250
where id='judge-staging' and enabled=1 and maximum_rooms=3 and maximum_cents=1750;
