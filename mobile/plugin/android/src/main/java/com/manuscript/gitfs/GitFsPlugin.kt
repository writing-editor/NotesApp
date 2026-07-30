package com.manuscript.gitfs

import android.content.Intent
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File

/**
 * GitFsPlugin
 * ===========
 *
 * Replaces the old mobile stack (LightningFS + isomorphic-git running
 * inside a Service Worker, proxied through https://cors.isomorphic-git.org)
 * with:
 *
 *   1. A REAL git working tree on the device's own filesystem
 *      (context.getExternalFilesDir(null)/ManuScript) — a genuine folder,
 *      not a virtual IndexedDB-backed one. It shows up over USB-MTP file
 *      transfer, in any root-capable file manager, and can be pointed at
 *      directly by Obsidian's own "open folder" SAF picker (Android exposes
 *      an app's external-files directory as a browsable node under
 *      "Internal storage" in the system folder picker on Android 11+).
 *
 *   2. Native git via JGit (`GitOps.kt`), talking to GitHub directly over
 *      HTTPS. This is the actual fix for slow push/pull: CORS and the
 *      "https://cors.isomorphic-git.org" relay were only ever needed
 *      because a browser Service Worker's fetch() is bound by CORS — plain
 *      JVM code on Android is not, so this removes an entire network hop
 *      and the third-party relay's own throughput ceiling.
 *
 *   3. An explicit, user-triggered SAF "Export to folder" / "Import from
 *      folder" pair (`pickAndExport` / `pickAndImport`) for people who want
 *      the vault mirrored somewhere else — a Syncthing folder, Downloads,
 *      a folder already open in Obsidian elsewhere, etc. This is a plain
 *      file copy, independent of git, exactly as described in the README's
 *      "Future ideas" write-up.
 *
 * JS talks to this plugin through `mobile/plugin/src/index.ts`
 * (`GitFs.*`), which `AppCode-android-bridge.js` wraps behind the *same*
 * fetch()-shaped "/api/..." surface the rest of the app (client.js) already
 * calls — so client.js itself needed no route-shape changes, only a swap
 * of which script intercepts "/api/..." requests on Android (see mobile/README-android-fs.md).
 */
@CapacitorPlugin(name = "GitFs")
class GitFsPlugin : Plugin() {

    private val scope = CoroutineScope(Dispatchers.IO)

    private lateinit var ops: GitOps
    private lateinit var vaultRoot: File

    override fun load() {
        super.load()
        val base = context.getExternalFilesDir(null) ?: context.filesDir
        vaultRoot = File(base, "ManuScript") // GIT_ROOT equivalent; vault is vaultRoot/book
        vaultRoot.mkdirs()
        ops = GitOps(vaultRoot)
    }

    // ── Paths ──────────────────────────────────────────────────────────

    @PluginMethod
    fun getRootInfo(call: PluginCall) {
        val ret = JSObject()
        ret.put("gitRoot", vaultRoot.absolutePath)
        ret.put("vault", File(vaultRoot, "book").absolutePath)
        ret.put(
            "humanPath",
            "Internal storage / Android/data/${context.packageName}/files/ManuScript"
        )
        call.resolve(ret)
    }

    // ── Plain filesystem primitives (used for note/chapter read+write,
    //    i.e. everything that isn't a git network operation) ────────────

    @PluginMethod
    fun readFile(call: PluginCall) {
        val relPath = call.getString("path") ?: return call.reject("path required")
        try {
            val f = resolveInVault(relPath)
            if (!f.exists()) return call.reject("not found: $relPath", "ENOENT")
            val ret = JSObject()
            ret.put("data", f.readText(Charsets.UTF_8))
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject(e.message, "EFS", e)
        }
    }

