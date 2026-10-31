package com.ddtr.sitephoto

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
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

/**
 * 화면은 assets/index.html(claude.ai 페이지와 같은 React 앱)을 그대로 쓴다.
 * https://appassets.androidplatform.net 주소로 열어서 IndexedDB에 현장·사진을 저장한다.
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
                if (params.isCaptureEnabled && openCamera()) return true
                val pick = Intent(Intent.ACTION_GET_CONTENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("image/*")
                if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                return try {
                    startActivityForResult(Intent.createChooser(pick, "사진 선택"), REQ_PICK)
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

    /** 지난 촬영 원본·공유용 PDF는 하루 지나면 지운다 (사진은 앱 저장소에 따로 들어가 있음). */
    private fun cleanCache() {
        val old = System.currentTimeMillis() - 24L * 3600 * 1000
        listOf("shots", "pdf").forEach { d ->
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

    inner class Bridge {
        @JavascriptInterface
        fun isApp(): Boolean = true

        /** 다운로드/현장사진대지 폴더에 PDF 저장. "ok:<위치>" 또는 "err". */
        @JavascriptInterface
        fun savePdf(b64: String, name: String): String {
            return try {
                val bytes = Base64.decode(b64, Base64.DEFAULT)
                val clean = cleanName(name)
                if (Build.VERSION.SDK_INT >= 29) {
                    val v = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, clean)
                        put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf")
                        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/현장사진대지")
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v) ?: return "err"
                    contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return "err"
                    "ok:다운로드/현장사진대지"
                } else {
                    val dir = File(getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS), "현장사진대지").apply { mkdirs() }
                    File(dir, clean).writeBytes(bytes)
                    "ok:" + dir.path
                }
            } catch (e: Exception) {
                "err"
            }
        }

        /** 카톡·메일 등으로 보내기. */
        @JavascriptInterface
        fun sharePdf(b64: String, name: String): String {
            return try {
                val bytes = Base64.decode(b64, Base64.DEFAULT)
                val dir = File(cacheDir, "pdf").apply { mkdirs() }
                val f = File(dir, cleanName(name))
                f.writeBytes(bytes)
                val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", f)
                val send = Intent(Intent.ACTION_SEND)
                    .setType("application/pdf")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                runOnUiThread { startActivity(Intent.createChooser(send, "사진대지 보내기")) }
                "ok"
            } catch (e: Exception) {
                "err"
            }
        }
    }

    private fun cleanName(n: String): String {
        val s = n.replace(Regex("[\\\\/:*?\"<>|\\n\\r\\t]"), "_").trim()
        val base = if (s.isEmpty()) "사진대지.pdf" else s.take(120)
        return if (base.lowercase().endsWith(".pdf")) base else "$base.pdf"
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val REQ_PICK = 21
        const val REQ_CAMERA = 22
    }
}
