package com.kshatralabs.gnssconsole

import android.app.Application
import android.content.BroadcastReceiver
import android.content.SharedPreferences
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.AndroidViewModel
import com.kshatralabs.gnssconsole.gnss.LIVE_SOURCE
import com.kshatralabs.gnssconsole.gnss.LocalBaseController
import com.kshatralabs.gnssconsole.gnss.LocalRoverController
import com.kshatralabs.gnssconsole.gnss.Origin
import com.kshatralabs.gnssconsole.gnss.PointResult
import com.kshatralabs.gnssconsole.gnss.RelayClient
import com.kshatralabs.gnssconsole.gnss.Results
import com.kshatralabs.gnssconsole.gnss.UsbPortRef
import com.kshatralabs.gnssconsole.gnss.UsbRover
import com.kshatralabs.gnssconsole.gnss.fmt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

private const val PREFS = "gnss_console_prefs"
private const val RESULTS_PREFS = "gnss_results"
private const val KEY_BACKEND_URL = "backend_url"
private const val KEY_CHANNEL = "channel"
private const val SYNC_EVERY_MS = 60_000L

// Same default relay as web/app.js. It only forwards RTCM3 bytes; all GNSS
// work happens on whichever device has the receiver plugged in.
private const val DEFAULT_BACKEND = "https://gnss-relay.onrender.com"
private const val DEFAULT_CHANNEL = "default"

private class PrefsKv(private val p: SharedPreferences) : Results.KeyValue {
    override fun get(key: String): String? = p.getString(key, null)
    override fun put(key: String, value: String) { p.edit().putString(key, value).apply() }
    override fun keys(): Set<String> = p.all.keys
}

/** Survives rotation, so a running session is never orphaned. Owns this
 * phone's survey results and keeps them synced with the relay, where the
 * Site map on any device (this app's included) picks them up. */
class ConsoleViewModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val results = Results(PrefsKv(app.getSharedPreferences(RESULTS_PREFS, Context.MODE_PRIVATE)))
    val base = LocalBaseController()
    val point = LocalRoverController("Rover point survey", preemptible = false)
    val monitor = LocalRoverController("Rover live monitor", preemptible = true)
    var backendUrl by mutableStateOf(prefs.getString(KEY_BACKEND_URL, null) ?: DEFAULT_BACKEND)
        private set
    var channel by mutableStateOf(prefs.getString(KEY_CHANNEL, null) ?: DEFAULT_CHANNEL)
        private set
    var originLat by mutableStateOf("")
    var originLon by mutableStateOf("")
    var originAlt by mutableStateOf("")
    var usbTick by mutableIntStateOf(0)
    var tab by mutableIntStateOf(0)
    /** Upload state of the latest point result, shown under it. */
    var syncText by mutableStateOf<String?>(null)
    var syncOk by mutableStateOf<Boolean?>(null)
    /** Set by the Activity: runs JavaScript in the Site map page. */
    @Volatile var siteJs: (String) -> Unit = {}
    @Volatile private var cleared = false
    @Volatile private var lastPvtToSite = 0L

    init {
        point.onResult = { r, ch -> results.record(ch, r); syncText = "uploading to the relay..."; syncOk = null; syncNow(ch) }
        point.onPvt = ::pvtToSite
        monitor.onPvt = ::pvtToSite
        // anything surveyed while the relay was unreachable goes up as soon as it answers
        Thread {
            while (!cleared) {
                try { Thread.sleep(SYNC_EVERY_MS) } catch (_: InterruptedException) { }
                for (ch in results.channels()) if (!cleared) syncNow(ch, quiet = true)
            }
        }.apply { isDaemon = true; start() }
    }

    fun updateBackendUrl(url: String) { backendUrl = url; prefs.edit().putString(KEY_BACKEND_URL, url).apply() }
    fun updateChannel(ch: String) { channel = ch; prefs.edit().putString(KEY_CHANNEL, ch).apply() }

    fun syncNow(channel: String, quiet: Boolean = false) = Thread {
        val o = results.sync(backendUrl, channel)
        if (!quiet || o.pushed > 0) {
            syncOk = o.error == null
            syncText = if (o.error == null) "on the relay: the Site map on any device sees it (channel \"$channel\")"
            else "not on the relay yet (${o.error}) - kept on this phone, retried every minute"
        }
        siteJs("siteAndroid.resultsChanged()")
    }.apply { isDaemon = true; start() }

    private fun pvtToSite(pvt: com.kshatralabs.gnssconsole.gnss.Ubx.NavPvt?) {
        val now = System.currentTimeMillis()
        if (pvt == null || pvt.fixType < 2 || now - lastPvtToSite < 1000) return
        lastPvtToSite = now
        siteJs("siteAndroid.pvt(${RelayClient.pvtJson(pvt, LIVE_SOURCE)})")
    }

    override fun onCleared() {
        cleared = true
        base.stop(); point.stop(); monitor.stop()
    }
}

