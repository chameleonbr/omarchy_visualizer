// The cava process, the guards that decide whether it runs at all, and the
// bridge that mirrors what the bar draws onto WLED lights.
//
// One per shell session (kind: "service"), so a machine with three monitors
// runs one cava rather than three.

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Pipewire
import Quickshell.Services.UPower
import "Visualizer.js" as Vis
import "I18n.js" as I18n

Item {
  id: root

  // ------------------------------------------------------------ settings

  property int barCount: 14
  property int framerate: 30
  property int smoothing: 60
  property int floorLevel: 3
  property bool pauseOnBattery: true
  property bool pauseWhenSilent: true
  property real peakFall: 1.5
  property string input: "system"
  property string micSource: ""
  property string sinkMonitor: ""

  property bool wledEnabled: false
  property int wledRateHz: 10
  property string wledDevices: ""
  property bool wledRestore: true
  property int wledSpan: 40
  property string wledKnob: ""

  // ------------------------------------------------------------ language
  //
  // Bumped whenever the language changes, so every binding that renders a
  // translated string has something to depend on. `I18n.t()` is a function
  // call: nothing about it tells QML to re-evaluate when the table underneath
  // it is swapped.
  property int languageEpoch: 0

  readonly property string locale: Quickshell.env("LC_ALL")
    || Quickshell.env("LC_MESSAGES") || Quickshell.env("LANG") || ""

  function applyLanguage(name) {
    var wanted = name === "auto" ? I18n.detectLanguage(locale) : name
    if (I18n.language() === wanted) return
    I18n.setLanguage(wanted)
    languageEpoch++
  }

  // ------------------------------------------------------------ settings
  //
  // Two sources: the widget's entry in shell.json seeds the defaults, and the
  // panel's own file wins over it. The bar host has no API for a widget to
  // write its shell.json entry back, and a plugin editing that file races the
  // shell whenever someone drags the bar around.

  readonly property string settingsPath:
    Quickshell.env("HOME") + "/.config/omarchy/visualizer.json"

  property var seed: ({})
  property var fileSettings: ({})
  readonly property var merged: Vis.mergeSettings(seed, fileSettings)

  function value(key) {
    return merged[key]
  }

  SizedFile {
    id: settingsFile
    path: root.settingsPath
    onFileLoaded: function(text) {
      root.fileSettings = Vis.parseSettingsFile(text) || ({})
    }
  }

  // Written whole, from the merge, so a file that only ever held one key does
  // not quietly reset everything else on the next save.
  function save(patch) {
    var next = Vis.mergeSettings(merged, patch)
    fileSettings = next
    settingsFile.setText(Vis.serializeSettings(next))
    applySettings()
  }

  onMergedChanged: applySettings()

  function applySettings() {
    configure(merged)
  }

  function configure(settings) {
    applyLanguage(String(settings.language || "auto"))

    var nextBars = Math.max(6, Math.min(24, Number(settings.barCount) || 14))
    var nextRate = Math.max(10, Math.min(60, Number(settings.framerate) || 30))
    // cava is told these at startup, so changing them means restarting it.
    var restart = nextBars !== barCount || nextRate !== framerate

    barCount = nextBars
    framerate = nextRate
    smoothing = Math.max(0, Math.min(95, Number(settings.smoothing) || 60))
    floorLevel = Math.max(0, Math.min(20, Number(settings.floor) || 0))
    pauseOnBattery = settings.pauseOnBattery !== false
    pauseWhenSilent = settings.pauseWhenSilent !== false
    peakFall = Math.max(0.2, Math.min(10, Number(settings.peakFall) || 1.5))

    var wantedInput = String(settings.input || "system")
    if (!Vis.isInput(wantedInput)) wantedInput = "system"
    if (wantedInput !== input) {
      input = wantedInput
      restart = true
      applyInput()
    }

    // Not part of `restart`: the microphone is read from the config cava is
    // given, and onActiveMicChanged rewrites and restarts it when it resolves.
    micDevice = String(settings.micDevice || "")

    wledEnabled = settings.wledEnabled === true
    var wantedStyle = String(settings.wledStyle || "spectrum")
    wledStyle = Vis.WLED_STYLES.indexOf(wantedStyle) >= 0 ? wantedStyle : "spectrum"
    wledRateHz = Math.max(1, Math.min(20, Number(settings.wledRateHz) || 10))
    wledDevices = String(settings.wledDevices || "")
    wledRestore = settings.wledRestore !== false
    wledSpan = Math.max(0, Math.min(100, Number(settings.wledSpan) || 0))
    wledKnob = String(settings.wledKnob || "")

    if (restart) writeConfig()
  }

  // -------------------------------------------------------------- state

  property var frame: []
  property var peaks: []
  property int frameNumber: 0
  // -1 until the check answers: "not installed" and "not asked yet" are
  // different, and only one of them is worth telling the user about.
  property int installed: -1
  property int visibleWidgets: 0

  readonly property bool playing:
    Vis.isPlaying(Pipewire.nodes ? Pipewire.nodes.values : [])

  readonly property var guardState: ({
    installed: installed === 1,
    configReady: configReady,
    visible: visibleWidgets > 0,
    playing: playing,
    onBattery: UPower.onBattery,
    pauseWhenSilent: pauseWhenSilent,
    pauseOnBattery: pauseOnBattery
  })

  readonly property bool running: Vis.shouldRun(guardState)
  readonly property string idleReason: Vis.idleReason(guardState)

  function setWidgetVisible(visible) {
    visibleWidgets = Math.max(0, visibleWidgets + (visible ? 1 : -1))
  }

  // ------------------------------------------------------------- cava

  // No `/tmp` fallback: see Vis.configDir. An empty path means there is
  // nowhere private to write, and the plugin stays off.
  readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR") || ""
  readonly property string homeDir: Quickshell.env("HOME") || ""
  readonly property string configDirPath: Vis.configDir(runtimeDir, homeDir)
  readonly property string configFilePath: Vis.configPath(runtimeDir, homeDir)

  // null until the directory has been made and checked; false if it could not
  // be. `shouldRun` reads it, so cava never starts without its own config.
  property var configReady: null

  Process {
    id: installCheck
    command: Vis.cavaCheckCommand()
    running: true
    stdout: SplitParser {
      onRead: function(line) { root.installed = line.trim() === "yes" ? 1 : 0 }
    }
  }

  // Written under XDG_RUNTIME_DIR, never to ~/.config/cava: that file belongs
  // to whoever runs cava in a terminal, and a bar widget has no business
  // rewriting it.
  FileView {
    id: configFile
    path: root.configFilePath
    // Written, never read: nothing here ever calls text().
    preload: false
  }

  // FileView cannot create the directory, and the first write happens before
  // anything else has had a reason to make it. It is also where the directory
  // is made 0700 and checked for being ours rather than something left in the
  // way — see Vis.configDirCommand.
  Process {
    id: makeDir
    command: Vis.configDirCommand(root.configDirPath)
    running: root.configDirPath !== ""
    onExited: function(code) {
      root.configReady = code === 0
      if (root.configReady) root.writeConfig()
    }
  }

  function writeConfig() {
    if (makeDir.running || configReady !== true) return
    configFile.setText(Vis.cavaConfig({
      barCount: barCount, framerate: framerate,
      input: input, micSource: activeMic
    }))
    if (cava.running) restartCava()
  }

  function restartCava() {
    cava.running = false
    restartTimer.restart()
  }

  Timer {
    id: restartTimer
    interval: 120
    onTriggered: if (root.running) cava.running = true
  }

  Process {
    id: cava
    command: Vis.cavaCommand(root.configFilePath)

    stdout: SplitParser {
      onRead: function(line) {
        var next = Vis.parseFrame(line, root.barCount)
        if (!next) return

        root.frameNumber++
        // autosens spikes while it calibrates; a third of a second of silence
        // beats a lurch every time the widget wakes up.
        if (Vis.isWarmup(root.frameNumber)) return

        var floored = Vis.applyFloor(next, root.floorLevel)
        var smoothed = Vis.smoothFrame(root.frame, floored, root.smoothing)
        // Peaks track the smoothed frame, not the raw one: a marker that
        // chased every spike would never sit still long enough to read.
        var settled = Vis.updatePeaks(root.peaks, smoothed, root.peakFall)

        // Silence over silence is not a new frame. The transition into it
        // still is — all four have to be quiet, or the bars would freeze
        // halfway down and the peaks would hang where they were.
        if (Vis.isSilentFrame(smoothed) && Vis.isSilentFrame(root.frame)
          && Vis.isSilentFrame(settled) && Vis.isSilentFrame(root.peaks)) return

        root.frame = smoothed
        root.peaks = settled
        root.pushToWled()
      }
    }
  }

  // The process is killed, not paused. A paused cava still holds the audio
  // capture open, which is most of what it costs.
  onRunningChanged: {
    if (running) {
      frameNumber = 0
      cava.running = true
    } else {
      cava.running = false
      frame = []
      peaks = []
      restoreWled()
    }
  }


  // ------------------------------------------------------- audio input
  //
  // "system" is cava's own default and needs no lookup. "mic" needs the name of
  // the default source. "both" needs a device that does not exist yet, so the
  // plugin builds one and takes it away again — leaving a stray sink in
  // someone's audio graph is a mess that outlives the widget.

  Process {
    id: sinkQuery
    command: Vis.defaultSinkCommand()
    stdout: SplitParser {
      onRead: function(line) {
        var name = line.trim()
        if (!name) return
        // Its own monitor is a feedback loop, so the last real sink is kept
        // instead. Not building the mix is the safe way to be wrong here.
        if (Vis.isMixMonitor(name)) return
        root.sinkMonitor = name + ".monitor"
      }
    }
  }

  // What the settings pane chose, by short label; empty means the system
  // default. The visualizer wants a microphone that has signal on it, which is
  // not always the one calls should use — a bluetooth headset in A2DP offers an
  // input node that is digital silence.
  property string micDevice: ""
  property var micNames: []

  readonly property string activeMic:
    Vis.resolveSource(root.micDevice, root.micNames) || root.micSource

  Process {
    id: sourceList
    command: Vis.sourceListCommand()
    stdout: StdioCollector { id: sourceListText }
    onExited: function(code) {
      if (code === 0) root.micNames = Vis.parseSourceList(sourceListText.text)
    }
  }

  Process {
    id: sourceQuery
    command: Vis.defaultSourceCommand()
    stdout: SplitParser {
      onRead: function(line) { root.micSource = line.trim() }
    }
  }

  // The device names arrive from pactl a moment after the setting changes, and
  // the config was written before they did — so "mic" wrote `source = ` and
  // cava fell back to its own default, which is the system audio. The config is
  // rewritten when the name lands, which is the only moment it can be correct.
  //
  // A device name that changed is a device that moved, and what that costs
  // depends on the input. `auto` is resolved once, inside a cava that is
  // already running. The mix's loopback is pinned once, inside a module that is
  // already loaded. Neither notices a headset arriving on its own.
  onActiveMicChanged: {
    if (!activeMic) return
    if (input === "mic") writeConfig()
    else if (input === "both") rebuildMix()
  }

  onSinkMonitorChanged: {
    if (!sinkMonitor) return
    if (input === "both") rebuildMix()
    else if (input === "system" && cava.running) restartCava()
  }

  // `pactl subscribe` is not the answer: switching the default sink emits no
  // event for it at all. So the question is asked again, at a rate a person
  // plugging in headphones would not notice.
  Timer {
    id: deviceWatch
    running: root.running
    interval: 3000
    repeat: true
    onTriggered: {
      sinkQuery.running = false
      sinkQuery.running = true
      if (root.input !== "system") {
        sourceQuery.running = false
        sourceQuery.running = true
        // Asked with them: a microphone appears and disappears the same way a
        // sink does, and the settings pane offers whatever is there now.
        sourceList.running = false
        sourceList.running = true
      }
    }
  }

  Process { id: mixProcess }
  property var mixQueue: []
  property bool mixBuilt: false

  function applyInput() {
    if (input === "system") {
      teardownMix()
      writeConfig()
      return
    }

    // Re-asked every time rather than cached: the default source changes when
    // someone plugs in a headset, and a name from ten minutes ago is a config
    // that silently reads the wrong device.
    sourceQuery.running = false
    sourceQuery.running = true
    sourceList.running = true
    if (input === "both") {
      sinkQuery.running = true
      buildTimer.restart()
    }
  }

  // Given a moment for the two queries to answer. Building the mix against an
  // empty device name would load a loopback from nothing.
  Timer {
    id: buildTimer
    interval: 400
    onTriggered: root.buildMix()
  }

  function buildMix() {
    if (mixBuilt || !sinkMonitor || !activeMic) return
    mixBuilt = true
    // Appended, not assigned: a teardown queued by rebuildMix has to run first,
    // and replacing the queue would drop it and load a second set of modules.
    mixQueue = mixQueue.concat(Vis.mixSetupCommands(sinkMonitor, activeMic))
    pumpMix()
  }

  // Tear the mix down and put it back around the device that is default now.
  // Both halves go through the same queue, so the unload cannot land after the
  // load it was supposed to precede.
  function rebuildMix() {
    if (mixBuilt) {
      mixBuilt = false
      mixQueue = mixQueue.concat([Vis.mixTeardownCommand()])
      pumpMix()
    }
    buildTimer.restart()
  }

  function pumpMix() {
    if (mixProcess.running || mixQueue.length === 0) return
    var next = mixQueue.shift()
    mixProcess.command = next
    mixProcess.running = true
  }

  Connections {
    target: mixProcess
    function onExited() {
      root.pumpMix()
      // The null sink cava was capturing has just been destroyed and remade, so
      // the capture it still holds is on a device that no longer exists.
      if (!mixProcess.running && root.mixQueue.length === 0
        && root.mixBuilt && cava.running) root.restartCava()
    }
  }

  function teardownMix() {
    if (!mixBuilt) return
    mixBuilt = false
    mixQueue = []
    Quickshell.execDetached(Vis.mixTeardownCommand())
  }

  // The mix is torn down when the widget stops for any reason, not only when
  // the setting changes: a shell restart with it still loaded would leave the
  // sink behind for good.
  Component.onDestruction: teardownMix()

  // ------------------------------------------------------------- WLED
  //
  // The differentiator, and the half with real hardware on the other end.

  readonly property string wledConfigPath:
    Quickshell.env("HOME") + "/.config/omarchy/wled.json"

  // Read, never written: the WLED plugin owns this file.
  SizedFile {
    id: wledConfig
    path: root.wledConfigPath
    onFileLoaded: function(text) { root.wledParsed = Vis.parseConfigFile(text) }
  }

  property var wledParsed: null

  // The lights the WLED plugin knows about, for the settings pane to offer.
  readonly property var wledNames: Vis.wledDeviceNames(wledParsed)

  readonly property var wledHosts: {
    if (!wledEnabled) return []
    return Vis.wledHostList(wledParsed, Vis.wledWantedNames(wledDevices))
  }

  property string wledStyle: "spectrum"

  // Which effect each host is running, and the knobs that effect declares
  // with the values the light had when it started running it. Only `params`
  // fills these; the other styles never look at them.
  property var wledEffects: ({})
  // Everything the effect declares, and the subset the spectrum drives. Both,
  // because the pane offers the first and only the second is sent.
  property var wledDeclared: ({})
  property var wledKnobs: ({})

  // The names the pane puts in the `wledKnob` row. One light's worth: with two
  // panels running different effects there is no single answer, and the first
  // is a better guess than a union nobody's light actually has.
  readonly property var wledKnobLabels: {
    for (var host in wledDeclared) return Vis.wledKnobLabels(wledDeclared[host])
    return []
  }

  // The choice can change without the effect changing, so the drive list is
  // rebuilt from what is already known rather than waiting for another probe.
  onWledKnobChanged: {
    var next = {}
    for (var host in wledDeclared) {
      next[host] = Vis.wledDriveKnobs(wledDeclared[host], wledKnob)
    }
    wledKnobs = next
  }

  // What each light is: a strip, or a panel and how big. `bars` is the only
  // style that needs it, and it is the only style a strip cannot have.
  property var wledShapes: ({})

  // What segment 0 was doing before this plugin touched it, by host. Nothing
  // binds to it, so it is mutated rather than replaced.
  property var wledBaselines: ({})

  onWledHostsChanged: askWledSizes()
  onWledEnabledChanged: if (wledEnabled) askWledSizes()
  // Leaving `params` has to put the knobs back before the next style starts
  // writing over the same segment, and it invalidates the baseline: coming
  // back re-probes rather than swinging around numbers from a previous song.
  onWledStyleChanged: {
    restoreWled()
    askWledSizes()
  }

  function askWledSizes() {
    if (!wledEnabled || wledHosts.length === 0) return
    wledInfo.running = false
    wledInfo.command = Vis.wledInfoCommand(wledHosts)
    wledInfo.running = true
  }

  // The effect is changed on the light, from its own web UI or a keybind, and
  // nothing tells the shell. Re-asking is one 2KB request per light and it is
  // the only way `params` ever notices. Only while that style is on: the other
  // three ask once and are right for as long as the strip is the same length.
  Timer {
    interval: 10000
    repeat: true
    running: root.wledEnabled && root.wledStyle === "params" && root.running
    onTriggered: root.askWledSizes()
  }

  Process {
    id: wledInfo
    command: Vis.wledInfoCommand([])
    stdout: SplitParser {
      onRead: function(line) {
        var found = Vis.parseWledInfo(line)
        if (!found) return
        var shapes = {}
        for (var seen in root.wledShapes) shapes[seen] = root.wledShapes[seen]
        shapes[found.host] = {
          matrix: found.matrix,
          width: found.width,
          height: found.height,
          canStream: Vis.wledCanStream(found, found.seg),
          start: Vis.wledStreamStart(found, found.seg)
        }
        root.wledShapes = shapes

        // Recorded once, and only while the bridge has not written to this
        // light yet: probe again mid-song and what comes back is what the
        // bridge itself put there, so the "before" it saves is its own output.
        if (found.baseline && !root.wledBaselines[found.host]) {
          root.wledBaselines[found.host] = found.baseline
        }

        if (root.wledStyle !== "params") return
        // The values in this answer are only a baseline while they are still
        // the user's. Once this style is driving the knobs, re-reading them
        // reads back what the bridge itself wrote a frame ago, and the centre
        // it swings around walks off with the music. A changed effect is the
        // one moment the light's own numbers are trustworthy again, because
        // WLED resets the sliders to that effect's defaults.
        if (root.wledEffects[found.host] === found.fx) return
        var effects = {}
        for (var known in root.wledEffects) effects[known] = root.wledEffects[known]
        effects[found.host] = found.fx
        root.wledEffects = effects
        root.wledSegs[found.host] = found.seg
        root.askWledKnobs()
      }
    }
  }

  // Segment 0 as the light last reported it, kept only long enough to pair
  // with the slider layout that arrives separately.
  property var wledSegs: ({})

  function askWledKnobs() {
    if (wledHosts.length === 0) return
    wledFxData.running = false
    wledFxData.command = Vis.wledFxDataCommand(wledHosts)
    wledFxData.running = true
  }

  Process {
    id: wledFxData
    command: Vis.wledFxDataCommand([])
    stdout: SplitParser {
      onRead: function(line) {
        var found = Vis.parseWledFxData(line, root.wledEffects)
        if (!found) return
        var declared = Vis.wledDeclaredKnobs(found.meta, root.wledSegs[found.host])

        var all = {}
        for (var seen in root.wledDeclared) all[seen] = root.wledDeclared[seen]
        all[found.host] = declared
        root.wledDeclared = all

        var next = {}
        for (var host in root.wledKnobs) next[host] = root.wledKnobs[host]
        next[found.host] = Vis.wledDriveKnobs(declared, root.wledKnob)
        root.wledKnobs = next
      }
    }
  }

  // One long-lived process for every panel: a frame is a line on its stdin,
  // and spawning something per frame would cost more in startup than the
  // frame costs to send. It runs only while there is a panel to paint.
  readonly property string streamScript:
    decodeURIComponent(String(Qt.resolvedUrl("bin/omarchy-visualizer-stream"))
      .replace(/^file:\/\//, ""))

  Process {
    id: wledStream
    command: [root.streamScript]
    stdinEnabled: true
  }

  // Driven, not bound. A `Process` that exits writes `running` itself, and
  // that write breaks any binding on it — so one crash, or a missing python3,
  // would take `bars` out for the rest of the session with nothing said. The
  // frame loop starts it back up instead, which costs a comparison per frame
  // and makes the failure last one frame rather than one session.
  readonly property bool wantsStream:
    wledEnabled && Vis.isWledPanelStyle(wledStyle) && running

  onWantsStreamChanged: {
    if (wantsStream) wledStream.running = true
    else wledStream.running = false
  }

  property real lastSentMs: 0
  // Per host: two panels of different sizes draw at different rates, and one
  // clock for both would pace them by whichever is slower.
  property var lastStreamedMs: ({})
  property bool wledTouched: false

  function pushToWled() {
    if (!wledEnabled || wledHosts.length === 0 || frame.length === 0) return

    var now = Date.now()
    // The rate is an HTTP ceiling, not a taste. A light answers a POST in
    // something like a tenth of a second and stops answering at all well below
    // the frame rate, so frames above the cap are dropped rather than queued —
    // a queue would only move the backlog to the end of the song.
    //
    // A realtime packet has none of that: nothing waits for a reply, and the
    // same panel that managed six frames a second over JSON took a thousand
    // over UDP. Holding `bars` to the JSON cap threw away half of what cava
    // produced and the panel moved in steps.
    var httpDue = Vis.shouldSendToWled(lastSentMs, now, wledRateHz)
    var httpSent = false

    var energy = Vis.frameEnergy(frame)

    for (var i = 0; i < wledHosts.length; i++) {
      var host = wledHosts[i]

      if (Vis.isWledPanelStyle(wledStyle)) {
        var shape = wledShapes[host]
        if (shape && shape.canStream) {
          // Restarted here rather than from a timer: this is the only place
          // that knows a frame is waiting for it.
          if (!wledStream.running) { wledStream.running = true; continue }

          // Paced by the panel, not by the JSON cap and not by cava. Its own
          // fps is the only number here that describes the thing being fed.
          if (!Vis.wledStreamDue(lastStreamedMs[host] || 0, now,
                shape.width * shape.height)) continue
          lastStreamedMs[host] = now

          var hex = Vis.wledPanelFrame(frame, paletteName, paletteContext,
            shape.width, shape.height, fillStyle, wledStyle)
          // An empty answer is silence, not black: stop writing and the panel
          // goes back to its own effect on the realtime timeout. Falling
          // through here would paint over it with a different style instead.
          if (hex) {
            wledStream.write(Vis.wledStreamLine(host, shape.start, hex))
            wledTouched = true
          }
          continue
        }
        // Only a panel whose segment does not start at the origin lands
        // here: its pixel-to-LED mapping is the light's own ledmap and cannot
        // be guessed. Brightness is all that is left to say.
      }

      if (!httpDue) continue
      httpSent = true

      // Nothing is known about this light yet — the probe is one round trip
      // behind the first frame. Brightness follows the music meanwhile; the
      // one-colour payload must not, because it carries fx 0 and would take
      // the light's effect away over a question that answers itself in a
      // moment. That mistake is the one this bridge keeps making.
      var dim = Vis.wledBrightnessPayload(Vis.wledBrightness(energy, 32, 255))

      if (wledStyle === "params") {
        var knobs = wledKnobs[host] || []
        // An effect whose only sliders are Fade rate and Blur has nothing the
        // audio can move without making it look broken, and about a third of
        // them are exactly that. Brightness is the honest fallback, not
        // driving those knobs anyway.
        if (knobs.length === 0) { send(host, dim); continue }
        send(host, Vis.wledParamsPayload(knobs, frame, wledSpan / 100))
        continue
      }

      var solid = Vis.wledPayload(Vis.wledBrightness(energy, 0, 255),
        Vis.wledColor(paletteName, energy, paletteContext))

      // `solid` is a choice and gets the payload that carries fx 0. Every
      // painting style is streamed now, so anything else reaching here is a
      // light that has not been measured yet or one that cannot be addressed,
      // and brightness is the only honest thing to send either way.
      if (wledStyle === "solid") { send(host, solid); continue }
      send(host, dim)
    }

    // Advanced only when a JSON frame actually went out, or a run of panels
    // would starve the cap and every strip alongside them would stall.
    if (httpSent) {
      lastSentMs = now
      wledTouched = true
    }
  }


  function restoreWled() {
    if (!wledRestore || !wledTouched || wledHosts.length === 0) return
    wledTouched = false
    // Nothing was remembered, so the honest restore is off rather than a guess
    // at what the lamp was doing before.
    for (var i = 0; i < wledHosts.length; i++) {
      var host = wledHosts[i]
      send(host, Vis.wledRestorePayload(wledBaselines[host]))
    }
    forgetBaselines()
  }

  // Dropped along with the restore: the next run probes a light that is back
  // to being itself, and records that instead of a value it wrote.
  function forgetBaselines() {
    wledBaselines = ({})
    wledDeclared = ({})
    wledKnobs = ({})
    wledEffects = ({})
    wledSegs = ({})
  }

  // Detached and fire-and-forget: a light that does not answer must not hold up
  // the next frame, and a failure here never touches what the bar draws.
  function send(host, payload) {
    Quickshell.execDetached(["curl", "-s", "-m", "1", "-X", "POST",
      "-H", "Content-Type: application/json",
      "-d", payload, "http://" + host + "/json/state"])
  }

  // Colours come from the panel, which owns the theme bindings.
  property string paletteName: "accent"
  property var paletteContext: ({})
  // The fill too, or the strip paints a different picture from the screen it
  // is supposed to be echoing.
  property string fillStyle: "solid"
}
