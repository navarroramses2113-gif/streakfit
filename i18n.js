// Forja in English and Spanish. All the app's text is written in English in
// the code and goes through tr() on its way to the screen. In Spanish, tr()
// looks the English up in ES (i18n-es.js) and hands back the Spanish; in
// English it hands back the text exactly as written. Anything missing from
// ES stays English - and on localhost the console says so - so a line that
// was never translated can't break a screen.
//
// Which language: the one picked in Settings (localStorage "forja-lang",
// "en" or "es"), otherwise the phone's own language. Decided once, when the
// app opens (changing it in Settings reloads the app). Loaded before every
// other script, so they can all use tr() while they set up.
//
//   tr("Saved.")                        -> "Guardado."
//   tr("Day {n} done!", { n: 5 })       -> "¡Día 5 completado!"
//   trn(3, "{n} day", "{n} days")       -> "3 días"   (1 -> "1 día")
//   trLocale(undefined)                 -> "es" in Spanish, else what's given
//                                          (for toLocaleDateString and friends)
(function () {
  const LANG_KEY = "forja-lang";
  const LANGS = ["en", "es"];

  // "en", "es", or null = follow the phone.
  function chosenLang() {
    try {
      const saved = localStorage.getItem(LANG_KEY);
      return LANGS.includes(saved) ? saved : null;
    } catch (e) {
      return null;
    }
  }

  function phoneLang() {
    const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"];
    return /^es\b/i.test(list[0] || "") ? "es" : "en";
  }

  const lang = chosenLang() || phoneLang();
  document.documentElement.lang = lang;

  const dictionary = () => (lang === "es" && window.FORJA_ES) || {};
  const warnMissing = ["localhost", "127.0.0.1"].includes(location.hostname);
  const missing = new Set();

  // Spanish sentences are written for "{n} días"; with n = 1 that would
  // read "1 días", so the word goes singular ("1 día", "1 flexión").
  const SPANISH_SINGULAR = {
    días: "día", semanas: "semana", flexiones: "flexión", sentadillas: "sentadilla", personas: "persona",
    jugadores: "jugador", minutos: "minuto", descansos: "descanso", puntos: "punto", invitaciones: "invitación",
    segundos: "segundo", caminatas: "caminata", amigos: "amigo", "días de descanso": "día de descanso",
  };
  const SINGULAR_PATTERN = new RegExp(`(^|[^\\d.,:])1 (${Object.keys(SPANISH_SINGULAR).sort((a, b) => b.length - a.length).join("|")})(?![\\wáéíóúñ])`, "g");

  function fill(text, vars) {
    if (!vars) return text;
    const filled = text.replace(/\{(\w+)\}/g, (whole, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole));
    return lang === "es" ? filled.replace(SINGULAR_PATTERN, (whole, before, word) => `${before}1 ${SPANISH_SINGULAR[word]}`) : filled;
  }

  function lookup(text, quiet) {
    if (lang === "en" || typeof text !== "string") return text;
    const es = dictionary();
    if (Object.prototype.hasOwnProperty.call(es, text)) return es[text];
    if (!quiet && warnMissing && /[a-z]/i.test(text) && !missing.has(text)) {
      missing.add(text);
      console.warn("[i18n] no Spanish for:", JSON.stringify(text));
    }
    return text;
  }

  function tr(text, vars) {
    return fill(lookup(text), vars);
  }

  // English picks the form ("1 day" / "2 days"); Spanish uses the same rule.
  function trn(n, one, other, vars) {
    return tr(n === 1 ? one : other, { n, ...vars });
  }

  const trLocale = (english) => (lang === "es" ? "es" : english);

  // The page's own words (index.html): every text node and label that is
  // exactly an English phrase in ES. Runs once, before the app draws
  // anything; text the app sets later goes through tr() instead.
  const ATTRIBUTES = ["placeholder", "aria-label", "title", "alt"];
  function translatePage(root) {
    if (lang === "en") return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement && node.parentElement.closest("script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const text = node.nodeValue.trim();
      if (!text) return;
      const translated = lookup(text, true);
      if (translated !== text) node.nodeValue = node.nodeValue.replace(text, translated);
    });
    root.querySelectorAll("*").forEach((el) => {
      ATTRIBUTES.forEach((name) => {
        const value = el.getAttribute(name);
        if (!value) return;
        const translated = lookup(value.trim(), true);
        if (translated !== value.trim()) el.setAttribute(name, translated);
      });
    });
  }

  // Settings: "auto" (follow the phone), "en" or "es". Reloads, so every
  // screen is drawn in the new language from the start.
  function setLanguage(choice) {
    try {
      if (LANGS.includes(choice)) localStorage.setItem(LANG_KEY, choice);
      else localStorage.removeItem(LANG_KEY);
    } catch (e) {
      // storage blocked - stays on the phone's language
    }
    location.reload();
  }

  window.tr = tr;
  window.trn = trn;
  window.trLocale = trLocale;
  window.ForjaI18n = {
    lang,
    choice: () => chosenLang() || "auto",
    setLanguage,
    translatePage,
    missing: () => [...missing],
  };
})();
