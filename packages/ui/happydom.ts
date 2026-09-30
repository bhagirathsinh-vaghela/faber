import { GlobalRegistrator } from "@happy-dom/global-registrator"

// The tests run with --conditions=browser, which picks browser builds such as
// decode-named-character-reference's index.dom.js, and that one calls
// document.createElement as it is imported.
GlobalRegistrator.register()