class MainActivity : ComponentActivity() {
    private val vm: ConsoleViewModel by viewModels()
    private lateinit var site: SiteMapHost

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) { vm.usbTick++ }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val filter = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        ContextCompat.registerReceiver(this, usbReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        site = SiteMapHost(this, vm)
        vm.siteJs = site::js
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) { GnssConsoleApp(vm, site) }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        vm.usbTick++ // launched again by a USB_DEVICE_ATTACHED intent
    }

    override fun onDestroy() {
        vm.siteJs = {} // the WebView goes with this Activity; the ViewModel may outlive it
        unregisterReceiver(usbReceiver)
        super.onDestroy()
    }
}

private val Good = Color(0xFF2E9E55)
private val Warn = Color(0xFFC98A1B)
private val Bad = Color(0xFFD0453A)

@Composable
fun GnssConsoleApp(vm: ConsoleViewModel, site: SiteMapHost) {
    Column(Modifier.fillMaxSize()) {
        TabRow(selectedTabIndex = vm.tab) {
            Tab(selected = vm.tab == 0, onClick = { vm.tab = 0 }, text = { Text("Survey") })
            Tab(selected = vm.tab == 1, onClick = { vm.tab = 1 }, text = { Text("Site map") })
        }
        if (vm.tab == 0) SurveyScreen(vm) else AndroidView(factory = { site.webView() }, modifier = Modifier.fillMaxSize())
    }
    // the Site map follows the channel set on the Survey tab
    LaunchedEffect(vm.tab, vm.channel) {
        if (vm.tab == 1 && vm.channel.isNotBlank()) site.js("siteAndroid.useChannel(${SiteMapHost.q(vm.channel)})")
    }
}

@Composable
private fun SurveyScreen(vm: ConsoleViewModel) {
    val ctx = LocalContext.current
    val backendUrl = vm.backendUrl

    var usbPorts by remember { mutableStateOf(listOf<UsbPortRef>()) }
    var usbRawCount by remember { mutableIntStateOf(0) }
    fun refreshUsbPorts() {
        val scan = UsbRover.scan(ctx)
        usbPorts = scan.candidates
        usbRawCount = scan.rawDeviceCount
    }
    LaunchedEffect(vm.usbTick) { refreshUsbPorts() }

    // Screen (and with it USB + network) stays on while anything runs.
    val view = LocalView.current
    val anyRunning = vm.base.running || vm.point.running || vm.monitor.running
    DisposableEffect(anyRunning) {
        view.keepScreenOn = anyRunning
        onDispose { }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp)
    ) {
        Text("GNSS Survey Console", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text(
            "u-blox F9P RTK survey. Base and Rover plug into phones directly; corrections go through the cloud relay.",
            fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(12.dp))

        RelayCard(backendUrl = backendUrl, onBackendUrlChange = { vm.updateBackendUrl(it) })
        Spacer(Modifier.height(16.dp))

        UsbPortsCard(ports = usbPorts, rawCount = usbRawCount, onRescan = { refreshUsbPorts() })
        Spacer(Modifier.height(16.dp))

        BaseCard(vm, vm.base, usbPorts, ctx, backendUrl)
        Spacer(Modifier.height(16.dp))

        PointCard(vm, vm.point, usbPorts, ctx, backendUrl)
        Spacer(Modifier.height(16.dp))

        RoverMonitorCard(vm, vm.monitor, usbPorts, ctx, backendUrl)
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun RelayCard(backendUrl: String, onBackendUrlChange: (String) -> Unit) {
    var health by remember { mutableStateOf("checking relay...") }
    var healthOk by remember { mutableStateOf<Boolean?>(null) }
    var recheck by remember { mutableIntStateOf(0) }
    LaunchedEffect(backendUrl, recheck) {
        delay(700) // let typing settle
        health = "checking relay... (a sleeping free-tier relay can take up to a minute to wake)"
        healthOk = null
        val (ok, text) = withContext(Dispatchers.IO) { RelayClient.health(backendUrl) }
        healthOk = ok
        health = text
    }
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text("Cloud relay", fontWeight = FontWeight.Bold)
            Text(
                "Where Base and Rover find each other. Pre-filled - only change it if you run your own relay.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = backendUrl, onValueChange = onBackendUrlChange,
                label = { Text("relay address") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            TextButton(onClick = { recheck++ }) { Text("Test relay") }
            StatusBox(health, isError = healthOk == false)
        }
    }
}

@Composable
private fun UsbPortsCard(ports: List<UsbPortRef>, rawCount: Int, onRescan: () -> Unit) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text("USB devices", fontWeight = FontWeight.Bold)
            Text(
                "Plug receivers in with a USB-C OTG adapter (a hub for two). The list refreshes itself on plug/unplug.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Button(onClick = onRescan, modifier = Modifier.padding(top = 6.dp)) { Text("Rescan USB devices") }
            Spacer(Modifier.height(6.dp))
            val emptyMsg = when {
                ports.isNotEmpty() -> null
                rawCount == 0 -> "(nothing detected - Android sees no USB device at all. Try another OTG " +
                    "cable/adapter, or check the phone supports USB host/OTG.)"
                else -> "($rawCount USB device(s) detected, but none is a known serial chip.)"
            }
            Text(emptyMsg ?: ports.joinToString("\n") { it.label }, fontSize = 12.sp)
        }
    }
}