    @PluginMethod
    fun writeFile(call: PluginCall) {
        val relPath = call.getString("path") ?: return call.reject("path required")
        val data = call.getString("data") ?: ""
        try {
            val f = resolveInVault(relPath)
            f.parentFile?.mkdirs()
            f.writeText(data, Charsets.UTF_8)
            call.resolve(JSObject().put("ok", true))
        } catch (e: Exception) {
            call.reject(e.message, "EFS", e)
        }
    }

    @PluginMethod
    fun deleteFile(call: PluginCall) {
        val relPath = call.getString("path") ?: return call.reject("path required")
        try {
            val f = resolveInVault(relPath)
            if (f.exists()) f.delete()
            call.resolve(JSObject().put("ok", true))
        } catch (e: Exception) {
            call.reject(e.message, "EFS", e)
        }
    }

    @PluginMethod
    fun exists(call: PluginCall) {
        val relPath = call.getString("path") ?: return call.reject("path required")
        val f = resolveInVault(relPath)
        call.resolve(JSObject().put("exists", f.exists()).put("isDirectory", f.isDirectory))
    }

    @PluginMethod
    fun mkdir(call: PluginCall) {
        val relPath = call.getString("path") ?: return call.reject("path required")
        try {
            resolveInVault(relPath).mkdirs()
            call.resolve(JSObject().put("ok", true))
        } catch (e: Exception) {
            call.reject(e.message, "EFS", e)
        }
    }

    @PluginMethod
    fun readdir(call: PluginCall) {
        val relPath = call.getString("path") ?: ""
        try {
            val dir = resolveInVault(relPath)
            val names = JSArray()
            dir.listFiles()?.sortedBy { it.name }?.forEach { names.put(it.name) }
            call.resolve(JSObject().put("entries", names))
        } catch (e: Exception) {
            call.reject(e.message, "EFS", e)
        }
    }

    @PluginMethod
    fun rmrf(call: PluginCall) {
        val relPath = call.getString("path") ?: return call.reject("path required")
        try {
            resolveInVault(relPath).deleteRecursively()
            call.resolve(JSObject().put("ok", true))
        } catch (e: Exception) {
            call.reject(e.message, "EFS", e)
        }
    }

    /** Resolves a GIT_ROOT-relative path (e.g. "book/chapters/x.md") safely
     *  inside vaultRoot, rejecting any attempt to escape it via "..". */
    private fun resolveInVault(relPath: String): File {
        val clean = relPath.trim('/').replace("\\", "/")
        val f = File(vaultRoot, clean).canonicalFile
        val rootCanon = vaultRoot.canonicalFile
        if (!f.path.startsWith(rootCanon.path)) {
            throw SecurityException("path escapes vault root: $relPath")
        }
        return f
    }

    // ── Git operations (native JGit — see GitOps.kt) ──────────────────

    @PluginMethod
    fun gitClone(call: PluginCall) {
        val remoteUrl = call.getString("remoteUrl") ?: return call.reject("remoteUrl required")
        val token = call.getString("token")
        scope.launch {
            val result = ops.clone(remoteUrl, token)
            call.resolveOnMain(result)
        }
    }

    @PluginMethod
    fun gitStatus(call: PluginCall) {
        scope.launch { call.resolveOnMain(ops.status()) }
    }

    @PluginMethod
    fun gitCommit(call: PluginCall) {
        val message = call.getString("message") ?: "Manual commit from Manuscript"
        val authorName = call.getString("authorName") ?: "Manuscript"
        val authorEmail = call.getString("authorEmail") ?: "manuscript@localhost"
        scope.launch { call.resolveOnMain(ops.commitAll(message, authorName, authorEmail)) }
    }

    @PluginMethod
    fun gitPull(call: PluginCall) {
        val remoteUrl = call.getString("remoteUrl")
        val token = call.getString("token")
        val authorName = call.getString("authorName") ?: "Manuscript"
        val authorEmail = call.getString("authorEmail") ?: "manuscript@localhost"
        scope.launch { call.resolveOnMain(ops.pull(remoteUrl, token, authorName, authorEmail)) }
    }

