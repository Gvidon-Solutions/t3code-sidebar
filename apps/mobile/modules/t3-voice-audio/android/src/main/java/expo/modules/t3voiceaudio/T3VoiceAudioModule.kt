package expo.modules.t3voiceaudio

import android.content.Context
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Fork: call-style audio routing for voice conversations (see VoiceAudioSession). */
class T3VoiceAudioModule : Module() {
  private var session: VoiceAudioSession? = null

  private fun describe(device: VoiceAudioDevice) =
    mapOf(
      "id" to device.id,
      "route" to device.route.id,
      "name" to device.name,
      "selected" to (device.id == session?.current?.id),
    )

  private fun state(): Map<String, Any?> {
    val current = session?.current
    return mapOf(
      "route" to current?.route?.id,
      "devices" to (session?.devices ?: emptyList()).map(::describe),
    )
  }

  override fun definition() = ModuleDefinition {
    Name("T3VoiceAudio")

    Events("onChange")

    /** Starts routing and returns the routing state. A second start re-routes from scratch. */
    Function("start") {
      val context = appContext.reactContext ?: return@Function state()
      val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      session?.stop()
      val next =
        VoiceAudioSession(audioManager, Handler(Looper.getMainLooper())) {
          sendEvent("onChange", state())
        }
      session = next
      next.start()
      state()
    }

    /** Talks through this device (an id from the state's devices) while it stays connected. */
    Function("select") { id: Int ->
      session?.select(id)
      state()
    }

    Function("getState") { state() }

    Function("stop") {
      session?.stop()
      session = null
    }

    OnDestroy {
      session?.stop()
      session = null
    }
  }
}
