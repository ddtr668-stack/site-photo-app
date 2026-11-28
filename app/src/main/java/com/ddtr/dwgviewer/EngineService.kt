package com.ddtr.dwgviewer

import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger

/**
 * 도면 해석 전용 서비스. 매니페스트에서 따로 된 프로세스(:engine)로 돈다.
 * 손상된 파일 때문에 엔진이 죽어도 앱 화면은 살아 있고, 앱은 예전 엔진으로 다시 연다.
 */
class EngineService : Service() {
    private val handler = object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(msg: Message) {
            if (msg.what != MSG_PARSE) return
            val b = Bundle(msg.data)
            val reply = msg.replyTo ?: return
            Thread(null, {
                val res = Bundle()
                res.putInt("job", b.getInt("job"))
                try {
                    if (!Engine.loaded) res.putString("err", "noLib")
                    else res.putLongArray("r", Engine.convert(b.getString("in")!!, b.getString("out")!!, b.getBoolean("dxf")))
                } catch (t: Throwable) {
                    res.putString("err", t.toString())
                }
                try { reply.send(Message.obtain(null, MSG_DONE).apply { data = res }) } catch (e: Exception) { }
            }, "sgdb", 64L shl 20).start()
        }
    }
    private val messenger = Messenger(handler)

    override fun onBind(intent: Intent): IBinder = messenger.binder

    companion object {
        const val MSG_PARSE = 1
        const val MSG_DONE = 2
    }
}
