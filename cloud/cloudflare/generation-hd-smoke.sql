-- 低音と1080P映像の比較検証。承認済みの生成費用内で最大5セットを追加する。
-- 1セット$2.50、今回$12.50、以前の予約と合わせて$35.00を上限とする。
-- 既存の生成予約・素材・有効期限を維持し、検証用ルームを1つ追加する。
update vdj_events set maximum_rooms=5, maximum_cents=3500
where id='judge-staging' and enabled=1 and maximum_rooms=4 and maximum_cents=2250;
