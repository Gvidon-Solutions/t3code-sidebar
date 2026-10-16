package expo.modules.t3voiceaudio

import android.media.AudioDeviceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceAudioRouteTest {
  private val earpiece = VoiceAudioDevice(1, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, "Phone")
  private val speaker = VoiceAudioDevice(2, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, "Phone")
  private val wired = VoiceAudioDevice(3, AudioDeviceInfo.TYPE_USB_HEADSET, "USB-C headset")
  private val bluetooth = VoiceAudioDevice(4, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, "Buds")
  private val leAudio = VoiceAudioDevice(5, AudioDeviceInfo.TYPE_BLE_HEADSET, "LE Buds")

  @Test
  fun bluetoothHeadsetWinsOverEverything() {
    val picked = pickVoiceAudioDevice(listOf(earpiece, speaker, wired, bluetooth), null)
    assertEquals(bluetooth, picked)
    assertEquals(VoiceAudioRoute.BLUETOOTH, picked?.route)
  }

  @Test
  fun leAudioHeadsetCountsAsBluetooth() {
    assertEquals(
      VoiceAudioRoute.BLUETOOTH,
      pickVoiceAudioDevice(listOf(earpiece, speaker, leAudio), null)?.route,
    )
  }

  @Test
  fun wiredHeadsetWinsOverThePhone() {
    assertEquals(wired, pickVoiceAudioDevice(listOf(earpiece, speaker, wired), null))
  }

  @Test
  fun phoneAloneTalksHandsFree() {
    assertEquals(speaker, pickVoiceAudioDevice(listOf(earpiece, speaker), null))
  }

  @Test
  fun ownersPickWinsWhileConnected() {
    val all = listOf(earpiece, speaker, bluetooth)
    assertEquals(speaker, pickVoiceAudioDevice(all, speaker.id))
    // The picked headset went away: back to the best remaining device.
    assertEquals(speaker, pickVoiceAudioDevice(listOf(earpiece, speaker), bluetooth.id))
  }

  @Test
  fun mediaOnlyBluetoothIsNotACallDevice() {
    // A2DP plays music but carries no microphone, so a call cannot use it.
    assertFalse(VoiceAudioRoute.isCallDevice(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP))
    assertNull(VoiceAudioRoute.chooseType(listOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP)))
    assertNull(pickVoiceAudioDevice(emptyList(), null))
  }
}
