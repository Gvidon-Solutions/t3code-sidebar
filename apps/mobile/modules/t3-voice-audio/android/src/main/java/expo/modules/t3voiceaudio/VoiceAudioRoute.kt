package expo.modules.t3voiceaudio

import android.media.AudioDeviceInfo

/** Where a voice conversation is heard and picked up. */
enum class VoiceAudioRoute(val id: String) {
  BLUETOOTH("bluetooth"),
  WIRED("wired"),
  SPEAKER("speaker"),
  EARPIECE("earpiece");

  companion object {
    // A headset the owner wears beats the phone; the phone talks hands-free.
    private val PRIORITY =
      listOf(
        AudioDeviceInfo.TYPE_BLE_HEADSET to BLUETOOTH,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO to BLUETOOTH,
        AudioDeviceInfo.TYPE_WIRED_HEADSET to WIRED,
        AudioDeviceInfo.TYPE_USB_HEADSET to WIRED,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES to WIRED,
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER to SPEAKER,
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE to EARPIECE,
      )

    /** Whether a call can use this device type at all (media-only Bluetooth cannot). */
    fun isCallDevice(type: Int): Boolean = PRIORITY.any { it.first == type }

    /** The device type to talk through among `types`, or null when none fits. */
    fun chooseType(types: Collection<Int>): Int? = PRIORITY.firstOrNull { it.first in types }?.first

    fun of(type: Int?): VoiceAudioRoute =
      PRIORITY.firstOrNull { it.first == type }?.second ?: SPEAKER
  }
}

/** One device a call can go through, as the owner picks it. */
data class VoiceAudioDevice(val id: Int, val type: Int, val name: String) {
  val route: VoiceAudioRoute
    get() = VoiceAudioRoute.of(type)
}

/**
 * The device to use: the owner's pick while it is still there, otherwise the
 * best one by priority. Null when nothing can carry a call.
 */
fun pickVoiceAudioDevice(
  devices: List<VoiceAudioDevice>,
  preferredId: Int?,
): VoiceAudioDevice? {
  devices.firstOrNull { it.id == preferredId }?.let { return it }
  val type = VoiceAudioRoute.chooseType(devices.map { it.type }) ?: return null
  return devices.firstOrNull { it.type == type }
}