    @PluginMethod
    fun gitPush(call: PluginCall) {
        val remoteUrl = call.getString("remoteUrl")
        val token = call.getString("token")
        val message = call.getString("message")
        val authorName = call.getString("authorName") ?: "Manuscript"
        val authorEmail = call.getString("authorEmail") ?: "manuscript@localhost"
        scope.launch {
            call.resolveOnMain(ops.push(remoteUrl, token, authorName, authorEmail, message))
        }
    }

    @PluginMethod
    fun gitCheckRemote(call: PluginCall) {
        val remoteUrl = call.getString("remoteUrl")
        val token = call.getString("token")
        scope.launch { call.resolveOnMain(ops.checkRemote(remoteUrl, token)) }
    }

    // ── SAF export / import mirror (optional, explicit, git-independent) ─
    //
    // Uses Capacitor's real Activity Result API (available since Capacitor
    // 3): startActivityForResult(call, intent, "callbackMethodName") pairs
    // with a method annotated @ActivityCallback whose signature is exactly
    // (PluginCall, ActivityResult). Capacitor itself takes care of
    // re-associating the *original* PluginCall with the result — including
    // across process death, since it persists the call — so there's no
    // need for a manual pendingCall field or an old-style
    // handleOnActivityResult(requestCode, resultCode, data) override; that
    // legacy API was superseded in Capacitor 3 and mixing the two patterns
    // doesn't work correctly (the override is never invoked once a plugin
    // uses @ActivityCallback methods).

    @PluginMethod
    fun pickAndExport(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        )
        startActivityForResult(call, intent, "exportFolderPicked")
    }

    @ActivityCallback
    private fun exportFolderPicked(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = result.data?.data
        if (result.resultCode != android.app.Activity.RESULT_OK || uri == null) {
            call.reject("cancelled")
            return
        }
        try {
            activity.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (_: SecurityException) {
            // Some providers (notably a handful of cloud-backed ones) don't
            // support persistable permissions — the copy below still works
            // for this one operation even though it won't survive an app
            // restart; non-fatal either way since this is a one-shot export.
        }
        val treeDoc = DocumentFile.fromTreeUri(context, uri)
        if (treeDoc == null) {
            call.reject("could not open folder")
            return
        }
        scope.launch {
            try {
                val count = SafMirror.copyTreeToSaf(File(vaultRoot, "book"), treeDoc, context)
                call.resolveOnMain(JSObject().put("ok", true).put("filesCopied", count))
            } catch (e: Exception) {
                call.rejectOnMain(e.message ?: "export failed")
            }
        }
    }

    @PluginMethod
    fun pickAndImport(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        )
        startActivityForResult(call, intent, "importFolderPicked")
    }

    @ActivityCallback
    private fun importFolderPicked(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = result.data?.data
        if (result.resultCode != android.app.Activity.RESULT_OK || uri == null) {
            call.reject("cancelled")
            return
        }
        try {
            activity.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (_: SecurityException) {
            // see exportFolderPicked's identical catch above
        }
        val treeDoc = DocumentFile.fromTreeUri(context, uri)
        if (treeDoc == null) {
            call.reject("could not open folder")
            return
        }
        scope.launch {
            try {
                val count = SafMirror.copyTreeFromSaf(treeDoc, File(vaultRoot, "book"), context)
                call.resolveOnMain(JSObject().put("ok", true).put("filesCopied", count))
            } catch (e: Exception) {
                call.rejectOnMain(e.message ?: "import failed")
            }
        }
    }
}

// Small helpers so PluginCall.resolve/reject (main-thread bound in some
// Capacitor versions) are always invoked from the main thread regardless of
// which coroutine dispatcher produced the result.
private fun PluginCall.resolveOnMain(data: JSObject) {
    android.os.Handler(android.os.Looper.getMainLooper()).post { this.resolve(data) }
}
private fun PluginCall.rejectOnMain(message: String) {
    android.os.Handler(android.os.Looper.getMainLooper()).post { this.reject(message) }
}