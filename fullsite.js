// On narrow windows SubCentral serves a separate mobile site (pages ending in "Div.do") that the
// extension can't read. Switch to the full site with SubCentral's own "Full Site" link, which lands
// on Home, then continue to Available Jobs.
(() => {
  "use strict";
  const LAST = "scjf-fullsite-at";
  const PENDING = "scjf-fullsite-pending";
  const RETRY_MS = 60 * 1000; // if the switch doesn't stick, don't bounce between pages
  const path = window.location.pathname;
  let ss;
  try {
    ss = window.sessionStorage;
  } catch (e) {
    return;
  }

  if (/^\/substituteAvailableJob\w*Div\.do$/.test(path)) {
    if (Date.now() - (Number(ss.getItem(LAST)) || 0) < RETRY_MS) return;
    ss.setItem(LAST, String(Date.now()));
    ss.setItem(PENDING, "1");
    window.location.replace("/homeAction.do?uiNew=0");
  } else if (path === "/homeAction.do" && ss.getItem(PENDING)) {
    ss.removeItem(PENDING);
    const go = () => {
      const menu = document.getElementById("sidious.Available Jobs");
      const href = menu && menu.href;
      window.location.replace(
        href && /\/substituteAvailableJob\w*\.do/.test(href)
          ? href
          : "/substituteAvailableJobInitAction.do",
      );
    };
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", go);
    else go();
  }
})();
