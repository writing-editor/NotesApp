package com.manuscript.gitfs

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.eclipse.jgit.api.Git
import org.eclipse.jgit.api.MergeCommand
import org.eclipse.jgit.api.errors.CheckoutConflictException
import org.eclipse.jgit.api.errors.TransportException
import org.eclipse.jgit.lib.PersonIdent
import org.eclipse.jgit.merge.MergeStrategy
import org.eclipse.jgit.transport.CredentialsProvider
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider
import java.io.File
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * GitOps
 * ======
 * Same contract as AppCode/lib/git-Sync.js (clone/status/commitAll/pull/
 * push/checkRemote — same field names, same {ok, reason, message} error
 * shape) but implemented with JGit talking to GitHub directly over HTTPS.
 *
 * Why this is actually faster than the old mobile path, concretely:
 *   - No corsProxy hop. `cors.isomorphic-git.org` is a public, shared,
 *     rate-limited relay that terminates TLS, re-issues the request to
 *     GitHub, and streams the response back — every byte of every pack
 *     file crossed that extra hop before. JGit's transport talks to
 *     GitHub directly; CORS is a browser fetch() restriction and does not
 *     apply to a native JVM HTTP client at all.
 *   - JGit's pack negotiation uses real git wire protocol v2 (multi_ack /
 *     ofs-delta) same as the desktop `git` CLI would, rather than
 *     isomorphic-git's browser-http/JS pack parsing, which the CORS relay
 *     also had to keep compatible with.
 *
 * dir = GIT_ROOT (contains .git and book/), matching git-Sync.js exactly.
 */
class GitOps(private val gitRoot: File) {

    private val bookPrefix = "book/"

    private fun creds(token: String?): CredentialsProvider? =
        if (token.isNullOrBlank()) null
        else UsernamePasswordCredentialsProvider(token, "x-oauth-basic")

    private fun isGitRepo(): Boolean = File(gitRoot, ".git").isDirectory

    private fun openGit(): Git = Git.open(gitRoot)

    private fun ident(name: String, email: String) = PersonIdent(name, email)

    // ── clone ──────────────────────────────────────────────────────────
    fun clone(remoteUrl: String, token: String?): JSObject {
        return try {
            // Match the JS behaviour: wipe GIT_ROOT first so re-cloning into
            // a different repo works the same as the very first clone.
            if (gitRoot.exists()) gitRoot.deleteRecursively()
            gitRoot.mkdirs()

            val cloneCmd = Git.cloneRepository()
                .setURI(remoteUrl)
                .setDirectory(gitRoot)
                .setCloneAllBranches(false) // singleBranch: true, matches git-Sync.js
            creds(token)?.let { cloneCmd.setCredentialsProvider(it) }
            cloneCmd.call().close()

            val book = File(gitRoot, "book")
            if (!book.isDirectory) {
                return JSObject()
                    .put("ok", false)
                    .put("error", "Cloned repository has no book/ folder at its root")
                    .put("gitRoot", gitRoot.absolutePath)
            }
            JSObject().put("ok", true).put("vault", book.absolutePath)
        } catch (e: Exception) {
            errorResult(e)
        }
    }

    // ── status (ahead/behind/dirty) ──────────────────────────────────────
    fun status(): JSObject {
        if (!isGitRepo()) {
            return JSObject().put("ahead", 0).put("behind", 0)
                .put("dirty", JSArray()).put("conflicted", JSArray())
                .put("error", "not a git repository")
        }
        return try {
            openGit().use { git ->
                val st = git.status().call()
                val dirty = JSArray()
                (st.modified + st.added + st.changed + st.removed + st.untracked)
                    .toSortedSet()
                    .filterNot { it.endsWith("_progress.json") }
                    .forEach { dirty.put(it) }
                val conflicted = JSArray()
                st.conflicting.forEach { conflicted.put(it) }

                var ahead = 0
                var behind = 0
                try {
                    val branch = git.repository.branch
                    val trackingStatus = org.eclipse.jgit.lib.BranchTrackingStatus.of(
                        git.repository, branch
                    )
                    if (trackingStatus != null) {
                        ahead = trackingStatus.aheadCount
                        behind = trackingStatus.behindCount
                    }
                } catch (_: Exception) {
                    // non-fatal, same as git-Sync.js's try/catch around ahead/behind
                }

                JSObject().put("ahead", ahead).put("behind", behind)
                    .put("dirty", dirty).put("conflicted", conflicted)
            }
        } catch (e: Exception) {
            JSObject().put("ahead", 0).put("behind", 0)
                .put("dirty", JSArray()).put("conflicted", JSArray())
                .put("error", e.message)
        }
    }

    // ── commitAll ──────────────────────────────────────────────────────
    fun commitAll(message: String, authorName: String, authorEmail: String): JSObject {
        if (!isGitRepo()) return JSObject().put("ok", false).put("error", "not a git repository")
        return try {
            openGit().use { git ->
                val st = git.status().call()
                val changedPaths = (st.modified + st.added + st.changed + st.removed + st.untracked)
                    .filterNot { it.endsWith("_progress.json") }

                if (changedPaths.isEmpty()) {
                    return JSObject().put("ok", true).put("committed", false)
                        .put("message", "nothing to commit")
                }

                val addCmd = git.add()
                var anyAdded = false
                for (p in changedPaths) {
                    if (File(gitRoot, p).exists()) {
                        addCmd.addFilepattern(p)
                        anyAdded = true
                    }
                }
                if (anyAdded) addCmd.call()

                // Handle deletions explicitly — JGit's AddCommand only stages
                // additions/modifications of existing files, same as `git add`
                // on the CLI; removed files need `git rm`-equivalent staging.
                if (st.removed.isNotEmpty() || st.missing.isNotEmpty()) {
                    val rm = git.rm().setCached(false)
                    var anyRm = false
                    for (p in st.removed + st.missing) {
                        rm.addFilepattern(p)
                        anyRm = true
                    }
                    if (anyRm) rm.call()
                }

                val commit = git.commit()
                    .setAuthor(ident(authorName, authorEmail))
                    .setCommitter(ident(authorName, authorEmail))
                    .setMessage(message)
                    .call()

                JSObject().put("ok", true).put("committed", true).put("oid", commit.name)
            }
        } catch (e: Exception) {
            errorResult(e)
        }
    }

