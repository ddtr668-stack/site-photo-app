package com.ddtr.sitephoto

import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.provider.MediaStore
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
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.UUID

/**
 * 화면은 assets/index.html(claude.ai 페이지와 같은 React 앱)을 그대로 쓴다.
 * https://appassets.androidplatform.net 주소로 열어서 IndexedDB에 현장·사진·보고서를 저장한다.
 * 페이지가 만든 파일(PDF, 백업 zip)은 SiteNative.begin/append/finish로 조각조각 받아서
 * 저장(다운로드 폴더) · 공유 · 인쇄 · 열기를 한다.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraUri: Uri? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        web.setBackgroundColor(Color.parseColor(if (night) "#14181B" else "#EEF0EC"))
        setContentView(web)

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.databaseEnabled = true
        web.settings.textZoom = 100
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = true

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
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
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val accept = params.acceptTypes?.filter { it.isNotBlank() } ?: emptyList()
                val images = accept.isEmpty() || accept.any { it.startsWith("image") }
                if (images && params.isCaptureEnabled && openCamera()) return true
                val pick = Intent(Intent.ACTION_GET_CONTENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(if (images) "image/*" else "*/*")
                if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                return try {
                    startActivityForResult(Intent.createChooser(pick, if (images) "사진 선택" else "백업 파일 선택"), REQ_PICK)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }
        web.addJavascriptInterface(Bridge(), "SiteNative")
        cleanCache()
        web.loadUrl("https://$HOST/assets/index.html")
    }

    private fun openCamera(): Boolean {
        return try {
            val dir = File(cacheDir, "shots").apply { mkdirs() }
            val f = File(dir, "shot_${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
            cameraUri = uri
            val i = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            startActivityForResult(i, REQ_CAMERA)
            true
        } catch (e: Exception) {
            cameraUri = null
            false
        }
    }

    /** 하루 지난 촬영 원본·임시 파일은 지운다 (사진은 앱 저장소에 따로 들어가 있음). */
    private fun cleanCache() {
        val old = System.currentTimeMillis() - 24L * 3600 * 1000
        listOf("shots", "out").forEach { d ->
            File(cacheDir, d).listFiles()?.forEach { if (it.lastModified() < old) it.delete() }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val cb = fileCallback ?: return
        fileCallback = null
        when (requestCode) {
            REQ_CAMERA -> {
                val u = cameraUri
                cameraUri = null
                cb.onReceiveValue(if (resultCode == RESULT_OK && u != null) arrayOf(u) else null)
            }
            REQ_PICK -> {
                if (resultCode != RESULT_OK || data == null) { cb.onReceiveValue(null); return }
                val list = ArrayList<Uri>()
                data.clipData?.let { c -> for (i in 0 until c.itemCount) list.add(c.getItemAt(i).uri) }
                if (list.isEmpty()) data.data?.let { list.add(it) }
                cb.onReceiveValue(if (list.isEmpty()) null else list.toTypedArray())
            }
            else -> cb.onReceiveValue(null)
        }
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

        /** action: save | share | print | open. 결과 "ok[:위치]" 또는 "err". */
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
                    "print" -> {
                        runOnUiThread { printPdf(o) }
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

    private fun printPdf(o: Out) {
        val pm = getSystemService(Context.PRINT_SERVICE) as PrintManager
        pm.print(o.name, object : PrintDocumentAdapter() {
            override fun onLayout(old: PrintAttributes?, new: PrintAttributes, cancel: CancellationSignal, cb: LayoutResultCallback, extras: Bundle?) {
                if (cancel.isCanceled) { cb.onLayoutCancelled(); return }
                cb.onLayoutFinished(
                    PrintDocumentInfo.Builder(o.name).setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).build(),
                    true
                )
            }

            override fun onWrite(pages: Array<out PageRange>, dest: ParcelFileDescriptor, cancel: CancellationSignal, cb: WriteResultCallback) {
                try {
                    FileInputStream(o.file).use { input -> FileOutputStream(dest.fileDescriptor).use { input.copyTo(it) } }
                    cb.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
                } catch (e: Exception) {
                    cb.onWriteFailed(e.message)
                }
            }
        }, PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build())
    }

    private fun cleanName(n: String, mime: String): String {
        val s = n.replace(Regex("[\\\\/:*?\"<>|\\n\\r\\t]"), "_").trim()
        val ext = if (mime == "application/zip") ".zip" else ".pdf"
        val base = if (s.isEmpty()) "파일$ext" else s.take(120)
        return if (base.lowercase().endsWith(ext)) base else "$base$ext"
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val FOLDER = "상규사진대지"
        const val REQ_PICK = 21
        const val REQ_CAMERA = 22
    }
}
