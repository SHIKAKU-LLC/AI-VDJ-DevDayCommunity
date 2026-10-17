-- 承認済みの追加検証。既存のWan 5セット($7.50)は保持する。
-- 新たな1ルームで、H3 Maxの音楽12秒＋映像12秒を最大5セット($5)検証する。
-- 受付期限は既存の2026-10-18 23:59:59 JSTを維持する。
update vdj_events set maximum_rooms=2, maximum_cents=1250
where id='judge-staging' and enabled=1 and maximum_rooms=1 and maximum_cents=750;
