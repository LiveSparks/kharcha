package dev.kharcha.sms

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class KharchaSmsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KharchaSms")

    AsyncFunction("listMessages") { senders: List<String>, since: Double ->
      val context = appContext.reactContext ?: throw IllegalStateException("Android context is unavailable")
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
        throw SecurityException("SMS permission has not been granted")
      }
      val allowed = senders.map { normalizeSender(it) }.filter { it.isNotEmpty() }.toSet()
      if (allowed.isEmpty()) return@AsyncFunction emptyList<Map<String, Any>>()

      val output = mutableListOf<Map<String, Any>>()
      val uri = Uri.parse("content://sms/inbox")
      val projection = arrayOf("address", "body", "date")
      context.contentResolver.query(uri, projection, "date >= ?", arrayOf(since.toLong().toString()), "date DESC")?.use { cursor ->
        val addressIndex = cursor.getColumnIndexOrThrow("address")
        val bodyIndex = cursor.getColumnIndexOrThrow("body")
        val dateIndex = cursor.getColumnIndexOrThrow("date")
        while (cursor.moveToNext()) {
          val sender = cursor.getString(addressIndex) ?: continue
          if (!matchesSender(sender, allowed)) continue
          val body = cursor.getString(bodyIndex) ?: continue
          if (body.length > 4000) continue
          output.add(mapOf("sender" to sender, "body" to body, "receivedAt" to cursor.getLong(dateIndex)))
        }
      }
      output
    }
  }

  private fun normalizeSender(value: String): String =
    value.trim().uppercase().replace(Regex("^[A-Z]{2}-"), "")

  // Carriers route one bank header as "HDFCBK", "VM-HDFCBK", "VMHDFCBKS": a two-letter
  // routing prefix and a channel letter attach to the registered ID, so a rule of five
  // or more characters matches when it sits inside the header, not only when it equals it.
  private fun matchesSender(sender: String, allowed: Set<String>): Boolean {
    val candidate = normalizeSender(sender)
    return allowed.any { rule -> candidate == rule || rule.length >= 5 && candidate.contains(rule) }
  }
}