    // ── checkRemote (fetch only, never merges) ──────────────────────────
    fun checkRemote(remoteUrl: String?, token: String?): JSObject {
        if (!isGitRepo()) return JSObject().put("ok", false).put("reason", "error")
            .put("message", "not a git repository")
        return try {
            openGit().use { git ->
                val fetchCmd = git.fetch().setTagOpt(org.eclipse.jgit.transport.TagOpt.NO_TAGS)
                if (!remoteUrl.isNullOrBlank()) fetchCmd.setRemote(remoteUrl)
                creds(token)?.let { fetchCmd.setCredentialsProvider(it) }
                fetchCmd.call()
                JSObject().put("ok", true)
            }
        } catch (e: Exception) {
            networkAwareError(e)
        }
    }

    // ── pull (fetch + merge; never auto-resolves conflicts) ─────────────
    fun pull(remoteUrl: String?, token: String?, authorName: String, authorEmail: String): JSObject {
        if (!isGitRepo()) return JSObject().put("ok", false).put("reason", "error")
            .put("message", "not a git repository")
        return try {
            openGit().use { git ->
                val pullCmd = git.pull()
                    .setStrategy(MergeStrategy.RECURSIVE)
                creds(token)?.let { pullCmd.setCredentialsProvider(it) }
                val result = pullCmd.call()

                if (!result.isSuccessful) {
                    val mergeResult = result.mergeResult
                    val conflicts = mergeResult?.conflicts?.keys?.toList() ?: emptyList()
                    if (conflicts.isNotEmpty()) {
                        val files = JSArray()
                        conflicts.forEach { files.put(it) }
                        return JSObject().put("ok", false).put("reason", "conflict")
                            .put("message", "merge conflict")
                            .put("files", files)
                    }
                    return JSObject().put("ok", false).put("reason", "error")
                        .put("message", "pull did not succeed: $result")
                }
                JSObject().put("ok", true)
            }
        } catch (e: CheckoutConflictException) {
            val files = JSArray()
            e.conflictingPaths.forEach { files.put(it) }
            JSObject().put("ok", false).put("reason", "conflict")
                .put("message", e.message).put("files", files)
        } catch (e: Exception) {
            networkAwareError(e)
        }
    }

    // ── push (commits pending changes first, then pushes) ────────────────
    fun push(
        remoteUrl: String?,
        token: String?,
        authorName: String,
        authorEmail: String,
        message: String?
    ): JSObject {
        if (!isGitRepo()) return JSObject().put("ok", false).put("reason", "error")
            .put("message", "not a git repository")
        val committed = commitAll(message ?: "Manual commit from Manuscript", authorName, authorEmail)
        if (committed.getString("error") != null &&
            committed.optString("error").isNotBlank() &&
            !committed.getBool("ok", false)
        ) {
            return JSObject().put("ok", false).put("reason", "error")
                .put("message", "commit before push failed: ${committed.getString("error")}")
        }

        return try {
            openGit().use { git ->
                val pushCmd = git.push()
                if (!remoteUrl.isNullOrBlank()) pushCmd.setRemote(remoteUrl)
                creds(token)?.let { pushCmd.setCredentialsProvider(it) }
                val results = pushCmd.call()

                for (r in results) {
                    for (update in r.remoteUpdates) {
                        val status = update.status
                        if (status == org.eclipse.jgit.transport.RemoteRefUpdate.Status.REJECTED_NONFASTFORWARD ||
                            status == org.eclipse.jgit.transport.RemoteRefUpdate.Status.REJECTED_REMOTE_CHANGED
                        ) {
                            return JSObject().put("ok", false).put("reason", "diverged")
                                .put("message", "push rejected — pull/resolve on laptop")
                        }
                    }
                }
                JSObject().put("ok", true)
            }
        } catch (e: Exception) {
            networkAwareError(e)
        }
    }

    // ── error classification helpers (mirrors git-Sync.js's regex checks) ─

    private fun errorResult(e: Exception): JSObject =
        JSObject().put("ok", false).put("error", e.message ?: e.toString())

    private fun networkAwareError(e: Exception): JSObject {
        val msg = e.message ?: e.toString()
        val isNetwork = e is UnknownHostException || e is SocketTimeoutException ||
            e is TransportException ||
            Regex("network|resolve|timeout|unable to access|connect", RegexOption.IGNORE_CASE)
                .containsMatchIn(msg)
        return if (isNetwork) {
            JSObject().put("ok", false).put("reason", "network").put("message", msg)
        } else if (Regex("not.?authorized|401|403|authentication", RegexOption.IGNORE_CASE).containsMatchIn(msg)) {
            JSObject().put("ok", false).put("reason", "auth").put("message", msg)
        } else {
            JSObject().put("ok", false).put("reason", "error").put("message", msg)
        }
    }
}

// Small JSObject helper extensions (org.json under the hood in Capacitor)
private fun JSObject.optString(key: String): String = try { this.getString(key) ?: "" } catch (e: Exception) { "" }
private fun JSObject.getBool(key: String, default: Boolean): Boolean =
    try { this.getBool(key) ?: default } catch (e: Exception) { default }