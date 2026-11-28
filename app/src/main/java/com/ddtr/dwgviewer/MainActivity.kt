package com.ddtr.dwgviewer

import android.app.Activity
import android.content.ComponentName
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Parcelable
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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
    private var cameraUri: Uri? = null
    private var cameraFile: File? = null
    private var pageReady = false
    private var pendingJson: String? = null
    private val lock = Any()

    // ---- 네이티브 엔진 (따로 된 프로세스) ----
    private var engine: Messenger? = null
    private var engineBound = false
    private val engineJobs = LinkedHashMap<Int, Bundle>() // 보냈거나 연결을 기다리는 일
    private val engineSent = HashSet<Int>()
    private val engineReply = Messenger(object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(msg: Message) {
            if (msg.what != EngineService.MSG_DONE) return
            val d = msg.data
            val job = d.getInt("job")
            if (engineJobs.remove(job) == null) return
            engineSent.remove(job)
            val r = d.getLongArray("r")
            val o = JSONObject()
            if (r != null && r.size >= 6) {
                o.put("ok", r[0] == 0L).put("code", r[0]).put("dwgErr", r[1]).put("entities", r[2])
                    .put("blocks", r[3]).put("bytes", r[4]).put("ms", r[5])
            } else o.put("ok", false).put("error", d.getString("err") ?: "?")
            engineDone(job, o)
        }
    })
    private val engineConn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            engine = Messenger(binder)
            for ((job, b) in engineJobs) if (job !in engineSent) sendEngine(job, b)
        }
        override fun onServiceDisconnected(name: ComponentName) {
            // 엔진 프로세스가 죽음 (메모리 부족, 손상된 파일 등) → 맡긴 일은 실패로 알린다
            engine = null
            val jobs = engineJobs.keys.toList()
            engineJobs.clear(); engineSent.clear()
            for (j in jobs) engineDone(j, JSONObject().put("ok", false).put("crash", true))
        }
        override fun onBindingDied(name: ComponentName) {
            try { unbindService(this) } catch (e: Exception) { }
            engineBound = false
            engine = null
            bindEngine()
        }
    }

    private fun bindEngine(): Boolean {
        if (!engineBound) {
            engineBound = try {
                bindService(Intent(this, EngineService::class.java), engineConn, Context.BIND_AUTO_CREATE)
            } catch (e: Exception) { false }
        }
        return engineBound
    }

    private fun sendEngine(job: Int, b: Bundle) {
        val m = engine ?: return
        try {
            m.send(Message.obtain(null, EngineService.MSG_PARSE).apply { data = b; replyTo = engineReply })
            engineSent.add(job)
        } catch (e: Exception) {
            engineJobs.remove(job)
            engineDone(job, JSONObject().put("ok", false).put("error", "send"))
        }
    }

    private fun engineDone(job: Int, o: JSONObject) {
        runOnUiThread {
            web.evaluateJavascript("window.__engineDone&&window.__engineDone($job,$o)", null)
        }
    }

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

            // 아주 큰 도면을 열다가 메모리가 모자라 화면 엔진이 죽으면, 앱을 끄지 않고 화면만 다시 띄운다
            // (다시 뜬 화면이 "지난번 도면을 열지 못했어요"를 알려준다)
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                try {
                    (view.parent as? ViewGroup)?.removeView(view)
                    view.destroy()
                } catch (e: Exception) { }
                recreate()
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
                cameraUri = null
                val images = params.acceptTypes?.any { it.startsWith("image") } == true
                val chooser = if (images) {
                    // 도면에 넣을 사진: 앨범 또는 카메라
                    val pick = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*")
                    val c = Intent.createChooser(pick, "사진 넣기")
                    cameraIntent()?.let { c.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf<Parcelable>(it)) }
                    c
                } else {
                    val pick = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                    Intent.createChooser(pick, "도면 파일 선택 (DWG · DXF)")
                }
                return try {
                    startActivityForResult(chooser, REQ_PICK)
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
        importUri(uri)
    }

    /** 파일을 캐시(incoming)에 복사하고 페이지에 열라고 알린다. */
    private fun importUri(uri: Uri) {
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

    /** 카메라로 찍어서 바로 넣기 */
    private fun cameraIntent(): Intent? {
        return try {
            val dir = File(cacheDir, "shots").apply { mkdirs() }
            val f = File(dir, "shot_${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
            cameraFile = f
            cameraUri = uri
            Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (e: Exception) { null }
    }

    /** 하루 지난 임시 파일은 지운다. */
    private fun cleanCache() {
        val old = System.currentTimeMillis() - 24L * 3600 * 1000
        listOf("incoming", "out", "shots").forEach { d ->
            File(cacheDir, d).listFiles()?.forEach { f ->
                if (f.lastModified() < old) f.deleteRecursively()
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_OPEN) {
            val u = data?.data
            if (resultCode == RESULT_OK && u != null) importUri(u)
            else web.evaluateJavascript("window.__pickCancel&&window.__pickCancel()", null)
            return
        }
        val cb = fileCallback ?: return
        fileCallback = null
        if (requestCode != REQ_PICK || resultCode != RESULT_OK) { cb.onReceiveValue(null); return }
        val u = data?.data
        val cam = cameraUri
        val shot = cameraFile
        cameraUri = null
        cameraFile = null
        when {
            u != null -> cb.onReceiveValue(arrayOf(u))
            cam != null && shot != null && shot.exists() && shot.length() > 0 -> cb.onReceiveValue(arrayOf(cam))
            else -> cb.onReceiveValue(null)
        }
    }

    override fun onDestroy() {
        if (engineBound) { try { unbindService(engineConn) } catch (e: Exception) { } }
        engineBound = false
        super.onDestroy()
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

        /** 도면만 보기: 상태바·내비게이션 바까지 숨김 (가장자리에서 밀면 잠깐 나옴) */
        @JavascriptInterface
        fun fullscreen(on: Boolean) {
            runOnUiThread {
                val c = WindowCompat.getInsetsController(window, window.decorView)
                if (on) {
                    c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    c.hide(WindowInsetsCompat.Type.systemBars())
                } else c.show(WindowInsetsCompat.Type.systemBars())
            }
        }

        // ---- 네이티브 엔진 ----
        /** 엔진 프로세스를 미리 띄워 둔다 */
        @JavascriptInterface
        fun engineWarm(): Boolean {
            runOnUiThread { bindEngine() }
            return true
        }

        /** incoming 폴더의 파일을 해석해 <이름>.sgdb로 만든다. 끝나면 window.__engineDone(job, 결과) */
        @JavascriptInterface
        fun engineParse(job: Int, name: String, dxf: Boolean): String {
            if (!safeName(name)) return "err"
            val dir = File(cacheDir, "incoming")
            val src = File(dir, name)
            if (!src.exists()) return "err"
            val b = Bundle().apply {
                putInt("job", job)
                putString("in", src.absolutePath)
                putString("out", File(dir, "$name.sgdb").absolutePath)
                putBoolean("dxf", dxf)
            }
            runOnUiThread {
                if (!bindEngine()) { engineDone(job, JSONObject().put("ok", false).put("error", "bind")); return@runOnUiThread }
                engineJobs[job] = b
                if (engine != null) sendEngine(job, b)
            }
            return "ok"
        }

        /** 다 쓴 임시 파일 지우기 */
        @JavascriptInterface
        fun engineDiscard(name: String) {
            if (!safeName(name)) return
            try { File(File(cacheDir, "incoming"), name).delete() } catch (e: Exception) { }
        }

        /** 페이지에 있는 도면 바이트를 incoming 폴더로 옮기기 (조각조각 base64) */
        @JavascriptInterface
        fun stageBegin(): String {
            return try {
                val id = UUID.randomUUID().toString() + ".bin"
                File(File(cacheDir, "incoming").apply { mkdirs() }, id).writeBytes(ByteArray(0))
                id
            } catch (e: Exception) { "" }
        }

        @JavascriptInterface
        fun stageAppend(id: String, b64: String): Boolean {
            if (!safeName(id)) return false
            return try {
                FileOutputStream(File(File(cacheDir, "incoming"), id), true).use { it.write(Base64.decode(b64, Base64.DEFAULT)) }
                true
            } catch (e: Exception) { false }
        }

        /** 앱 안 '열기': 시스템 파일 선택 → incoming에 복사 → window.__openUrl */
        @JavascriptInterface
        fun pickFile(): Boolean {
            val pick = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            return try {
                runOnUiThread { startActivityForResult(Intent.createChooser(pick, "도면 파일 선택 (DWG · DXF)"), REQ_OPEN) }
                true
            } catch (e: Exception) { false }
        }

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

    private fun safeName(n: String): Boolean =
        n.isNotEmpty() && n.length < 200 && !n.contains('/') && !n.contains('\\') && !n.startsWith(".")

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val FOLDER = "상규도면뷰어"
        const val REQ_PICK = 21
        const val REQ_OPEN = 22
    }
}
