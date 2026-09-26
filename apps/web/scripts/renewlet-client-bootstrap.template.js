(function () {
  try {
    // CSP 下首屏只能使用同源外部脚本；语言和主题必须在 React/catalog 启动前同步写入 html，避免自动翻译与首帧闪烁。
    var supportedLocales = __RENEWLET_SUPPORTED_LOCALES__;
    var fallbackLocale = __RENEWLET_FALLBACK_LOCALE__;

    function readStorage(key) {
      try {
        return localStorage.getItem(key);
      } catch (_error) {
        return null;
      }
    }

    function currentSessionUserId() {
      var raw = readStorage("renewlet_app_session");
      if (!raw) return null;
      try {
        var record = JSON.parse(raw);
        if (!record || typeof record !== "object" || Array.isArray(record)) return null;
        if (record.version !== 1 || typeof record.verifiedAt !== "number" || record.verifiedAt <= 0) return null;
        var user = record.value && record.value.user;
        return user && typeof user.id === "string" && user.id ? user.id : null;
      } catch (_error) {
        return null;
      }
    }

    function accountLocale(userId) {
      if (!userId) return null;
      var raw = readStorage("renewlet_locale_preference");
      if (!raw) return null;
      try {
        var record = JSON.parse(raw);
        if (!record || typeof record !== "object" || Array.isArray(record)) return null;
        var keys = Object.keys(record);
        if (keys.length !== 3 || record.version !== 1 || record.userId !== userId) return null;
        return supportedLocales.indexOf(record.locale) !== -1 ? record.locale : null;
      } catch (_error) {
        return null;
      }
    }

    var projectedLocale = accountLocale(currentSessionUserId());
    var locale = projectedLocale || fallbackLocale;
    if (!projectedLocale) {
      var language = String((navigator.languages && navigator.languages[0]) || navigator.language || "").trim().toLowerCase();
      var primaryLanguage = language.split(/[-_]/)[0];
      var exactLocale = supportedLocales.find(function (candidate) { return candidate.toLowerCase() === language; });
      var languageLocale = supportedLocales.find(function (candidate) { return candidate.toLowerCase().split("-")[0] === primaryLanguage; });
      locale = exactLocale || (primaryLanguage && languageLocale) || fallbackLocale;
    }
    document.documentElement.lang = locale;

    var mode = readStorage("renewlet_theme_mode") || "dark";
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var shouldDark = mode === "dark" || (mode === "system" && prefersDark);
    document.documentElement.classList.toggle("dark", shouldDark);

    var variant = readStorage("renewlet_theme_variant");
    if (!variant) return;
    if (["emerald", "ocean", "sunset", "lavender", "rose", "custom"].indexOf(variant) === -1) return;

    var root = document.documentElement;
    root.setAttribute("data-theme", variant);

    if (variant !== "custom") return;

    var raw = readStorage("renewlet_custom_theme_color");
    if (!raw) return;
    var color = JSON.parse(raw);
    if (!color || typeof color !== "object") return;

    var h = color.h, s = color.s, l = color.l;
    if (typeof h !== "number" || typeof s !== "number" || typeof l !== "number") return;
    if (h < 0 || h > 360 || s < 0 || s > 100 || l < 0 || l > 100) return;

    root.style.setProperty("--primary", h + " " + s + "% " + l + "%");
    root.style.setProperty("--primary-glow", h + " " + s + "% " + Math.min(l + 6, 100) + "%");
    root.style.setProperty("--ring", h + " " + s + "% " + l + "%");
    root.style.setProperty("--accent", h + " " + Math.max(s - 30, 20) + "% 20%");
    root.style.setProperty("--accent-foreground", h + " " + s + "% " + Math.min(l + 20, 100) + "%");
    root.style.setProperty("--success", h + " " + s + "% " + l + "%");
    root.style.setProperty("--sidebar-primary", h + " " + s + "% " + l + "%");
    root.style.setProperty("--sidebar-ring", h + " " + s + "% " + l + "%");
  } catch (_error) {
    // 非存储类异常保留已应用的首屏状态；React 启动后会从内存状态恢复。
  }
})();
