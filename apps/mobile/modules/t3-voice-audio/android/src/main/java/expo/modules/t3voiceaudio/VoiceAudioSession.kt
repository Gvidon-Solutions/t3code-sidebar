package expo.modules.t3voiceaudio

import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler

/**
 * Routes one voice conversation. WebRTC plays and records as a voice call
 * but leaves routing to the app, so this puts the phone in communication mode
 * and picks the call device: the owner's pick, else a Bluetooth headset, a
 * wired one, then the speaker. It re-picks whenever a device comes or goes,
 * and restores the previous mode when the conversation ends.
 */
internal class VoiceAudioSession(
  private val audioManager: AudioManager,
  private val handler: Handler,
  private val onChange: () -> Unit,
) {
  private var previousMode = AudioManager.MODE_NORMAL
  private var usingSco = false
  private var preferredId: Int? = null
  var current: VoiceAudioDevice? = null
    private set
  var devices: List<VoiceAudioDevice> = emptyList()
    private set

  private val deviceCallback =
    object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = apply()

      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = apply()
    }

  fun start() {
    previousMode = audioManager.mode
    audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    apply()
    audioManager.registerAudioDeviceCallback(deviceCallback, handler)
  }

  /** Uses this device while it stays connected; it falls back to priority once it goes. */
  fun select(id: Int) {
    preferredId = id
    apply()
  }

  @Suppress("DEPRECATION")
  fun stop() {
    audioManager.unregisterAudioDeviceCallback(deviceCallback)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audioManager.clearCommunicationDevice()
    } else {
      stopSco()
      audioManager.isSpeakerphoneOn = false
    }
    audioManager.mode =
      if (previousMode == AudioManager.MODE_IN_COMMUNICATION) AudioManager.MODE_NORMAL
      else previousMode
    current = null
    devices = emptyList()
  }

  private fun apply() {
    val available = availableDevices()
    val next = pickVoiceAudioDevice(available, preferredId)
    if (next != null) route(next)
    if (next != current || available != devices) {
      current = next
      devices = available
      onChange()
    }
  }

  private fun availableDevices(): List<VoiceAudioDevice> {
    val infos =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audioManager.availableCommunicationDevices
      else audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
    return infos
      .filter { VoiceAudioRoute.isCallDevice(it.type) }
      .map { VoiceAudioDevice(it.id, it.type, it.productName?.toString().orEmpty()) }
      // Before Android 12 a headset can show up once per profile; one row each.
      .distinctBy { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) it.id else it.type }
  }

  private fun route(device: VoiceAudioDevice) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val info = audioManager.availableCommunicationDevices.firstOrNull { it.id == device.id }
      if (info != null && audioManager.communicationDevice?.id != info.id) {
        audioManager.setCommunicationDevice(info)
      }
    } else {
      routeLegacy(device.route)
    }
  }

  @Suppress("DEPRECATION")
  private fun routeLegacy(route: VoiceAudioRoute) {
    if (route == VoiceAudioRoute.BLUETOOTH) {
      if (!usingSco) {
        audioManager.startBluetoothSco()
        audioManager.isBluetoothScoOn = true
        usingSco = true
      }
      audioManager.isSpeakerphoneOn = false
    } else {
      stopSco()
      audioManager.isSpeakerphoneOn = route == VoiceAudioRoute.SPEAKER
    }
  }

  @Suppress("DEPRECATION")
  private fun stopSco() {
    if (!usingSco) return
    audioManager.isBluetoothScoOn = false
    audioManager.stopBluetoothSco()
    usingSco = false
  }
}
