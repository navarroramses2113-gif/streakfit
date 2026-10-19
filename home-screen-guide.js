// How to put Forja on the Home Screen (2026-10-19). iPhone only sends
// reminders to apps on the Home Screen, and new people who never closed a
// ring never saw the steps (the sheet in script.js only shows at those
// moments). Shared by three places, so their steps can't drift apart:
//   - sign-up, right after the account is made (onboarding.js "homescreen")
//   - Account > Add to Home Screen (index.html #home-guide-screen)
//   - getforja.app/install, a page to send people (install.html)
// It only draws; whoever shows it adds the buttons. Needs tr() (i18n.js).
//
//   ForjaHomeGuide.shouldOffer()         a phone browser, not the Home Screen app
//   ForjaHomeGuide.html({ top })         the guide (top = the pet or the logo)
//   ForjaHomeGuide.click(event, redraw)  the iPhone/Android switch and Copy
//   ForjaHomeGuide.browserName()         "Safari", "Chrome" (for buttons)
const ForjaHomeGuide = (function () {
  const PAGE_URL = "https://getforja.app/install";
  const ua = () => navigator.userAgent || "";

  const isIOS = () => /iPhone|iPad|iPod/.test(ua()) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = () => /Android/i.test(ua());
  const isHomeScreenApp = () => navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  // Apps that open links in their own browser, which can't add to the Home
  // Screen: the link has to be opened in Safari / Chrome first.
  function inAppBrowser() {
    const agent = ua();
    if (/BytedanceWebview|musical_ly|TikTok/i.test(agent)) return "TikTok";
    if (/Instagram/i.test(agent)) return "Instagram";
    if (/FBAN|FBAV|FB_IAB/i.test(agent)) return "Facebook";
    return null;
  }

  const shouldOffer = () => (isIOS() || isAndroid()) && !isHomeScreenApp();
  const browserName = () => (isAndroid() ? "Chrome" : "Safari");
  let os = isAndroid() ? "android" : "iphone";

  const svg = (body, fill) => `<svg viewBox="0 0 24 24" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'} aria-hidden="true">${body}</svg>`;
  const ICONS = {
    share: svg('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/>'),
    add: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>'),
    dotsH: svg('<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>', true),
    dotsV: svg('<circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>', true),
  };
  // An icon as it looks on the phone. Named for screen readers where the
  // words around it don't already say it ("Share", "Add to Home Screen").
  const chip = (name, label) => `<span class="notif-step-icon"${label ? ` role="img" aria-label="${label}"` : ""}>${ICONS[name]}</span>`;
  const appChip = '<span class="notif-step-icon is-app"><img src="icons/icon-192.png" alt=""></span>';
  const step = (n, main, small) => `<li><span class="notif-step-n">${n}</span><span>${main}${small ? `<small>${small}</small>` : ""}</span></li>`;

  // The steps alone (the Home Screen sheet in script.js shows the iPhone ones).
  function steps(which = os) {
    if (which === "android") {
      return [
        step(1, tr("Tap {dots} in Chrome", { dots: chip("dotsV", tr("Menu")) }), tr("Top right corner.")),
        step(2, tr("Tap Add to Home screen"), tr("Or Install app.")),
        step(3, tr("Tap Install, then open {app} Forja", { app: appChip }), tr("From your Home screen.")),
      ].join("");
    }
    return [
      step(1, tr("Tap {dots} then {share} Share", { dots: chip("dotsH", tr("More")), share: chip("share", "") }), tr("At the bottom of Safari. Some iPhones show Share right away.")),
      step(2, tr("Tap View More, then {add} Add to Home Screen", { add: chip("add", "") }), tr("View More is in the row under the apps.")),
      step(3, tr("Tap Add, then open {app} Forja", { app: appChip }), tr("Log in once more. That's it.")),
    ].join("");
  }

  function html({ top = "" } = {}) {
    const inside = inAppBrowser();
    const lead = os === "android" ? tr("Opens full screen, like a real app. Takes 20 seconds.") : tr("Reminders only reach you from the Home Screen app. Takes 20 seconds.");
    const headsUp = inside
      ? `<div class="guide-heads-up" role="note"><span><b>${tr("You're inside {app}.", { app: inside })}</b> ${tr("Its browser can't add apps. Tap {dots} at the top, then {open}.", {
          dots: chip(isAndroid() ? "dotsV" : "dotsH", tr("More")),
          open: `<b>${tr("Open in browser")}</b>`,
        })}</span></div>
        <div class="guide-copy-row"><code class="guide-link">${PAGE_URL.replace("https://", "")}</code><button type="button" class="guide-copy" data-guide-copy>${tr("Copy")}</button></div>`
      : "";
    const pick = (value, label) => `<button type="button" role="radio" aria-checked="${os === value}" data-guide-os="${value}">${label}</button>`;
    return `
      <div class="home-guide">
        ${top}
        <h1 class="guide-title">${tr("Put Forja on your Home Screen")}</h1>
        <p class="guide-lead">${lead}</p>
        ${headsUp}
        <div class="guide-os" role="radiogroup" aria-label="${tr("Phone")}">${pick("iphone", tr("iPhone"))}${pick("android", tr("Android"))}</div>
        <ol class="notif-steps guide-steps">${steps()}</ol>
      </div>`;
  }

  // True when the tap was the guide's own (then `redraw` has run).
  function click(event, redraw) {
    const pick = event.target.closest("[data-guide-os]");
    if (pick) {
      os = pick.dataset.guideOs;
      redraw();
      return true;
    }
    const copy = event.target.closest("[data-guide-copy]");
    if (copy) {
      const copied = () => (copy.textContent = tr("Copied"));
      // In-app browsers may refuse the clipboard: select the link instead,
      // so press-and-hold Copy still works.
      const selectIt = () => {
        const link = copy.parentElement.querySelector(".guide-link");
        const range = document.createRange();
        range.selectNodeContents(link);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      };
      try {
        navigator.clipboard.writeText(PAGE_URL).then(copied, selectIt);
      } catch (e) {
        selectIt();
      }
      return true;
    }
    return false;
  }

  return { shouldOffer, isHomeScreenApp, inAppBrowser, browserName, html, steps, click };
})();
