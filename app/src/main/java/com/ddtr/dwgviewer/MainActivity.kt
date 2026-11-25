package com.ddtr.dwgviewer

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.UUID

/**
 * 화면은 web 폴더(assets로 들어감)의 HTML 앱을 그대로 쓴다.
 * - 다른 앱(카톡, 파일관리자)에서 넘어온 DWG/DXF 파일은 캐시에 복사한 뒤
 *   https://appassets.androidplatform.net/incoming/<id> 주소로 페이지에 넘긴다.
 * - 페이지가 만든 파일(PDF, PNG)은 DwgNative.begin/append/finish로 조각조각 받아서
 *   저장(다운로드 폴더) · 공유 · 열기를 한다.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pageReady = false
    private var pendingJson: String? = null
    private val lock = Any()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#14181B"))
        setContentView(web)

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.databaseEnabled = true
        web.settings.textZoom = 100
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = true

        val incoming = File(cacheDir, "incoming").apply { mkdirs() }
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/incoming/", WebViewAssetLoader.InternalStoragePathHandler(this, incoming))
            .build()

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == HOST) return false
                try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (e: Exception) { }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                val p = synchronized(lock) {
                    pageReady = true
                    val x = pendingJson
                    pendingJson = null
                    x
                }
                if (p != null) deliver(p)
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val pick = Intent(Intent.ACTION_GET_CONTENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*")
                return try {
                    startActivityForResult(Intent.createChooser(pick, "도면 파일 선택 (DWG · DXF)"), REQ_PICK)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }
        web.addJavascriptInterface(Bridge(), "DwgNative")
        cleanCache()
        handleIntent(intent)
        web.loadUrl("https://$HOST/assets/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    /** 다른 앱에서 넘어온 파일을 캐시에 복사하고 페이지에 알려준다. */
    @Suppress("DEPRECATION")
    private fun handleIntent(i: Intent?) {
        if (i == null) return
        val uri: Uri = when (i.action) {
            Intent.ACTION_VIEW -> i.data
            Intent.ACTION_SEND -> {
                if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                else i.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            }
            else -> null
        } ?: return
        // 같은 파일을 두 번 열지 않도록 표시
        i.action = Intent.ACTION_MAIN
        Thread {
            val json = try {
                val name = displayName(uri)
                val id = UUID.randomUUID().toString() + ".bin"
                val f = File(File(cacheDir, "incoming").apply { mkdirs() }, id)
                contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(f).use { input.copyTo(it) }
                } ?: throw IllegalStateException("no stream")
                JSONObject().put("url", "https://$HOST/incoming/$id").put("name", name).toString()
            } catch (e: Exception) {
                JSONObject().put("error", "파일을 읽지 못했어요.").toString()
            }
            val ready = synchronized(lock) {
                if (!pageReady) pendingJson = json
                pageReady
            }
            if (ready) deliver(json)
        }.start()
    }

    private fun deliver(json: String) {
        runOnUiThread {
            web.evaluateJavascript("(function(o){if(o.error){window.__toast&&window.__toast(o.error);}else if(window.__openUrl){window.__openUrl(o.url,o.name);}})($json)", null)
        }
    }

    private fun displayName(uri: Uri): String {
        var name: String? = null
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0) name = c.getString(idx)
                }
            }
        } catch (e: Exception) { }
        if (name.isNullOrBlank()) name = uri.lastPathSegment?.substringAfterLast('/')
        return if (name.isNullOrBlank()) "도면.dwg" else name!!
    }

    /** 하루 지난 임시 파일은 지운다. */
    private fun cleanCache() {
        val old = System.currentTimeMillis() - 24L * 3600 * 1000
        listOf("incoming", "out").forEach { d ->
            File(cacheDir, d).listFiles()?.forEach { f ->
                if (f.lastModified() < old) f.deleteRecursively()
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val cb = fileCallback ?: return
        fileCallback = null
        if (requestCode != REQ_PICK || resultCode != RESULT_OK || data == null) { cb.onReceiveValue(null); return }
        val u = data.data
        cb.onReceiveValue(if (u != null) arrayOf(u) else null)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("(window.__onBack&&window.__onBack())?'1':'0'") { r ->
            if (r != "\"1\"") finish()
        }
    }

    private class Out(val file: File, val name: String, val mime: String)

    inner class Bridge {
        private val outs = HashMap<String, Out>()

        @JavascriptInterface
        fun isApp(): Boolean = true

        /** 앱이 켜지기 전에 넘어온 파일 (없으면 빈 문자열) */
        @JavascriptInterface
        fun pending(): String {
            synchronized(lock) {
                val p = pendingJson ?: return ""
                pendingJson = null
                return p
            }
        }

        @JavascriptInterface
        fun begin(name: String, mime: String): String {
            return try {
                val dir = File(cacheDir, "out/" + UUID.randomUUID().toString()).apply { mkdirs() }
                val id = dir.name
                val f = File(dir, cleanName(name, mime))
                f.writeBytes(ByteArray(0))
                synchronized(outs) { outs[id] = Out(f, f.name, mime) }
                id
            } catch (e: Exception) { "" }
        }

        @JavascriptInterface
        fun append(id: String, b64: String): Boolean {
            val o = synchronized(outs) { outs[id] } ?: return false
            return try {
                FileOutputStream(o.file, true).use { it.write(Base64.decode(b64, Base64.DEFAULT)) }
                true
            } catch (e: Exception) { false }
        }

        /** action: save | share | open. 결과 "ok[:위치]" 또는 "err". */
        @JavascriptInterface
        fun finish(id: String, action: String): String {
            val o = synchronized(outs) { outs.remove(id) } ?: return "err"
            return try {
                when (action) {
                    "save" -> saveToDownloads(o)
                    "share" -> {
                        val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", o.file)
                        val send = Intent(Intent.ACTION_SEND).setType(o.mime)
                            .putExtra(Intent.EXTRA_STREAM, uri)
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        runOnUiThread { startActivity(Intent.createChooser(send, "보내기")) }
                        "ok"
                    }
                    "open" -> {
                        val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", o.file)
                        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, o.mime)
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        if (view.resolveActivity(packageManager) == null) return "err"
                        runOnUiThread { try { startActivity(view) } catch (e: Exception) { } }
                        "ok"
                    }
                    else -> "err"
                }
            } catch (e: Exception) { "err" }
        }
    }

    private fun saveToDownloads(o: Out): String {
        return if (Build.VERSION.SDK_INT >= 29) {
            val v = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, o.name)
                put(MediaStore.MediaColumns.MIME_TYPE, o.mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER)
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v) ?: return "err"
            contentResolver.openOutputStream(uri)?.use { out -> FileInputStream(o.file).use { it.copyTo(out) } } ?: return "err"
            "ok:다운로드/$FOLDER"
        } else {
            val dir = File(getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS), FOLDER).apply { mkdirs() }
            o.file.copyTo(File(dir, o.name), overwrite = true)
            "ok:" + dir.path
        }
    }

    private fun cleanName(n: String, mime: String): String {
        val s = n.replace(Regex("[\\\\/:*?\"<>|\\n\\r\\t]"), "_").trim()
        val ext = when (mime) {
            "image/png" -> ".png"
            "image/jpeg" -> ".jpg"
            else -> ".pdf"
        }
        val base = if (s.isEmpty()) "도면$ext" else s.take(120)
        return if (base.lowercase().endsWith(ext)) base else "$base$ext"
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val FOLDER = "상규도면뷰어"
        const val REQ_PICK = 21
    }
}
