// The big view.
//
// Click the widget and the spectrum gets a window of its own; `f` makes it
// fullscreen, `s` opens the settings over it, `Esc` steps back out of whichever
// of those you are in.
//
// A PanelWindow rather than a popup: this needs keyboard focus, and a popup
// attached to the bar cannot have it.

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
  property bool fullscreen: false
  property bool settingsOpen: false

  function open() { visible = true }
  function close() {
    settingsOpen = false
    fullscreen = false
    visible = false
  }

  visible: false
  color: "transparent"

  // The screen the widget lives on, not whichever one Quickshell picks first.
  // Without this the stage opens on some other monitor and the click looks like
  // it did nothing — the same lesson the docker plugin learned about launching
  // terminals.
  screen: widget && widget.QsWindow && widget.QsWindow.window
    ? widget.QsWindow.window.screen : null

  // Fullscreen anchors to every edge; the windowed size is a share of the
  // screen rather than a fixed number, so it looks the same on a laptop panel
  // and on an ultrawide.
  anchors.top: true
  anchors.bottom: true
  anchors.left: true
  anchors.right: true

  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: visible
    ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
  WlrLayershell.namespace: "omarchy-visualizer-stage"

  // Anything outside the card closes it, which is the gesture people try first.
  MouseArea {
    anchors.fill: parent
    onClicked: root.close()
  }

  Rectangle {
    id: scrim
    anchors.fill: parent
    color: Color.background
    opacity: root.fullscreen ? 0.96 : 0.55

    Behavior on opacity { NumberAnimation { duration: 180 } }
  }

  Rectangle {
    id: card
    anchors.centerIn: parent
    width: root.fullscreen ? parent.width : Math.round(parent.width * 0.62)
    height: root.fullscreen ? parent.height : Math.round(parent.height * 0.42)
    color: root.fullscreen ? "transparent" : Color.background
    radius: root.fullscreen ? 0 : Style.cornerRadius
    border.width: root.fullscreen ? 0 : 1
    border.color: Color.popups.border

    Behavior on width { NumberAnimation { duration: 200; easing.type: Easing.OutCubic } }
    Behavior on height { NumberAnimation { duration: 200; easing.type: Easing.OutCubic } }

    // Swallows the click so hitting the card does not close the stage.
    MouseArea { anchors.fill: parent }

    Spectrum {
      id: big
      anchors.fill: parent
      anchors.margins: root.fullscreen ? Style.space(60) : Style.space(24)
      anchors.bottomMargin: root.fullscreen
        ? Style.space(60) : Style.space(24) + hint.height

      frame: root.service && root.service.running ? root.service.frame
        : new Array(root.widget ? root.widget.barCount : 14).fill(0)
      peaks: root.service && root.service.running ? root.service.peaks : []

      base: root.widget ? root.widget.base : "bottom"
      cap: root.widget ? root.widget.cap : "flat"
      fill: root.widget ? root.widget.fillStyle : "solid"
      palette: root.widget ? root.widget.palette : "accent"
      paletteContext: root.widget ? root.widget.paletteContext : ({})
      // Bars scale with the window: the bar's three-pixel sticks would look
      // like a rounding error on a full screen.
      barWidth: Math.max(3, Math.round(width / (frame.length * 2)))
      gap: Math.max(2, Math.round(width / (frame.length * 8)))
      segments: root.widget ? root.widget.segments : 8
      showPeaks: root.widget ? root.widget.showPeaks : false
      showWave: root.widget ? root.widget.showWave : false
      spread: root.widget ? root.widget.spread : 1
      innerRadius: root.widget ? root.widget.innerRadius : 0.3
      devicePixelRatio: root.screen ? root.screen.devicePixelRatio : 1
    }

    // The idle state says which of the reasons it is, because "nothing is
    // drawing" has four causes and only one of them is worth acting on.
    Text {
      anchors.centerIn: parent
      visible: !root.service || !root.service.running
      text: {
        if (!root.service) return ""
        if (root.service.idleReason === "missing") return "cava não está instalado\nomarchy pkg add cava"
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
      anchors.bottomMargin: Style.space(10)
      visible: !root.settingsOpen
      text: "f  tela cheia     s  ajustes     esc  fechar"
      color: Qt.darker(Color.foreground, 1.8)
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      opacity: 0.7
    }
  }

  Settings {
    id: settings
    anchors.fill: parent
    visible: root.settingsOpen
    widget: root.widget
    onCloseRequested: root.settingsOpen = false
  }

  // ------------------------------------------------------------- keys

  Item {
    anchors.fill: parent
    focus: root.visible

    Keys.onPressed: function(event) {
      if (event.key === Qt.Key_Escape) {
        // Steps back out one layer at a time rather than closing everything:
        // Escape out of the settings should leave the visualiser up.
        if (root.settingsOpen) root.settingsOpen = false
        else if (root.fullscreen) root.fullscreen = false
        else root.close()
        event.accepted = true
        return
      }

      if (event.key === Qt.Key_F) {
        root.fullscreen = !root.fullscreen
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
