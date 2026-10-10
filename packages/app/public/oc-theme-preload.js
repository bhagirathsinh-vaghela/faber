;(function () {
  // Must land before first paint. The `wide:` variant matches when the
  // attribute is absent, so without this a phone paints one frame of the
  // multi-pane layout. This file cannot import ui/util/size-class.ts (a
  // pre-paint classic script runs before any bundle exists), so the key and
  // thresholds are duplicated here and shell-preload-parity.test.ts fails the
  // suite when the two disagree.
  var forced = sessionStorage.getItem("opencode-size-class")
  var sizeClass =
    forced === "compact" || forced === "medium" || forced === "expanded"
      ? forced
      : innerWidth < 600
        ? "compact"
        : innerWidth < 840 || innerHeight < 480
          ? "medium"
          : "expanded"
  document.documentElement.dataset.sizeClass = sizeClass

  // The theme context starts on "dark" when nothing is stored; matching it here
  // keeps a light-OS device from painting a light frame first.
  var scheme = localStorage.getItem("opencode-color-scheme") || "dark"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  // The PWA title strip is painted from theme-color. Drive it from the app's
  // own resolved scheme, not the OS one, so the strip matches a dark app theme
  // even when the OS is in light mode (and vice versa).
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute("content", isDark ? "#131010" : "#f8f7f7")

  var themeId = localStorage.getItem("opencode-theme-id")
  if (!themeId) return

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode

  if (themeId === "oc-1") return

  var css = localStorage.getItem("opencode-theme-css-" + themeId + "-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
