package com.kshatralabs.gnssconsole.gnss

import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** WGS-84 -> local ENU, direct port of GNSS_Survey_Console/gnss_core/wgs84.py
 * (itself a standalone copy of Ground_EO_Tracker's geolocation.py math) -
 * kept numerically identical so a point surveyed from the phone lines up
 * with one surveyed from the web console or the CLI. */
object Wgs84 {
    private const val A = 6378137.0
    private const val E2 = 6.694379990141316e-3

    private fun rad(deg: Double) = deg * Math.PI / 180.0

    data class Vec3(val x: Double, val y: Double, val z: Double)

    fun geodeticToEcef(latDeg: Double, lonDeg: Double, altM: Double): Vec3 {
        val lat = rad(latDeg)
        val lon = rad(lonDeg)
        val n = A / sqrt(1 - E2 * sin(lat) * sin(lat))
        return Vec3(
            (n + altM) * cos(lat) * cos(lon),
            (n + altM) * cos(lat) * sin(lon),
            (n * (1 - E2) + altM) * sin(lat),
        )
    }

    /** Rows of the ECEF->ENU rotation matrix at (latDeg, lonDeg). */
    private fun enuRotationRows(latDeg: Double, lonDeg: Double): Array<DoubleArray> {
        val lat = rad(latDeg)
        val lon = rad(lonDeg)
        return arrayOf(
            doubleArrayOf(-sin(lon), cos(lon), 0.0),
            doubleArrayOf(-sin(lat) * cos(lon), -sin(lat) * sin(lon), cos(lat)),
            doubleArrayOf(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat)),
        )
    }

    class LocalFrame(val originLatDeg: Double, val originLonDeg: Double, val originAltM: Double) {
        private val originEcef = geodeticToEcef(originLatDeg, originLonDeg, originAltM)
        private val rotation = enuRotationRows(originLatDeg, originLonDeg)

        /** Returns (east, north, up) metres from the origin. */
        fun geodeticToEnu(latDeg: Double, lonDeg: Double, altM: Double): Triple<Double, Double, Double> {
            val ecef = geodeticToEcef(latDeg, lonDeg, altM)
            val dx = ecef.x - originEcef.x
            val dy = ecef.y - originEcef.y
            val dz = ecef.z - originEcef.z
            val d = doubleArrayOf(dx, dy, dz)
            val out = DoubleArray(3) { i -> rotation[i][0] * d[0] + rotation[i][1] * d[1] + rotation[i][2] * d[2] }
            return Triple(out[0], out[1], out[2])
        }
    }
}
