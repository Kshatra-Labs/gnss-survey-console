package com.kshatralabs.gnssconsole.gnss

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import com.hoho.android.usbserial.driver.UsbSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val ACTION_USB_PERMISSION = "com.kshatralabs.gnssconsole.USB_PERMISSION"

data class UsbPortRef(val driver: UsbSerialDriver, val device: UsbDevice, val label: String) {
    val key: String get() = device.deviceName
}

/** rawDeviceCount: every USB device Android sees, matched or not - tells
 * "nothing plugged in / OTG not working" (0) apart from "plugged in but no
 * serial driver recognises it" (>0 with no candidates). */
data class UsbScanResult(val candidates: List<UsbPortRef>, val rawDeviceCount: Int)

/** Which session holds which USB device. A live monitor can be pre-empted
 * (stopped) by a point survey on the same receiver; nothing else can. */
object PortLocks {
    private class Owner(val name: String, val preemptible: Boolean, val stop: () -> Unit)

    private val owners = HashMap<String, Owner>()

    /** null on success, else the current owner's name. */
    fun acquire(key: String, name: String, preemptible: Boolean, stop: () -> Unit, waitMs: Long = 8000): String? {
        val deadline = System.currentTimeMillis() + waitMs
        var askedToStop = false
        while (true) {
            synchronized(this) {
                val cur = owners[key]
                if (cur == null) {
                    owners[key] = Owner(name, preemptible, stop)
                    return null
                }
                if (!cur.preemptible || cur.name == name || System.currentTimeMillis() > deadline) return cur.name
                if (!askedToStop) {
                    cur.stop()
                    askedToStop = true
                }
            }
            Thread.sleep(100)
        }
    }

    @Synchronized
    fun release(key: String, name: String) {
        if (owners[key]?.name == name) owners.remove(key)
    }
}

object UsbRover {

    fun scan(context: Context): UsbScanResult {
        val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
        val raw = usbManager.deviceList.size
        val drivers = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager)
        return UsbScanResult(drivers.map(::toRef), raw)
    }

    private fun toRef(d: UsbSerialDriver): UsbPortRef {
        val dev = d.device
        val product = try { dev.productName } catch (_: SecurityException) { null }
        val name = product?.takeIf { it.isNotBlank() } ?: d.javaClass.simpleName.removeSuffix("SerialDriver")
        return UsbPortRef(d, dev, "$name ${String.format("%04X:%04X", dev.vendorId, dev.productId)} (${dev.deviceName})")
    }

    /** Blocks the calling background thread until the user answers the
     * system USB permission dialog, or timeoutMs elapses. */
    fun requestPermissionBlocking(context: Context, device: UsbDevice, timeoutMs: Long = 60_000): Boolean {
        val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
        if (usbManager.hasPermission(device)) return true

        val latch = CountDownLatch(1)
        val granted = AtomicBoolean(false)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                if (intent.action == ACTION_USB_PERMISSION) {
                    granted.set(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
                    latch.countDown()
                }
            }
        }
        val filter = IntentFilter(ACTION_USB_PERMISSION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(receiver, filter)
        }
        try {
            // The system must fill in EXTRA_PERMISSION_GRANTED, so the
            // PendingIntent has to be mutable - and on Android 14+ a mutable
            // PendingIntent must wrap an explicit intent (setPackage), or
            // getBroadcast throws IllegalArgumentException.
            val intent = Intent(ACTION_USB_PERMISSION).setPackage(context.packageName)
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
            val pi = PendingIntent.getBroadcast(context, 0, intent, flags)
            usbManager.requestPermission(device, pi)
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } finally {
            try { context.unregisterReceiver(receiver) } catch (_: Exception) { }
        }
        return granted.get() || usbManager.hasPermission(device)
    }

    /** Opens the driver's first port. Throws with a readable message. */
    fun open(context: Context, ref: UsbPortRef): UsbGnssConnection {
        val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
        val connection = usbManager.openDevice(ref.device)
            ?: throw IOException("could not open ${ref.label} - permission denied or the device was unplugged")
        val port: UsbSerialPort = ref.driver.ports.firstOrNull()
            ?: throw IOException("${ref.label} has no serial port")
        try {
            port.open(connection)
            port.setParameters(115200, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            // Some CDC-ACM devices only send while DTR is asserted.
            try { port.dtr = true } catch (_: Exception) { }
            try { port.rts = true } catch (_: Exception) { }
        } catch (e: Exception) {
            try { port.close() } catch (_: Exception) { }
            connection.close()
            throw IOException("could not open ${ref.label}: ${e.message}", e)
        }
        return UsbGnssConnection(UsbSerialIo(port))
    }
}
