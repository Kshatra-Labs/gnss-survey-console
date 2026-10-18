package com.kshatralabs.gnssconsole

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.provider.OpenableColumns
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/** The Site map tab: web/site.html - bundled into the app's assets - in a
 * WebView, so the phone runs the very page (and math) the website does.
 * `window.AndroidSite` gives the page the app's relay address, channel and
 * its own results (and takes back the page's clears and deletions), and
 * opens/saves cameras.local.yaml through Android's file picker. Results and live fixes reach it through the relay as on any
 * device, and straight from this app's rover too. */
class SiteMapHost(private val activity: ComponentActivity, private val vm: ConsoleViewModel) {
    private var configUri: Uri? = null
    private var configName = "cameras.local.yaml"
    private var pendingSaveAs: String? = null
    private var view: WebView? = null

    // registered up front: the Activity Result API needs it before onStart
    private val openDoc = activity.registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(::opened) }
    private val createDoc = activity.registerForActivityResult(ActivityResultContracts.CreateDocument("application/x-yaml")) { uri ->
        val text = pendingSaveAs
        pendingSaveAs = null
        if (uri != null && text != null) io { write(uri, text, nameOf(uri)) }
    }

    /** The WebView, created on first use and kept for the life of the Activity. */
    fun webView(): WebView = view?.also { (it.parent as? ViewGroup)?.removeView(it) } ?: create().also { view = it }

    /** Runs a line of JavaScript in the page, if it exists. */
    fun js(code: String) {
        val v = view ?: return
        v.post { v.evaluateJavascript(code, null) }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun create(): WebView {
        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(activity))
            .build()
        // debug builds: the page can be inspected from desktop Chrome (chrome://inspect)
        if (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        return WebView(activity).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // a self-hosted relay on the local network is plain http
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)

                // stay on the bundled page; anything else opens in the browser
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val u = request.url
                    if (u.host == ASSET_HOST) {
                        if (u.path?.endsWith("/index.html") == true) { vm.tab = 0; return true } // the console is the Survey tab here
                        return false
                    }
                    runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, u)) }
                    return true
                }
            }
            addJavascriptInterface(Bridge(), "AndroidSite")
            loadUrl("https://$ASSET_HOST/assets/site.html")
        }
    }

    /** Called by the page (on WebView's JavaBridge thread). */
    inner class Bridge {
        @JavascriptInterface fun relayUrl(): String = vm.backendUrl
        @JavascriptInterface fun channel(): String = vm.channel
        @JavascriptInterface fun results(channel: String): String = vm.results.load(channel).toString()
        /** The page cleared the channel or removed a point: the app's copy takes it at once. */
        @JavascriptInterface fun mergeResults(channel: String, json: String) = vm.adoptFromSite(channel, json)
        @JavascriptInterface fun openConfig() = activity.runOnUiThread { openDoc.launch(arrayOf("*/*")) }
        @JavascriptInterface fun saveConfig(text: String) {
            val uri = configUri ?: return js("siteAndroid.configSaved(false, ${q("open the file first")})")
            io { write(uri, text, configName) }
        }
        @JavascriptInterface fun saveConfigAs(text: String) {
            pendingSaveAs = text
            activity.runOnUiThread { createDoc.launch("cameras.local.yaml") }
        }
        @JavascriptInterface fun copy(text: String) = activity.runOnUiThread {
            (activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("value", text))
            Toast.makeText(activity, "copied", Toast.LENGTH_SHORT).show()
        }
    }

    private fun opened(uri: Uri) = io {
        // keep write access, so "Save to the file" can write back in place
        runCatching {
            activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        try {
            val text = activity.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
            if (text.size > MAX_FILE) throw IllegalStateException("that file is ${text.size / 1024} KB - not a settings file?")
            configUri = uri
            configName = nameOf(uri)
            js("siteAndroid.configOpened(${q(configName)}, ${q(String(text, Charsets.UTF_8))})")
        } catch (e: Exception) {
            js("siteAndroid.configError(${q("could not open it: ${e.message}")})")
        }
    }

    /** Writes, reads back, and only reports success if the file holds exactly `text`. */
    private fun write(uri: Uri, text: String, name: String) {
        val msg = try {
            activity.contentResolver.openOutputStream(uri, "wt")!!.use { it.write(text.toByteArray(Charsets.UTF_8)) }
            val back = activity.contentResolver.openInputStream(uri)!!.use { String(it.readBytes(), Charsets.UTF_8) }
            if (back != text) throw IllegalStateException("the file doesn't match after saving")
            "true, ${q("saved $name and read it back - it holds the survey now")}"
        } catch (e: Exception) {
            "false, ${q("${e.message ?: e.javaClass.simpleName} - this app may not be allowed to write there; use Download")}"
        }
        js("siteAndroid.configSaved($msg)")
    }

    private fun nameOf(uri: Uri): String = runCatching {
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        }
    }.getOrNull() ?: "cameras.local.yaml"

    private fun io(body: () -> Unit) = Thread(body).apply { isDaemon = true; start() }

    companion object {
        const val ASSET_HOST = "appassets.androidplatform.net"
        private const val MAX_FILE = 1_000_000
        fun q(s: String): String = JSONObject.quote(s)
    }
}
