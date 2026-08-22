// What the stage draws, without deciding what kind of window draws it.
//
// Two very different windows show this: a layer-shell card that floats over
// everything, and a real toplevel the compositor tiles. Everything below is the
// same either way, which is the point of it living in its own file.

import QtQuick
import qs.Commons
import qs.Ui

Item {
  id: body

  property var widget: null
  readonly property var service: widget ? widget.service : null

  property bool tiled: false
  // Read-only here. The stage owns it, because it has to survive this body
  // being destroyed and rebuilt as the other kind of window.
  property bool settingsOpen: false

  signal closeRequested()
  signal modeToggleRequested()
  signal settingsToggleRequested()

  // Settings sit beside the spectrum when there is room and underneath it when
  // there is not — over the top of it is the one place they must not be, since
  // the visualiser is the preview for every control in them.
  readonly property bool sideBySide: width >= Style.space(720)

  // Geometry rather than anchors, for both the viewport and the pane. Assigning
  // `undefined` to an anchor from inside a binding does not clear it — the old
  // anchor stays and the pane ends up glued to both edges at once, which is a
  // silent layout bug rather than an error.
  readonly property int inset: Style.space(18)

  focus: true

  Keys.onPressed: function(event) {
    if (event.key === Qt.Key_Escape) {
      // One layer at a time: escaping the settings leaves the visualiser up.
      // The mode is a setting rather than a state, so escape does not silently
      // undo it — it closes.
      if (body.settingsOpen) body.settingsToggleRequested()
      else body.closeRequested()
      event.accepted = true
      return
    }

    if (event.key === Qt.Key_F) {
      body.modeToggleRequested()
      event.accepted = true
      return
    }

    if (event.key === Qt.Key_S) {
      body.settingsToggleRequested()
      event.accepted = true
    }
  }

  Rectangle {
    anchors.fill: parent
    // Tiled, the window *is* the surface: no inset border, no rounded corner
    // faking a card, nothing between the spectrum and the edge it was given.
    color: Color.background
    radius: body.tiled ? 0 : Style.cornerRadius
    border.width: body.tiled ? 0 : 1
    border.color: Color.popups.border

    // Clicking the card focuses it without closing it.
    MouseArea {
      anchors.fill: parent
      onClicked: body.forceActiveFocus()
    }

    // --------------------------------------------------- the spectrum

    Item {
      id: viewport
      x: body.inset
      y: body.inset
      width: Math.max(1, (body.settingsOpen && body.sideBySide
        ? settingsPane.x : body.width) - body.inset * 2)
      height: Math.max(1, (body.settingsOpen && !body.sideBySide
        ? settingsPane.y : body.height) - body.inset * 2)

      Spectrum {
        anchors.fill: parent
        anchors.bottomMargin: hint.height + Style.space(6)

        frame: body.service && body.service.running ? body.service.frame
          : new Array(body.widget ? body.widget.barCount : 14).fill(0)
        peaks: body.service && body.service.running ? body.service.peaks : []

        base: body.widget ? body.widget.base : "bottom"
        cap: body.widget ? body.widget.cap : "flat"
        fill: body.widget ? body.widget.fillStyle : "solid"
        palette: body.widget ? body.widget.palette : "accent"
        paletteContext: body.widget ? body.widget.paletteContext : ({})
        // Bars scale with the window: the bar's three-pixel sticks would look
        // like a rounding error across a whole screen.
        barWidth: Math.max(3, Math.round(width / (Math.max(1, frame.length) * 2)))
        gap: Math.max(2, Math.round(width / (Math.max(1, frame.length) * 8)))
        segments: body.widget ? body.widget.segments : 8
        showPeaks: body.widget ? body.widget.showPeaks : false
        showWave: body.widget ? body.widget.showWave : false
        spread: body.widget ? body.widget.spread : 1
        innerRadius: body.widget ? body.widget.innerRadius : 0.3
        devicePixelRatio: body.Screen ? body.Screen.devicePixelRatio : 1
      }

      Text {
        anchors.centerIn: parent
        visible: !body.service || !body.service.running
        text: {
          if (!body.service) return ""
          if (body.service.idleReason === "missing")
            return "cava não está instalado\nomarchy pkg add cava"
          if (body.service.idleReason === "battery") return "pausado na bateria"
          if (body.service.idleReason === "silent") return "nada tocando"
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
        text: (body.tiled ? "f  flutuante" : "f  janela")
          + "     s  ajustes     esc  fechar"
        color: Qt.darker(Color.foreground, 1.8)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        opacity: 0.7
      }
    }

    // ---------------------------------------------------- the settings

    Settings {
      id: settingsPane
      widget: body.widget
      visible: body.settingsOpen

      // Full height beside the spectrum. Sizing it to its rows instead leaves a
      // dead column under it that belongs to neither one — an empty gap in the
      // middle of the layout reads worse than a sidebar with room left.
      width: body.sideBySide ? Style.space(280) : body.width - pad * 2
      height: body.sideBySide ? body.height - pad * 2 : Style.space(280)
      x: body.width - pad - width
      y: body.height - pad - height

      readonly property int pad: Style.space(14)

      onCloseRequested: body.settingsToggleRequested()
    }
  }
}
