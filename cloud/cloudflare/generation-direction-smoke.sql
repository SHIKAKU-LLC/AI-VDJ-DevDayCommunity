-- 新しいDJ共通指示の1セット検証。追加承認後だけ適用する。
-- 既存の2ルームと費用予約は保持し、追加は最大$1までとする。
update vdj_events set maximum_rooms=3, maximum_cents=1350
where id='judge-staging' and enabled=1 and maximum_rooms=2 and maximum_cents=1250;
