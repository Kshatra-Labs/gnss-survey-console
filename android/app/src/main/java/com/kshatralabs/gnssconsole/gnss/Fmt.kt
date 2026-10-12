package com.kshatralabs.gnssconsole.gnss

import java.util.Locale

/** Fixed-point formatting that doesn't depend on the phone's locale
 * ("0.4", never "0,4"), so status text and copied coordinates are stable. */
fun fmt(x: Double, digits: Int): String = String.format(Locale.US, "%.${digits}f", x)
