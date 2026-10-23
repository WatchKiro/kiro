package app.kiro.tv

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.SurfaceView
import android.view.ViewGroup
import android.webkit.WebView
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.text.CueGroup
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.SubtitleView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class AttachArgs {
  lateinit var onEvent: Channel
}

@InvokeArg
class LoadArgs {
  lateinit var url: String
  var startPosition: Double? = null
}

@InvokeArg
class PausedArgs {
  var paused: Boolean = false
}

@InvokeArg
class SeekArgs {
  var seconds: Double = 0.0
}

@InvokeArg
class VolumeArgs {
  var volume: Double = 1.0
}

@InvokeArg
class MutedArgs {
  var muted: Boolean = false
}

@InvokeArg
class SpeedArgs {
  var speed: Double = 1.0
}

@InvokeArg
class TrackArgs {
  var id: String? = null
}

/**
 * Media3 behind the webview, driven by the `player_*` commands in
 * src/commands/player_android.rs. The video is a SurfaceView under the
 * (transparent) webview, as libmpv's surface is under it on the desktop;
 * subtitles are drawn by Media3 between the two.
 *
 * Events go to the renderer's channel shaped like `media::model::PlayerEvent`.
 */
/** How often the time is sent while playing. */
private const val TICK_MS = 500L

@TauriPlugin
class PlayerPlugin(private val activity: Activity) : Plugin(activity) {
  private var webView: WebView? = null
  private var player: ExoPlayer? = null
  private var surface: SurfaceView? = null
  private var subtitles: SubtitleView? = null
  private var channel: Channel? = null
  private var loaded = false
  private var seeking = false
  private var volume = 1f
  private var muted = false
  private var lastBufferedSent = 0L
  private var lastBufferedStart = -1L
  private var lastBufferedEnd = -1L
  private var lastPosition = -1L
  private var lastDuration = -1L
  private val main = Handler(Looper.getMainLooper())
  private val ticker = object : Runnable {
    override fun run() {
      tick()
      main.postDelayed(this, TICK_MS)
    }
  }

  override fun load(webView: WebView) {
    this.webView = webView
  }

  private fun onMain(block: () -> Unit) = activity.runOnUiThread(block)

  @Command
  fun attach(invoke: Invoke) {
    val args = invoke.parseArgs(AttachArgs::class.java)
    onMain {
      channel = args.onEvent
      if (player == null) create()
      invoke.resolve(snapshot())
    }
  }

  @Command
  fun detach(invoke: Invoke) {
    onMain {
      destroy()
      invoke.resolve()
    }
  }

  @Command
  fun load(invoke: Invoke) {
    val args = invoke.parseArgs(LoadArgs::class.java)
    onMain {
      val player = player ?: return@onMain invoke.reject("The player is not ready", "PLAYER_NOT_ATTACHED")
      loaded = true
      lastPosition = -1
      lastDuration = -1
      lastBufferedStart = -1
      lastBufferedEnd = -1
      emitState("loading")
      player.setMediaItem(MediaItem.fromUri(args.url), ((args.startPosition ?: 0.0) * 1000).toLong())
      player.playWhenReady = true
      player.prepare()
      invoke.resolve()
    }
  }

  @Command
  fun setPaused(invoke: Invoke) {
    val args = invoke.parseArgs(PausedArgs::class.java)
    withPlayer(invoke) { it.playWhenReady = !args.paused }
  }

  @Command
  fun seek(invoke: Invoke) {
    val args = invoke.parseArgs(SeekArgs::class.java)
    withPlayer(invoke) {
      seeking = true
      emit("seekingChange", JSObject().put("seeking", true))
      it.seekTo((args.seconds * 1000).toLong())
    }
  }

  @Command
  fun setVolume(invoke: Invoke) {
    val args = invoke.parseArgs(VolumeArgs::class.java)
    withPlayer(invoke) {
      volume = args.volume.toFloat()
      it.volume = if (muted) 0f else volume
      emitVolume()
    }
  }

  @Command
  fun setMuted(invoke: Invoke) {
    val args = invoke.parseArgs(MutedArgs::class.java)
    withPlayer(invoke) {
      muted = args.muted
      it.volume = if (muted) 0f else volume
      emitVolume()
    }
  }

