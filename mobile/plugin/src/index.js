// mobile/plugin/src/index.js
//
// Thin JS-side registration for the native GitFs Capacitor plugin
// (mobile/plugin/android/.../GitFsPlugin.kt). Every method here is a
// straight passthrough to native code over the Capacitor bridge — all the
// actual filesystem/git logic lives in Kotlin.
//
// Consumed by AppCode/android-bridge.js, which reshapes these calls back
// into the same fetch('/api/...') surface AppCode/public/client.js already
// uses, so client.js itself needed zero changes to work against real files.

import { registerPlugin } from '@capacitor/core';

const GitFs = registerPlugin('GitFs');

export default GitFs;