package com.kshatralabs.gnssconsole

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kshatralabs.gnssconsole.gnss.LocalBaseController
import com.kshatralabs.gnssconsole.gnss.LocalRoverController
import com.kshatralabs.gnssconsole.gnss.Origin
import com.kshatralabs.gnssconsole.gnss.PointResult
import com.kshatralabs.gnssconsole.gnss.UsbPortRef
import com.kshatralabs.gnssconsole.gnss.UsbRover

private const val PREFS = "gnss_console_prefs"
private const val KEY_BACKEND_URL = "backend_url"

// This project's own known-stable relay address (matches web/app.js's
// DEFAULT_BACKEND) - autofilled so the app works with zero typing for the
// common case. The backend here is a pure byte relay with no USB/serial
// access of its own; all GNSS work happens on-device (Base and Rover are
// both local-USB-only now - there is no "remote base" mode).
private const val DEFAULT_BACKEND = "https://gnss-relay.onrender.com"
private const val DEFAULT_CHANNEL = "default"

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) { GnssConsoleApp() }
            }
        }
    }
}

private fun loadBackendUrl(ctx: Context): String =
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_BACKEND_URL, null) ?: DEFAULT_BACKEND

private fun saveBackendUrl(ctx: Context, url: String) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_BACKEND_URL, url).apply()
}