// .clickable{} on a readOnly OutlinedTextField is swallowed by the field's
// own focus handling, so an invisible Box on top takes the tap instead.
@Composable
private fun UsbPortDropdown(label: String, ports: List<UsbPortRef>, selected: UsbPortRef?, enabled: Boolean, onSelect: (UsbPortRef) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box(modifier = Modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = selected?.label ?: "(none - plug one in)",
            onValueChange = {}, readOnly = true, label = { Text(label) }, enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
        )
        Box(modifier = Modifier.matchParentSize().clickable(enabled = enabled) { expanded = true })
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            if (ports.isEmpty()) DropdownMenuItem(text = { Text("none - plug one in") }, onClick = { expanded = false })
            for (p in ports) DropdownMenuItem(text = { Text(p.label) }, onClick = { onSelect(p); expanded = false })
        }
    }
}

/** Keeps a selection across rescans (matched by device), falling back to a default. */
@Composable
private fun rememberPortSelection(ports: List<UsbPortRef>, preferIndex: Int): MutableState<UsbPortRef?> {
    val sel = remember { mutableStateOf<UsbPortRef?>(null) }
    LaunchedEffect(ports) {
        val cur = sel.value
        sel.value = ports.firstOrNull { it.key == cur?.key }
            ?: ports.getOrNull(preferIndex) ?: ports.firstOrNull()
    }
    return sel
}

@Composable
private fun StatusBox(text: String, isError: Boolean) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = MaterialTheme.shapes.small,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    ) {
        Text(
            text, modifier = Modifier.padding(10.dp), fontSize = 11.5.sp, fontFamily = FontFamily.Monospace,
            color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Badge(text: String?, color: Color) {
    if (text == null) return
    Text(text, color = color, fontSize = 12.sp, fontWeight = FontWeight.Bold)
}

@Composable
private fun TitleRow(title: String, badge: String?, badgeColor: Color) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(title, fontWeight = FontWeight.Bold)
        Badge(badge, badgeColor)
    }
}

private fun fixColor(badge: String?): Color = when {
    badge == null -> Color.Unspecified
    badge.contains("FIXED") -> Good
    badge.contains("FLOAT") -> Warn
    else -> Bad
}

@Composable
private fun NumberField(label: String, value: String, enabled: Boolean, modifier: Modifier = Modifier, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value, onValueChange = onChange, label = { Text(label) }, enabled = enabled,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        singleLine = true, modifier = modifier,
    )
}

@Composable
private fun ChannelField(vm: ConsoleViewModel, enabled: Boolean) {
    OutlinedTextField(
        value = vm.channel, onValueChange = { vm.updateChannel(it.trim()) }, enabled = enabled,
        label = { Text("Relay channel (same on Base, Rover and Site map)") },
        singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
    )
}

