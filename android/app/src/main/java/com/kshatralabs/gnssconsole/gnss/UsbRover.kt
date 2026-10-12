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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val ACTION_USB_PERMISSION = "com.kshatralabs.gnssconsole.USB_PERMISSION"

data class UsbPortRef(val driver: UsbSerialDriver, val device: UsbDevice, val label: String)

/** rawDeviceCount: every USB device Android sees at all, matched driver or
 * not - lets the UI tell "nothing plugged in / OTG not working" (0) apart
 * from "something's plugged in but no serial driver recognizes it" (>0 but
 * candidates is empty), instead of both looking like the same empty list. */
data class UsbScanResult(val candidates: List<UsbPortRef>, val rawDeviceCount: Int)

/** USB-serial device discovery + permission + opening for the rover receiver
 * plugged into the phone's own USB-C/OTG port. */
object UsbRover {

    fun scan(context: Context): UsbScanResult {
        val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
        val raw = usbManager.deviceList.size
        val drivers = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager)
        return UsbScanResult(drivers.map(::toRef), raw)
    }

    fun listCandidates(context: Context): List<UsbPortRef> {
        val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
        val drivers = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager)
        return drivers.map(::toRef)
    }

    private fun toRef(d: UsbSerialDriver): UsbPortRef {
        val dev = d.device
        return UsbPortRef(d, dev, "${dev.deviceName} (${String.format("%04X:%04X", dev.vendorId, dev.productId)})")
    }

    /** Blocks the calling (background) thread until the user grants/denies
     * the system USB permission dialog, or timeoutMs elapses. Safe to call
     * from a plain background Thread - not a UI/coroutine context. */
    fun requestPermissionBlocking(context: Context, device: UsbDevice, timeoutMs: Long = 30_000): Boolean {
        val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
        if (usbManager.hasPermission(device)) return true

        val latch = CountDownLatch(1)
        var granted = false
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                if (intent.action == ACTION_USB_PERMISSION) {
                    granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
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
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
            val pi = PendingIntent.getBroadcast(context, 0, Intent(ACTION_USB_PERMISSION), flags)
            usbManager.requestPermission(device, pi)
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } finally {
            try { context.unregisterReceiver(receiver) } catch (_: Exception) { }
        }
        return granted
    }

    /** Opens the given driver's first port at the given baud. Throws on
     * failure (permission not granted, device disconnected, etc.) - callers
     * catch and surface the message. */
    fun open(context: Context, ref: UsbPortRef, baud: Int): UsbGnssConnection {
        val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
        val connection = usbManager.openDevice(ref.device)
            ?: throw IllegalStateException("could not open USB device ${ref.label} - permission denied or device gone")
        val port: UsbSerialPort = ref.driver.ports[0]
        port.open(connection)
        return UsbGnssConnection(port, baud)
    }
}