@Composable
fun GnssConsoleApp() {
    val ctx = LocalContext.current

    var backendUrl by remember { mutableStateOf(loadBackendUrl(ctx)) }

    // USB devices: anything plugged into THIS phone's USB-C/OTG port.
    var usbPorts by remember { mutableStateOf(listOf<UsbPortRef>()) }
    var usbRawCount by remember { mutableStateOf(0) }
    fun refreshUsbPorts() {
        val scan = UsbRover.scan(ctx)
        usbPorts = scan.candidates
        usbRawCount = scan.rawDeviceCount
    }
    LaunchedEffect(Unit) { refreshUsbPorts() }

    val baseController = remember { LocalBaseController() }
    val pointController = remember { LocalRoverController() }
    val roverController = remember { LocalRoverController() }

    // Shared relay channel: Base broadcasts on it, Rover/monitor listen on
    // it - autofilled to the same default everywhere so nothing needs
    // typing unless you're running more than one base/rover pair at once.
    var relayChannel by remember { mutableStateOf(DEFAULT_CHANNEL) }

    var originLat by remember { mutableStateOf("") }
    var originLon by remember { mutableStateOf("") }
    var originAlt by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp)
    ) {
        Text("GNSS Survey Console", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text(
            "u-blox F9P RTK survey. Base and Rover both plug into this phone directly.",
            fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(12.dp))

        IntroCard()
        Spacer(Modifier.height(16.dp))

        RelayCard(backendUrl = backendUrl, onBackendUrlChange = { backendUrl = it; saveBackendUrl(ctx, it) })
        Spacer(Modifier.height(16.dp))

        UsbPortsCard(ports = usbPorts, rawCount = usbRawCount, onRescan = { refreshUsbPorts() })
        Spacer(Modifier.height(16.dp))

        BaseCard(
            controller = baseController, ports = usbPorts, context = ctx,
            backendUrl = backendUrl, channel = relayChannel, onChannelChange = { relayChannel = it },
        )
        Spacer(Modifier.height(16.dp))

        PointCard(
            controller = pointController, ports = usbPorts, context = ctx,
            backendUrl = backendUrl, channel = relayChannel, onChannelChange = { relayChannel = it },
            originLat = originLat, originLon = originLon, originAlt = originAlt,
            onOriginFilled = { lat, lon, alt -> originLat = lat; originLon = lon; originAlt = alt },
        )
        Spacer(Modifier.height(16.dp))

        RoverMonitorCard(
            controller = roverController, ports = usbPorts, context = ctx,
            backendUrl = backendUrl, channel = relayChannel, onChannelChange = { relayChannel = it },
        )
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun IntroCard() {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text(
                "A single GPS is accurate to a few metres. Two GPS units working " +
                    "together as RTK - one fixed, one carried around - are accurate " +
                    "to a couple of centimetres.",
                fontSize = 13.sp
            )
            Spacer(Modifier.height(8.dp))
            Text("BASE", fontWeight = FontWeight.Bold, fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
            Text(
                "Plugs into this phone's USB-C port. Works out its own position " +
                    "precisely, then uploads corrections to the cloud relay below.",
                fontSize = 12.5.sp
            )
            Spacer(Modifier.height(6.dp))
            Text("ROVER", fontWeight = FontWeight.Bold, fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
            Text(
                "Also plugs into a USB port (this phone, with a hub, or a different " +
                    "phone). Pulls corrections from the same relay channel and gives " +
                    "you a centimetre-accurate reading of wherever it currently is.",
                fontSize = 12.5.sp
            )
            Spacer(Modifier.height(6.dp))
            Text(
                "Note: the relay only forwards bytes - it has no USB/GPS access of " +
                    "its own, so all the actual GNSS work happens on whichever device " +
                    "has a receiver plugged in, here or in a browser.",
                fontSize = 11.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun RelayCard(backendUrl: String, onBackendUrlChange: (String) -> Unit) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text("Cloud relay", fontWeight = FontWeight.Bold)
            Text(
                "Where Base and Rover find each other. Auto-filled with this " +
                    "project's known address - only change it if you're running your own relay.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = backendUrl,
                onValueChange = onBackendUrlChange,
                label = { Text("https://your-relay-address") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun UsbPortsCard(ports: List<UsbPortRef>, rawCount: Int, onRescan: () -> Unit) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text("USB devices", fontWeight = FontWeight.Bold)
            Text(
                "Plug receivers into this phone with a USB-C OTG adapter/cable (a hub for more than one), then rescan.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(8.dp))
            Button(onClick = onRescan, modifier = Modifier.padding(top = 0.dp)) { Text("Rescan USB devices") }
            Spacer(Modifier.height(8.dp))
            val emptyMsg = when {
                ports.isNotEmpty() -> null
                rawCount == 0 -> "(nothing detected - Android sees no USB device at all. Try a different OTG " +
                    "cable/adapter, or check the phone actually supports USB host/OTG mode.)"
                else -> "($rawCount USB device(s) detected, but none matched a known serial chip. " +
                    "Check res/xml/device_filter.xml has its vendor/product ID.)"
            }
            Text(
                emptyMsg ?: ports.joinToString("\n") { it.label },
                fontSize = 12.sp,
            )
        }
    }
}

// NOTE: putting .clickable{} directly on a readOnly OutlinedTextField is a
// well-known Compose trap - the text field consumes the tap for its own
// focus/cursor handling first, so the click often never fires. The fix is
// an invisible Box overlaid on top of the field that intercepts the tap
// before the field gets it.
@Composable
private fun UsbPortDropdown(label: String, ports: List<UsbPortRef>, selected: UsbPortRef?, onSelect: (UsbPortRef) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box(modifier = Modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = selected?.label ?: "(select)",
            onValueChange = {}, readOnly = true, label = { Text(label) },
            modifier = Modifier.fillMaxWidth(),
        )
        Box(
            modifier = Modifier
                .matchParentSize()
                .clickable { expanded = true },
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            if (ports.isEmpty()) DropdownMenuItem(text = { Text("none - rescan above") }, onClick = { expanded = false })
            for (p in ports) DropdownMenuItem(text = { Text(p.label) }, onClick = { onSelect(p); expanded = false })
        }
    }
}

@Composable
private fun StatusBox(text: String, isError: Boolean) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = MaterialTheme.shapes.small,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    ) {
        Text(
            text, modifier = Modifier.padding(10.dp), fontSize = 12.sp,
            color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun NumberRow(
    label1: String, value1: String, onChange1: (String) -> Unit,
    label2: String, value2: String, onChange2: (String) -> Unit,
) {
    Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = value1, onValueChange = onChange1, label = { Text(label1) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true, modifier = Modifier.weight(1f),
        )
        OutlinedTextField(
            value = value2, onValueChange = onChange2, label = { Text(label2) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true, modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun BaudField(baud: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = baud, onValueChange = onChange, label = { Text("Baud") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
    )
}

@Composable
private fun RelayChannelField(channel: String, onChannelChange: (String) -> Unit) {
    OutlinedTextField(
        value = channel, onValueChange = onChannelChange,
        label = { Text("Relay channel (must match on Base and Rover)") },
        singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
    )
}

@Composable
private fun BaseCard(
    controller: LocalBaseController, ports: List<UsbPortRef>, context: Context,
    backendUrl: String, channel: String, onChannelChange: (String) -> Unit,
) {
    var port by remember { mutableStateOf<UsbPortRef?>(null) }
    var baud by remember { mutableStateOf("115200") }
    var minDuration by remember { mutableStateOf("60") }
    var accLimit by remember { mutableStateOf("2.0") }

    LaunchedEffect(ports) { if (port == null && ports.isNotEmpty()) port = ports.first() }

    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text("Base (USB)", fontWeight = FontWeight.Bold)
            Text(
                "Start this first, with the receiver plugged in. Leave it running for the whole survey.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(8.dp))
            UsbPortDropdown("USB receiver (base)", ports, port) { port = it }
            NumberRow("Min duration (s)", minDuration, { minDuration = it }, "Accuracy limit (m)", accLimit, { accLimit = it })
            RelayChannelField(channel, onChannelChange)
            Spacer(Modifier.height(4.dp))
            BaudField(baud) { baud = it }
            Spacer(Modifier.height(8.dp))
            Row {
                Button(
                    enabled = !controller.running && port != null,
                    onClick = {
                        val p = port ?: return@Button
                        val b = baud.toIntOrNull() ?: 115200
                        val md = minDuration.toIntOrNull() ?: 60
                        val al = accLimit.toDoubleOrNull() ?: 2.0
                        controller.start(context, p, b, md, al, backendUrl, channel)
                    },
                ) { Text("Start base") }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(enabled = controller.running, onClick = { controller.stop() }) { Text("Stop") }
            }
            StatusBox(
                controller.startError ?: controller.error?.let { "ERROR: $it" } ?: controller.statusText,
                controller.error != null || controller.startError != null,
            )
        }
    }
}

@Composable
private fun PointCard(
    controller: LocalRoverController, ports: List<UsbPortRef>, context: Context,
    backendUrl: String, channel: String, onChannelChange: (String) -> Unit,
    originLat: String, originLon: String, originAlt: String,
    onOriginFilled: (String, String, String) -> Unit,
) {
    var port by remember { mutableStateOf<UsbPortRef?>(null) }
    var baud by remember { mutableStateOf("115200") }
    var duration by remember { mutableStateOf("60") }
    var label by remember { mutableStateOf("") }
    var requireFixed by remember { mutableStateOf(true) }
    var oLat by remember { mutableStateOf(originLat) }
    var oLon by remember { mutableStateOf(originLon) }
    var oAlt by remember { mutableStateOf(originAlt) }

    LaunchedEffect(ports) { if (port == null && ports.isNotEmpty()) port = ports.first() }

    LaunchedEffect(controller.result) {
        val r = controller.result ?: return@LaunchedEffect
        if (r.label == "origin" && !r.cancelled) {
            oLat = r.latDeg.toString(); oLon = r.lonDeg.toString(); oAlt = r.heightMslM.toString()
            onOriginFilled(oLat, oLon, oAlt)
        }
    }

    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Text("Rover - survey a point (USB)", fontWeight = FontWeight.Bold)
            Text(
                "Carry the phone (with the receiver plugged in) to the spot you're recording. Survey \"origin\" first.",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(8.dp))
            UsbPortDropdown("USB receiver (rover)", ports, port) { port = it }
            NumberRow("Baud", baud, { baud = it }, "Duration (s)", duration, { duration = it })
            RelayChannelField(channel, onChannelChange)
            OutlinedTextField(
                value = label, onValueChange = { label = it },
                label = { Text("Label (origin, camera_a, camera_b, ...)") },
                singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            )
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                Checkbox(checked = requireFixed, onCheckedChange = { requireFixed = it })
                Text("RTK FIXED epochs only", fontSize = 12.sp)
            }
            Spacer(Modifier.height(4.dp))
            Text("Origin reference (auto-filled after surveying \"origin\")", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(oLat, { oLat = it }, label = { Text("lat") }, singleLine = true, modifier = Modifier.weight(1f))
                OutlinedTextField(oLon, { oLon = it }, label = { Text("lon") }, singleLine = true, modifier = Modifier.weight(1f))
                OutlinedTextField(oAlt, { oAlt = it }, label = { Text("alt") }, singleLine = true, modifier = Modifier.weight(1f))
            }
            Spacer(Modifier.height(8.dp))
            Row {
                Button(
                    enabled = !controller.running && port != null && label.isNotBlank(),
                    onClick = {
                        val p = port ?: return@Button
                        val b = baud.toIntOrNull() ?: 115200
                        val d = duration.toDoubleOrNull() ?: 60.0
                        val origin = if (oLat.isNotBlank() && oLon.isNotBlank() && oAlt.isNotBlank() && label != "origin") {
                            Origin(oLat.toDoubleOrNull() ?: 0.0, oLon.toDoubleOrNull() ?: 0.0, oAlt.toDoubleOrNull() ?: 0.0)
                        } else null
                        controller.startPoint(context, p, b, backendUrl, channel, label, d, requireFixed, origin)
                    },
                ) { Text("Survey this point") }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(enabled = controller.running, onClick = { controller.stop() }) { Text("Stop") }
            }
            StatusBox(
                controller.startError ?: controller.error?.let { "ERROR: $it" } ?: controller.statusText,
                controller.error != null || controller.startError != null,
            )
            controller.result?.let { r -> PointResultView(r) }
        }
    }
}

@Composable
private fun PointResultView(r: PointResult) {
    if (r.cancelled) {
        Text("cancelled", fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
        return
    }
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = MaterialTheme.shapes.small,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    ) {
        Column(Modifier.padding(10.dp)) {
            Text("label: ${r.label}", fontSize = 12.sp)
            Text("lat: ${r.latDeg}", fontSize = 12.sp)
            Text("lon: ${r.lonDeg}", fontSize = 12.sp)
            Text("height_msl_m: ${r.heightMslM}", fontSize = 12.sp)
            Text("epochs: ${r.n}  spread: ${"%.3f".format(r.spreadM)}m  fix=${r.allFixed}  (fix=true means every collected epoch was RTK FIXED)", fontSize = 12.sp)
            if (r.originE != null) {
                Spacer(Modifier.height(4.dp))
                Text("origin_e: ${"%.4f".format(r.originE)}", fontSize = 12.sp)
                Text("origin_n: ${"%.4f".format(r.originN)}", fontSize = 12.sp)
                Text("origin_u: ${"%.4f".format(r.originU)}", fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun RoverMonitorCard(
    controller: LocalRoverController, ports: List<UsbPortRef>, context: Context,
    backendUrl: String, channel: String, onChannelChange: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    var port by remember { mutableStateOf<UsbPortRef?>(null) }
    var baud by remember { mutableStateOf("115200") }

    LaunchedEffect(ports) { if (port == null && ports.isNotEmpty()) port = ports.first() }

    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text("Rover - live monitor (USB, optional)", fontWeight = FontWeight.Bold)
                    Text(
                        "Advanced: watch the raw fix without recording a point.",
                        fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Text(if (expanded) "hide" else "show", fontSize = 12.sp)
            }
            if (expanded) {
                Spacer(Modifier.height(8.dp))
                UsbPortDropdown("USB receiver", ports, port) { port = it }
                BaudField(baud) { baud = it }
                RelayChannelField(channel, onChannelChange)
                Spacer(Modifier.height(8.dp))
                Row {
                    Button(
                        enabled = !controller.running && port != null,
                        onClick = {
                            val p = port ?: return@Button
                            val b = baud.toIntOrNull() ?: 115200
                            controller.startMonitor(context, p, b, backendUrl, channel)
                        },
                    ) { Text("Start") }
                    Spacer(Modifier.width(8.dp))
                    OutlinedButton(enabled = controller.running, onClick = { controller.stop() }) { Text("Stop") }
                }
                StatusBox(
                    controller.startError ?: controller.error?.let { "ERROR: $it" } ?: controller.statusText,
                    controller.error != null || controller.startError != null,
                )
            }
        }
    }
}
