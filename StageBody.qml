// What the stage draws, without deciding what kind of window draws it.
//
// Two very different windows show this: a layer-shell card that floats over
// everything, and a real toplevel the compositor tiles. Everything below is the
// same either way, which is the point of it living in its own file.

import QtQuick
import qs.Commons
import qs.Ui
import "Visualizer.js" as Vis
import "I18n.js" as I18n

Item {
  id: body

  property var widget: null
  readonly property var service: widget ? widget.service : null

  // Read-only here. The stage owns it, because it has to survive this body
  // being destroyed with its window.
  property bool settingsOpen: false

  signal closeRequested()
  signal settingsToggleRequested()

  // `I18n.t()` is a function call, so nothing about it tells QML to
  // re-evaluate when the language changes. Reading the epoch first is what
  // makes these bindings depend on it.
  readonly property int languageEpoch: service ? service.languageEpoch : 0
  function tr(key) {
    var epoch = body.languageEpoch
    return I18n.t(key)
  }

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

  // Opening the pane hands the keyboard back, so the accelerators work whether
  // it was opened with `s`, with the widget, or over IPC.
  onSettingsOpenChanged: if (settingsOpen) forceActiveFocus()

  Keys.onPressed: function(event) {
    if (event.key === Qt.Key_Escape) {
      // One layer at a time: escaping the settings leaves the visualiser up.
      if (body.settingsOpen) body.settingsToggleRequested()
      else body.closeRequested()
      event.accepted = true
      return
    }

    if (event.key === Qt.Key_S) {
      body.settingsToggleRequested()
      event.accepted = true
      return
    }

    // Every other letter belongs to a setting, and only while the pane is
    // open. Cycling a palette from a key nobody can see the meaning of is a
    // visualiser that changes itself for no stated reason.
    if (!body.settingsOpen) return

    var typed = event.text
    if (!typed) return

    var digit = Vis.COLOR_ACCELS.indexOf(typed)
    if (digit >= 0) {
      settingsPane.openColorAt(digit)
      // The picker is opened for the mouse; the keyboard stays here so the
      // next letter is still a setting.
      body.forceActiveFocus()
      event.accepted = true
      return
    }

    // The pane owns the lookup: which letters exist depends on which rows it
    // is showing. Shift walks back, which matters on a nine-value axis like
    // the palette.
    if (settingsPane.cycleAccel(typed, (event.modifiers & Qt.ShiftModifier) !== 0)) {
      event.accepted = true
    }
  }

  Rectangle {
    anchors.fill: parent
    // Tiled, the window *is* the surface: no inset border, no rounded corner
    // faking a card, nothing between the spectrum and the edge it was given.
    // The window *is* the surface: no inset border, no rounded corner faking a
    // card, nothing between the spectrum and the edge the compositor gave it.
    color: Color.background

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
          var epoch = body.languageEpoch
          return body.service ? I18n.idleText(body.service.idleReason) : ""
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
        text: {
          var epoch = body.languageEpoch
          return I18n.hintText(body.settingsOpen)
        }
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
      onFocusReturned: body.forceActiveFocus()
    }
  }
}
