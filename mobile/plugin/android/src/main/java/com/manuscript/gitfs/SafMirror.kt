package com.manuscript.gitfs

import android.content.Context
import androidx.documentfile.provider.DocumentFile
import java.io.File

/**
 * SafMirror
 * =========
 * Plain, git-independent file copy between the real on-device vault
 * (java.io.File, see GitFsPlugin.vaultRoot) and an arbitrary folder the
 * user picks via Android's Storage Access Framework — a Syncthing folder,
 * Downloads, a folder Obsidian already has open, a USB-OTG drive, etc.
 *
 * This is intentionally "lower risk" per the README's own future-ideas
 * write-up: no auto-detection, no merge logic, one direction at a time,
 * on demand. It exists *alongside* the real git-backed filesystem (this
 * app's git repo already lives in a real folder — see GitFsPlugin — so
 * this mirror is for people who specifically want a copy in a second,
 * non-git-managed location too).
 */
object SafMirror {

    /** Copies every file under [srcDir] (recursively) into [destTree].
     *  Returns the number of files copied. */
    fun copyTreeToSaf(srcDir: File, destTree: DocumentFile, context: Context): Int {
        if (!srcDir.isDirectory) return 0
        var count = 0
        fun walk(src: File, dest: DocumentFile) {
            val children = src.listFiles() ?: return
            for (child in children) {
                if (child.isDirectory) {
                    val existing = dest.findFile(child.name)
                    val subDir = existing?.takeIf { it.isDirectory }
                        ?: dest.createDirectory(child.name)
                    if (subDir != null) walk(child, subDir)
                } else {
                    dest.findFile(child.name)?.delete()
                    val mime = if (child.name.endsWith(".md")) "text/markdown" else "application/octet-stream"
                    val docFile = dest.createFile(mime, child.name) ?: continue
                    context.contentResolver.openOutputStream(docFile.uri)?.use { out ->
                        child.inputStream().use { input -> input.copyTo(out) }
                    }
                    count++
                }
            }
        }
        walk(srcDir, destTree)
        return count
    }

    /** Copies every file under [srcTree] (recursively) into [destDir] on
     *  the real filesystem. Returns the number of files copied. */
    fun copyTreeFromSaf(srcTree: DocumentFile, destDir: File, context: Context): Int {
        var count = 0
        fun walk(src: DocumentFile, dest: File) {
            dest.mkdirs()
            for (child in src.listFiles()) {
                val name = child.name ?: continue
                if (child.isDirectory) {
                    walk(child, File(dest, name))
                } else {
                    val outFile = File(dest, name)
                    context.contentResolver.openInputStream(child.uri)?.use { input ->
                        outFile.outputStream().use { out -> input.copyTo(out) }
                    }
                    count++
                }
            }
        }
        walk(srcTree, destDir)
        return count
    }
}