@Composable
private fun BaseCard(vm: ConsoleViewModel, c: LocalBaseController, ports: List<UsbPortRef>, context: Context, backendUrl: String) {
    var port by rememberPortSelection(ports, 0)
    var minDuration by rememberSaveable { mutableStateOf("60") }
    var accLimit by rememberSaveable { mutableStateOf("2.0") }
    val md = minDuration.toIntOrNull()
    val al = accLimit.toDoubleOrNull()
    val inputsOk = md != null && md > 0 && al != null && al > 0

    val badgeColor = when {
        c.phase == "broadcasting" -> Good
        c.phase.startsWith("broadcasting") || c.phase == "surveying" || c.phase == "configuring" -> Warn
        c.phase == "error" || c.phase == "stopped" -> Bad
        else -> Color.Unspecified
    }
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            TitleRow("1. Base (USB)", if (c.running || c.phase != "idle") c.phase else null, badgeColor)
            Text(
                "Start first, under open sky, and leave it running for the whole survey. Baud rate is detected automatically.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(8.dp))
            UsbPortDropdown("USB receiver (base)", ports, port, !c.running) { port = it }
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NumberField("Min duration (s)", minDuration, !c.running, Modifier.weight(1f)) { minDuration = it }
                NumberField("Accuracy limit (m)", accLimit, !c.running, Modifier.weight(1f)) { accLimit = it }
            }
            ChannelField(vm, !c.running)
            Row(Modifier.padding(top = 8.dp)) {
                Button(
                    enabled = !c.running && port != null && inputsOk && vm.channel.isNotBlank(),
                    onClick = { port?.let { c.start(context, it, md!!, al!!, backendUrl, vm.channel) } },
                ) { Text("Start base") }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(enabled = c.running, onClick = { c.stop() }) { Text("Stop") }
            }
            if (!inputsOk) Text("Min duration and accuracy limit must be positive numbers.", color = Bad, fontSize = 12.sp)
            StatusBox(c.error?.let { "ERROR: $it" } ?: c.statusText, c.error != null)
        }
    }
}

private fun parseOrigin(lat: String, lon: String, alt: String): Result<Origin?> {
    val vals = listOf(lat, lon, alt).map { it.trim() }
    if (vals.all { it.isEmpty() }) return Result.success(null)
    val nums = vals.map { it.toDoubleOrNull() }
    if (nums.any { it == null }) return Result.failure(IllegalArgumentException("origin lat/lon/alt must all be numbers (or all empty)"))
    return Result.success(Origin(nums[0]!!, nums[1]!!, nums[2]!!))
}

