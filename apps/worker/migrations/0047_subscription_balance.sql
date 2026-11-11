-- 旧记录保持 NULL；只增加事实列，不重建订阅表或搜索投影，避免升级触发关联数据级联。
ALTER TABLE subscriptions ADD COLUMN balance TEXT;
ALTER TABLE subscriptions ADD COLUMN balance_currency TEXT
  CHECK ((balance IS NULL AND balance_currency IS NULL)
    OR (balance IS NOT NULL AND balance_currency IS NOT NULL));
