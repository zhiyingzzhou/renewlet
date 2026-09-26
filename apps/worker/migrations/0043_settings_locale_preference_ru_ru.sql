-- 只扩展 localePreference 白名单以接受 ru-RU；不改写任何 settings 数据，旧值仍全部合法。
DROP TRIGGER IF EXISTS renewlet_settings_locale_contract_insert;
DROP TRIGGER IF EXISTS renewlet_settings_locale_contract_update;

CREATE TRIGGER renewlet_settings_locale_contract_insert
BEFORE INSERT ON settings
FOR EACH ROW
WHEN CASE
  WHEN json_valid(NEW.settings_json) = 0 THEN 1
  WHEN json_type(NEW.settings_json) IS NOT 'object' THEN 1
  WHEN EXISTS (SELECT 1 FROM json_each(NEW.settings_json) GROUP BY key HAVING COUNT(*) > 1) THEN 1
  WHEN json_type(NEW.settings_json, '$.locale') IS NOT NULL THEN 1
  WHEN json_type(NEW.settings_json, '$.localePreference') IS NOT 'text' THEN 1
  WHEN json_extract(NEW.settings_json, '$.localePreference') NOT IN ('auto', 'zh-CN', 'en-US', 'ru-RU') THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'SETTINGS_LOCALE_CONTRACT_INVALID');
END;

CREATE TRIGGER renewlet_settings_locale_contract_update
BEFORE UPDATE OF settings_json ON settings
FOR EACH ROW
WHEN CASE
  WHEN json_valid(NEW.settings_json) = 0 THEN 1
  WHEN json_type(NEW.settings_json) IS NOT 'object' THEN 1
  WHEN EXISTS (SELECT 1 FROM json_each(NEW.settings_json) GROUP BY key HAVING COUNT(*) > 1) THEN 1
  WHEN json_type(NEW.settings_json, '$.locale') IS NOT NULL THEN 1
  WHEN json_type(NEW.settings_json, '$.localePreference') IS NOT 'text' THEN 1
  WHEN json_extract(NEW.settings_json, '$.localePreference') NOT IN ('auto', 'zh-CN', 'en-US', 'ru-RU') THEN 1
  ELSE 0
END = 1
BEGIN
  SELECT RAISE(ABORT, 'SETTINGS_LOCALE_CONTRACT_INVALID');
END;