@Composable
private fun PointCard(vm: ConsoleViewModel, c: LocalRoverController, ports: List<UsbPortRef>, context: Context, backendUrl: String) {
    var port by rememberPortSelection(ports, 1)
    var duration by rememberSaveable { mutableStateOf("60") }
    var label by rememberSaveable { mutableStateOf("") }
    var requireFixed by rememberSaveable { mutableStateOf(true) }

    LaunchedEffect(c.result) {
        val r = c.result ?: return@LaunchedEffect
        if (r.label == "origin" && !r.cancelled) {
            vm.originLat = fmt(r.latDeg, 9); vm.originLon = fmt(r.lonDeg, 9); vm.originAlt = fmt(r.heightMslM, 3)
        }
    }
    val d = duration.toDoubleOrNull()
    val origin = parseOrigin(vm.originLat, vm.originLon, vm.originAlt)
    val originErr = origin.exceptionOrNull()?.message?.takeIf { label.trim() != "origin" }

    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            TitleRow("2. Rover - survey a point (USB)", c.fixBadge, fixColor(c.fixBadge))
            Text(
                "Survey \"origin\" first. Wait for FIX=true before trusting a point.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(8.dp))
            UsbPortDropdown("USB receiver (rover)", ports, port, !c.running) { port = it }
            NumberField("Duration (s)", duration, !c.running, Modifier.fillMaxWidth().padding(top = 6.dp)) { duration = it }
            ChannelField(vm, !c.running)
            OutlinedTextField(
                value = label, onValueChange = { label = it.trim() }, enabled = !c.running,
                label = { Text("Label (origin, camera_a, camera_b, or a reference point name)") },
                singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (l in listOf("origin", "camera_a", "camera_b")) {
                    FilterChip(selected = label == l, onClick = { label = l }, enabled = !c.running, label = { Text(l) })
                }
            }
            val labelErr = if (label.isNotEmpty() && !Results.LABEL_RE.matches(label)) "label: letters, digits, _ . - only" else null
            if (labelErr != null) Text(labelErr, color = Bad, fontSize = 12.sp)
            Text("Any other name is a reference point for aiming the cameras (Site map).", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                Checkbox(checked = requireFixed, onCheckedChange = { requireFixed = it }, enabled = !c.running)
                Text("RTK FIXED epochs only (untick to also accept FLOAT)", fontSize = 12.sp)
            }
            Text("Origin (auto-filled after surveying \"origin\")", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                NumberField("lat", vm.originLat, !c.running, Modifier.weight(1f)) { vm.originLat = it }
                NumberField("lon", vm.originLon, !c.running, Modifier.weight(1f)) { vm.originLon = it }
                NumberField("alt", vm.originAlt, !c.running, Modifier.weight(1f)) { vm.originAlt = it }
            }
            if (originErr != null) Text(originErr, color = Bad, fontSize = 12.sp)
            Row(Modifier.padding(top = 8.dp)) {
                Button(
                    enabled = !c.running && port != null && label.isNotBlank() && labelErr == null && d != null && d > 0 && originErr == null && vm.channel.isNotBlank(),
                    onClick = {
                        val p = port ?: return@Button
                        val o = if (label.trim() == "origin") null else origin.getOrNull()
                        c.startPoint(context, p, backendUrl, vm.channel, label.trim(), d!!, requireFixed, o)
                    },
                ) { Text("Survey this point") }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(enabled = c.running, onClick = { c.stop() }) { Text("Stop") }
            }
            StatusBox(c.error?.let { "ERROR: $it" } ?: c.statusText, c.error != null)
            c.result?.let { r ->
                PointResultView(r)
                if (!r.cancelled) vm.syncText?.let { t ->
                    Text(
                        "saved as \"${r.label}\" for the Site map - $t", fontSize = 12.sp,
                        color = when (vm.syncOk) { true -> Good; false -> Warn; null -> MaterialTheme.colorScheme.onSurfaceVariant },
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun PointResultView(r: PointResult) {
    if (r.cancelled) return
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = MaterialTheme.shapes.small,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    ) {
        Column(Modifier.padding(10.dp)) {
            val mono = FontFamily.Monospace
            Text("label: ${r.label}", fontSize = 12.sp, fontFamily = mono)
            Text("lat: ${fmt(r.latDeg, 9)}", fontSize = 12.sp, fontFamily = mono)
            Text("lon: ${fmt(r.lonDeg, 9)}", fontSize = 12.sp, fontFamily = mono)
            Text("height_msl_m: ${fmt(r.heightMslM, 3)}", fontSize = 12.sp, fontFamily = mono)
            Text("epochs: ${r.n}  spread: ${fmt(r.spreadM, 3)}m", fontSize = 12.sp, fontFamily = mono)
            Text(
                "fix=${r.allFixed}  (fix=true: every averaged epoch was RTK FIXED)",
                fontSize = 12.sp, fontFamily = mono, fontWeight = FontWeight.Bold, color = if (r.allFixed) Good else Warn,
            )
            if (r.originE != null) {
                Spacer(Modifier.height(4.dp))
                Text("origin_e: ${fmt(r.originE, 4)}", fontSize = 12.sp, fontFamily = mono)
                Text("origin_n: ${fmt(r.originN!!, 4)}", fontSize = 12.sp, fontFamily = mono)
                Text("origin_u: ${fmt(r.originU!!, 4)}", fontSize = 12.sp, fontFamily = mono)
            }
        }
    }
}

@Composable
private fun RoverMonitorCard(vm: ConsoleViewModel, c: LocalRoverController, ports: List<UsbPortRef>, context: Context, backendUrl: String) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    var port by rememberPortSelection(ports, 1)

    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Rover - live monitor (optional)", fontWeight = FontWeight.Bold)
                    Text("Watch FIX status without recording. A point survey on the same receiver stops this automatically.",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (c.fixBadge != null) Badge(c.fixBadge, fixColor(c.fixBadge)) else Text(if (expanded) "hide" else "show", fontSize = 12.sp)
            }
            if (expanded || c.running) {
                Spacer(Modifier.height(8.dp))
                UsbPortDropdown("USB receiver", ports, port, !c.running) { port = it }
                ChannelField(vm, !c.running)
                Row(Modifier.padding(top = 8.dp)) {
                    Button(
                        enabled = !c.running && port != null && vm.channel.isNotBlank(),
                        onClick = { port?.let { c.startMonitor(context, it, backendUrl, vm.channel) } },
                    ) { Text("Start") }
                    Spacer(Modifier.width(8.dp))
                    OutlinedButton(enabled = c.running, onClick = { c.stop() }) { Text("Stop") }
                }
                StatusBox(c.error?.let { "ERROR: $it" } ?: c.statusText, c.error != null)
            }
        }
    }
}
