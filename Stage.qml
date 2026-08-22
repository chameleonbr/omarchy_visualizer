// The big view.
//
// Two ways to sit on screen, and the mode is a setting rather than a passing
// state, so it survives closing the view. `float` is a card the size of its own
// content: the rest of the screen belongs to whatever was already there, and
// you can carry on clicking it. `fill` takes the whole usable area — the screen
// minus what the bar already claims, since a layer surface respects the
// exclusive zones around it — and leaves no margin of its own.
//
// Keyboard focus is primed Exclusive on open and settles on OnDemand — the same
// dance qs.Ui's KeyboardPanel does. Exclusive alone makes the compositor route
// every key here for as long as the window lives, which is what "it locks the
// screen" means.

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "Visualizer.js" as Vis

PanelWindow {
  id: root

  property var widget: null
  readonly property var service: widget ? widget.service : null
  property bool settingsOpen: false

  // `float` is a card the size of its own content and leaves the desktop alone.
  // `fill` takes the whole usable area — which is the screen minus whatever the
  // bar already claims, because a layer surface respects the exclusive zones
  // around it rather than sitting on top of them.
  readonly property string mode: service ? service.value("mode") : "float"
  readonly property bool filling: mode === "fill"

  // Settings sit beside the spectrum when there is room and underneath it when
  // there is not — over the top of it is the one place they must not be, since
  // the visualiser is the preview for every control in them.
  readonly property bool sideBySide: filling
    || (screen ? screen.width : 1920) >= Style.space(1100)

  function open() {
    visible = true
    focusPrime.restart()
  }

  function close() {
    settingsOpen = false
    visible = false
  }

  function toggleMode() {
    if (service) service.save({ mode: filling ? "float" : "fill" })
  }

  visible: false
  color: "transparent"

  screen: widget && widget.QsWindow && widget.QsWindow.window
    ? widget.QsWindow.window.screen : null

  // Filling anchors to every edge. Floating anchors to the bottom only, so the
  // compositor centres it horizontally and the window is exactly as big as what
  // it draws.
  anchors.top: filling
  anchors.bottom: true
  anchors.left: filling
  anchors.right: filling
  margins.bottom: filling ? 0 : Style.space(40)

  implicitWidth: filling ? 0 : cardWidth
  implicitHeight: filling ? 0 : cardHeight

  readonly property int cardWidth: {
    var base = Math.min(screen ? screen.width - Style.space(80) : 900, Style.space(760))
    if (!settingsOpen) return base
    return sideBySide ? base + Style.space(300) : base
  }

  readonly property int cardHeight: {
    var base = Style.space(280)
    if (!settingsOpen) return base
    // Taller with the settings open: the colour picker needs room, and a pane
    // that has to be scrolled to reach half its controls reads as broken.
    return sideBySide ? Style.space(460) : base + Style.space(320)
  }

  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.namespace: "omarchy-visualizer-stage"

  // Primed Exclusive so the keys work the moment it opens, then settled on
  // OnDemand so it stops swallowing everything else.
  WlrLayershell.keyboardFocus: !visible ? WlrKeyboardFocus.None
    : (focusPrime.running ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.OnDemand)

  Timer {
    id: focusPrime
    interval: 120
  }

  Rectangle {
    id: scrim
    anchors.fill: parent
    // Only filling dims what is behind. Floating, there is nothing to dim: the
    // window does not cover it.
    color: root.filling ? Color.background : "transparent"
    opacity: root.filling ? 0.96 : 1

    Rectangle {
      anchors.fill: parent
      // Filling means filling: no inset border, no leftover margin around the
      // edge of the thing that was asked to take the whole area.
      anchors.margins: 0
      color: root.filling ? "transparent" : Color.background
      radius: root.filling ? 0 : Style.cornerRadius
      border.width: root.filling ? 0 : 1
      border.color: Color.popups.border

      // Clicking the card focuses it without closing; clicking outside cannot
      // reach here at all when windowed, because there is no outside.
      MouseArea { anchors.fill: parent }

      // ------------------------------------------------- the spectrum

      Item {
        id: viewport
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: root.settingsOpen && !root.sideBySide
          ? settingsPane.top : parent.bottom
        anchors.right: root.settingsOpen && root.sideBySide
          ? settingsPane.left : parent.right
        anchors.margins: Style.space(18)

        Spectrum {
          id: big
          anchors.fill: parent
          anchors.bottomMargin: hint.height + Style.space(6)

          frame: root.service && root.service.running ? root.service.frame
            : new Array(root.widget ? root.widget.barCount : 14).fill(0)
          peaks: root.service && root.service.running ? root.service.peaks : []

          base: root.widget ? root.widget.base : "bottom"
          cap: root.widget ? root.widget.cap : "flat"
          fill: root.widget ? root.widget.fillStyle : "solid"
          palette: root.widget ? root.widget.palette : "accent"
          paletteContext: root.widget ? root.widget.paletteContext : ({})
          // Bars scale with the window: the bar's three-pixel sticks would look
          // like a rounding error across a whole screen.
          barWidth: Math.max(3, Math.round(width / (Math.max(1, frame.length) * 2)))
          gap: Math.max(2, Math.round(width / (Math.max(1, frame.length) * 8)))
          segments: root.widget ? root.widget.segments : 8
          showPeaks: root.widget ? root.widget.showPeaks : false
          showWave: root.widget ? root.widget.showWave : false
          spread: root.widget ? root.widget.spread : 1
          innerRadius: root.widget ? root.widget.innerRadius : 0.3
          devicePixelRatio: root.screen ? root.screen.devicePixelRatio : 1
        }

        Text {
          anchors.centerIn: parent
          visible: !root.service || !root.service.running
          text: {
            if (!root.service) return ""
            if (root.service.idleReason === "missing")
              return "cava não está instalado\nomarchy pkg add cava"
            if (root.service.idleReason === "battery") return "pausado na bateria"
            if (root.service.idleReason === "silent") return "nada tocando"
            return ""
          }
          horizontalAlignment: Text.AlignHCenter
          color: Qt.darker(Color.foreground, 1.5)
          font.family: Style.font.family
          font.pixelSize: Style.font.body
        }

        Text {
          id: hint
          anchors.horizontalCenter: parent.horizontalCenter
          anchors.bottom: parent.bottom
          text: (root.filling ? "f  flutuante" : "f  preencher")
        + "     s  ajustes     esc  fechar"
          color: Qt.darker(Color.foreground, 1.8)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          opacity: 0.7
        }
      }

      // -------------------------------------------------- the settings

      Settings {
        id: settingsPane
        widget: root.widget
        visible: root.settingsOpen

        anchors.right: parent.right
        anchors.top: root.sideBySide ? parent.top : undefined
        anchors.bottom: parent.bottom
        anchors.left: root.sideBySide ? undefined : parent.left
        anchors.margins: Style.space(14)

        width: root.sideBySide ? Style.space(280) : undefined
        // Sized to what it holds when there is room to spare, so the pane does
        // not sit half empty next to a spectrum that could have had the space.
        height: root.sideBySide
          ? Math.min(parent.height - Style.space(28), implicitHeight)
          : Style.space(280)

        onCloseRequested: root.settingsOpen = false
      }
    }
  }

  // ------------------------------------------------------------- keys

  Item {
    anchors.fill: parent
    focus: root.visible

    Keys.onPressed: function(event) {
      if (event.key === Qt.Key_Escape) {
        // One layer at a time: escaping the settings should leave the
        // visualiser up.
        // One layer at a time. The mode is a setting rather than a state, so
        // escape does not silently undo it — it closes.
        if (root.settingsOpen) root.settingsOpen = false
        else root.close()
        event.accepted = true
        return
      }

      if (event.key === Qt.Key_F) {
        root.toggleMode()
        event.accepted = true
        return
      }

      if (event.key === Qt.Key_S) {
        root.settingsOpen = !root.settingsOpen
        event.accepted = true
      }
    }
  }
}