  @Command
  fun setSpeed(invoke: Invoke) {
    val args = invoke.parseArgs(SpeedArgs::class.java)
    withPlayer(invoke) { it.setPlaybackSpeed(args.speed.toFloat()) }
  }

  @Command
  fun stop(invoke: Invoke) {
    withPlayer(invoke) {
      it.stop()
      it.clearMediaItems()
      loaded = false
      emitState("idle")
    }
  }

  @Command
  fun selectAudioTrack(invoke: Invoke) {
    val args = invoke.parseArgs(TrackArgs::class.java)
    onMain {
      val player = player ?: return@onMain invoke.reject("The player is not ready", "PLAYER_NOT_ATTACHED")
      val (group, index) = findTrack(player, args.id) ?: return@onMain invoke.reject("That track is not available", "TRACK_NOT_FOUND")
      player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
        .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, index))
        .build()
      invoke.resolve()
    }
  }

  @Command
  fun selectSubtitleTrack(invoke: Invoke) {
    val args = invoke.parseArgs(TrackArgs::class.java)
    onMain {
      val player = player ?: return@onMain invoke.reject("The player is not ready", "PLAYER_NOT_ATTACHED")
      val builder = player.trackSelectionParameters.buildUpon()
      if (args.id == null) {
        builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
      } else {
        val (group, index) = findTrack(player, args.id) ?: return@onMain invoke.reject("That track is not available", "TRACK_NOT_FOUND")
        builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
          .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, index))
      }
      player.trackSelectionParameters = builder.build()
      invoke.resolve()
    }
  }

  @Command
  fun stats(invoke: Invoke) {
    onMain {
      val player = player
      val video = player?.videoFormat
      val audio = player?.audioFormat
      val counters = player?.videoDecoderCounters
      invoke.resolve(JSObject().apply {
        put("width", video?.width ?: JSONObject.NULL)
        put("height", video?.height ?: JSONObject.NULL)
        put("videoCodec", video?.sampleMimeType ?: JSONObject.NULL)
        put("hwdec", video?.codecs ?: JSONObject.NULL)
        put("primaries", video?.colorInfo?.colorSpace?.toString() ?: JSONObject.NULL)
        put("gamma", video?.colorInfo?.colorTransfer?.toString() ?: JSONObject.NULL)
        put("fps", video?.frameRate?.takeIf { it > 0 }?.toDouble() ?: JSONObject.NULL)
        put("droppedFrames", counters?.droppedBufferCount ?: 0)
        put("cacheSeconds", player?.let { (it.totalBufferedDuration / 1000.0) } ?: JSONObject.NULL)
        put("audioCodec", audio?.sampleMimeType ?: JSONObject.NULL)
        put("audioMode", if (audio == null) JSONObject.NULL else "decoded")
        put("audioOutput", "audiotrack")
        put("framesRendered", counters?.renderedOutputBufferCount ?: 0)
        put("samplePixel", "")
        put("contentsScale", 1)
      })
    }
  }

  private fun withPlayer(invoke: Invoke, block: (ExoPlayer) -> Unit) = onMain {
    val player = player ?: return@onMain invoke.reject("The player is not ready", "PLAYER_NOT_ATTACHED")
    block(player)
    invoke.resolve()
  }

  private fun create() {
    val webView = webView ?: return
    val root = webView.parent as ViewGroup
    val surface = SurfaceView(activity)
    val subtitles = SubtitleView(activity)
    root.addView(surface, 0, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    root.addView(subtitles, 1, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    webView.setBackgroundColor(Color.TRANSPARENT)

    val player = ExoPlayer.Builder(activity)
      .setAudioAttributes(
        AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
        /* handleAudioFocus = */ true,
      )
      .build()
    player.setVideoSurfaceView(surface)
    player.addListener(listener)
    this.player = player
    this.surface = surface
    this.subtitles = subtitles
    main.post(ticker)
  }

  private fun destroy() {
    main.removeCallbacks(ticker)
    player?.removeListener(listener)
    player?.release()
    player = null
    (surface?.parent as? ViewGroup)?.removeView(surface)
    (subtitles?.parent as? ViewGroup)?.removeView(subtitles)
    surface = null
    subtitles = null
    loaded = false
    webView?.setBackgroundColor(Color.parseColor("#08070d"))
  }

  private val listener = object : Player.Listener {
    override fun onPlaybackStateChanged(state: Int) {
      val player = player ?: return
      when (state) {
        Player.STATE_BUFFERING -> emit("buffering", JSObject().put("buffering", true))
        Player.STATE_READY -> {
          emit("buffering", JSObject().put("buffering", false))
          if (seeking) {
            seeking = false
            emit("seekingChange", JSObject().put("seeking", false))
            sendTime(player, force = true)
          }
          emitState(if (player.playWhenReady) "playing" else "paused")
        }
        Player.STATE_ENDED -> {
          emitState("ended")
          emit("ended", JSObject())
        }
        Player.STATE_IDLE -> {}
      }
      surface?.keepScreenOn = state != Player.STATE_IDLE && state != Player.STATE_ENDED
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
      val player = player ?: return
      // Paused: where it stopped, exactly.
      if (!playWhenReady) sendTime(player, force = true)
      if (player.playbackState == Player.STATE_READY) emitState(if (playWhenReady) "playing" else "paused")
    }

    override fun onTracksChanged(tracks: Tracks) {
      emit("tracksChange", JSObject().put("tracks", trackList(tracks)))
      emit("trackSelect", JSObject().put("kind", "audio").put("trackId", selectedId(tracks, C.TRACK_TYPE_AUDIO) ?: JSONObject.NULL))
      emit("trackSelect", JSObject().put("kind", "subtitle").put("trackId", selectedId(tracks, C.TRACK_TYPE_TEXT) ?: JSONObject.NULL))
    }

    override fun onCues(cueGroup: CueGroup) {
      subtitles?.setCues(cueGroup.cues)
    }

    override fun onPlayerError(error: PlaybackException) {
      val code = when (error.errorCode) {
        in 2000..2999 -> "NETWORK"
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
        PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES -> "UNSUPPORTED_SOURCE"
        in 3000..4999 -> "DECODE"
        else -> "UNKNOWN"
      }
      emitState("error")
      emit("error", JSObject().put("error", JSObject()
        .put("code", code)
        .put("message", error.errorCodeName)
        .put("recoverable", false)))
    }
  }

  /**
   * Every event re-renders the player page, which is slow on a TV's CPU, so
   * nothing is sent that the page wouldn't show: the time twice a second, and
   * only when it moved (not while paused); what's buffered at most once a
   * second, when it grew by a second or a seek moved it.
   */
  private fun tick() {
    val player = player ?: return
    if (!loaded) return
    sendTime(player)
    val now = System.currentTimeMillis()
    val start = player.currentPosition
    val end = player.bufferedPosition
    val moved = kotlin.math.abs(end - lastBufferedEnd) >= 1000 || kotlin.math.abs(start - lastBufferedStart) >= 5000
    if (moved && now - lastBufferedSent >= 1000) {
      lastBufferedSent = now
      lastBufferedStart = start
      lastBufferedEnd = end
      emit("bufferedChange", JSObject().put("ranges", bufferedRanges(player)))
    }
  }

  private fun sendTime(player: ExoPlayer, force: Boolean = false) {
    if (!loaded) return
    val position = player.currentPosition
    val duration = player.duration
    if (!force && position == lastPosition && duration == lastDuration) return
    lastPosition = position
    lastDuration = duration
    emit("timeUpdate", JSObject().put("position", position / 1000.0).put("duration", duration(player) ?: JSONObject.NULL))
  }

  private fun duration(player: ExoPlayer): Double? =
    player.duration.takeIf { it != C.TIME_UNSET }?.let { it / 1000.0 }

  private fun bufferedRanges(player: ExoPlayer) = JSArray().apply {
    if (loaded) put(JSObject().put("start", player.currentPosition / 1000.0).put("end", player.bufferedPosition / 1000.0))
  }

  private fun snapshot(): JSObject {
    val player = player
    val tracks = player?.currentTracks ?: Tracks.EMPTY
    return JSObject().apply {
      put("state", currentState())
      put("position", (player?.currentPosition ?: 0) / 1000.0)
      put("duration", player?.let { duration(it) } ?: JSONObject.NULL)
      put("buffering", player?.playbackState == Player.STATE_BUFFERING)
      put("tracks", trackList(tracks))
      put("chapters", JSArray())
      put("buffered", player?.let { bufferedRanges(it) } ?: JSArray())
      put("seeking", seeking)
      put("audioTrackId", selectedId(tracks, C.TRACK_TYPE_AUDIO) ?: JSONObject.NULL)
      put("subtitleTrackId", selectedId(tracks, C.TRACK_TYPE_TEXT) ?: JSONObject.NULL)
      put("volume", volume.toDouble())
      put("muted", muted)
      put("maxVolume", 1.0)
      put("subtitleDelay", 0.0)
      put("audioDelay", 0.0)
      put("speed", (player?.playbackParameters?.speed ?: 1f).toDouble())
    }
  }

  private fun currentState(): String {
    val player = player ?: return "idle"
    if (!loaded) return "idle"
    return when (player.playbackState) {
      Player.STATE_READY -> if (player.playWhenReady) "playing" else "paused"
      Player.STATE_ENDED -> "ended"
      Player.STATE_BUFFERING -> if (player.duration == C.TIME_UNSET) "loading" else if (player.playWhenReady) "playing" else "paused"
      else -> if (player.playerError != null) "error" else "loading"
    }
  }

  private fun kindOf(type: Int) = when (type) {
    C.TRACK_TYPE_VIDEO -> "video"
    C.TRACK_TYPE_AUDIO -> "audio"
    C.TRACK_TYPE_TEXT -> "subtitle"
    else -> null
  }

  private fun trackList(tracks: Tracks) = JSArray().apply {
    tracks.groups.forEachIndexed { groupIndex, group ->
      val kind = kindOf(group.type) ?: return@forEachIndexed
      for (index in 0 until group.length) {
        if (!group.isTrackSupported(index)) continue
        val format = group.getTrackFormat(index)
        put(JSObject().apply {
          put("id", "$groupIndex.$index")
          put("kind", kind)
          format.label?.let { put("label", it) }
          format.language?.takeIf { it != C.LANGUAGE_UNDETERMINED }?.let { put("language", it) }
          (format.codecs ?: format.sampleMimeType)?.let { put("codec", it) }
          if (format.channelCount > 0) put("channels", format.channelCount)
          put("isDefault", format.selectionFlags and C.SELECTION_FLAG_DEFAULT != 0)
          put("isForced", format.selectionFlags and C.SELECTION_FLAG_FORCED != 0)
        })
      }
    }
  }

  private fun selectedId(tracks: Tracks, type: Int): String? {
    tracks.groups.forEachIndexed { groupIndex, group ->
      if (group.type != type) return@forEachIndexed
      for (index in 0 until group.length) if (group.isTrackSelected(index)) return "$groupIndex.$index"
    }
    return null
  }

  private fun findTrack(player: ExoPlayer, id: String?): Pair<Tracks.Group, Int>? {
    val parts = id?.split('.')?.mapNotNull { it.toIntOrNull() } ?: return null
    if (parts.size != 2) return null
    val group = player.currentTracks.groups.getOrNull(parts[0]) ?: return null
    return if (parts[1] in 0 until group.length) group to parts[1] else null
  }

  private fun emitState(state: String) = emit("stateChange", JSObject().put("state", state))

  private fun emitVolume() =
    emit("volumeChange", JSObject().put("volume", volume.toDouble()).put("muted", muted))

  private fun emit(event: String, payload: JSObject) {
    // Debug builds log events (not the per-tick ones) for `adb logcat -s KiroPlayer`.
    if (BuildConfig.DEBUG && event != "timeUpdate" && event != "bufferedChange") Log.d("KiroPlayer", "$event $payload")
    channel?.send(JSObject().put("event", event).put("payload", payload))
  }
}
