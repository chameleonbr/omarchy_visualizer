// A colour picker, for the settings that hold one.
//
// A saturation/value square with a hue strip beside it and the hex underneath,
// which is the arrangement everyone already knows. The hex is a field rather
// than a readout because half the time someone is pasting a colour from
// somewhere else rather than hunting for it here.

import QtQuick
import qs.Commons
import qs.Ui
import "Visualizer.js" as Vis

Item {
  id: root

  property string value: ""
  property color fallback: Color.accent

  signal picked(string hex)

  readonly property var parsed: Vis.parseHex(value)
  // Editing starts from whatever the setting already holds; an unset or broken
  // one starts from the theme rather than from black, which is a colour nobody
  // means to choose.
  property real hue: 0
  property real sat: 0.8
  property real val: 0.9
  property bool syncing: false

  implicitHeight: column.implicitHeight

  function loadFromValue() {
    syncing = true
    var c = parsed || { r: fallback.r, g: fallback.g, b: fallback.b }
    var hsv = Vis.rgbToHsv(c)
    hue = hsv.h
    // A grey has no hue to recover, so its saturation is left where it was and
    // only the value is taken: dragging away from grey then goes somewhere.
    if (hsv.s > 0.01) sat = hsv.s
    val = hsv.v
    syncing = false
  }

  Component.onCompleted: loadFromValue()
  onValueChanged: if (!syncing) loadFromValue()

  readonly property color current: {
    var c = Vis.hsvToRgb(hue, sat, val)
    return Qt.rgba(c.r, c.g, c.b, 1)
  }

  function commit() {
    var c = Vis.hsvToRgb(hue, sat, val)
    syncing = true
    root.picked(Vis.toHex(c))
    syncing = false
  }

  Column {
    id: column
    width: parent.width
    spacing: Style.space(8)

    Row {
      width: parent.width
      spacing: Style.space(8)
      height: Style.space(120)

      // ---- saturation and value

      Rectangle {
        id: field
        width: parent.width - hueStrip.width - Style.space(8)
        height: parent.height
        radius: Style.space(3)
        color: Qt.hsva(root.hue, 1, 1, 1)

        // White across, black down: the standard square, built from two
        // gradients rather than a shader because it never animates.
        Rectangle {
          anchors.fill: parent
          radius: parent.radius
          gradient: Gradient {
            orientation: Gradient.Horizontal
            GradientStop { position: 0; color: "#ffffffff" }
            GradientStop { position: 1; color: "#00ffffff" }
          }
        }

        Rectangle {
          anchors.fill: parent
          radius: parent.radius
          gradient: Gradient {
            GradientStop { position: 0; color: "#00000000" }
            GradientStop { position: 1; color: "#ff000000" }
          }
        }

        Rectangle {
          x: root.sat * parent.width - width / 2
          y: (1 - root.val) * parent.height - height / 2
          width: Style.space(12)
          height: width
          radius: width / 2
          color: "transparent"
          border.width: 2
          border.color: "white"

          Rectangle {
            anchors.fill: parent
            anchors.margins: 2
            radius: width / 2
            color: "transparent"
            border.width: 1
            border.color: "black"
          }
        }

        MouseArea {
          anchors.fill: parent
          onPositionChanged: function(mouse) { if (pressed) apply(mouse) }
          onPressed: function(mouse) { apply(mouse) }
          onReleased: root.commit()

          function apply(mouse) {
            root.sat = Math.max(0, Math.min(1, mouse.x / width))
            root.val = Math.max(0, Math.min(1, 1 - mouse.y / height))
          }
        }
      }

      // ---- hue

      Rectangle {
        id: hueStrip
        width: Style.space(18)
        height: parent.height
        radius: Style.space(3)

        gradient: Gradient {
          GradientStop { position: 0.00; color: "#ff0000" }
          GradientStop { position: 0.17; color: "#ffff00" }
          GradientStop { position: 0.33; color: "#00ff00" }
          GradientStop { position: 0.50; color: "#00ffff" }
          GradientStop { position: 0.67; color: "#0000ff" }
          GradientStop { position: 0.83; color: "#ff00ff" }
          GradientStop { position: 1.00; color: "#ff0000" }
        }

        Rectangle {
          y: root.hue * parent.height - height / 2
          width: parent.width
          height: Style.space(4)
          color: "transparent"
          border.width: 2
          border.color: "white"
        }

        MouseArea {
          anchors.fill: parent
          onPositionChanged: function(mouse) { if (pressed) apply(mouse) }
          onPressed: function(mouse) { apply(mouse) }
          onReleased: root.commit()

          function apply(mouse) {
            root.hue = Math.max(0, Math.min(0.999, mouse.y / height))
          }
        }
      }
    }

    // ---- the hex, editable

    Row {
      width: parent.width
      spacing: Style.space(8)

      Rectangle {
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(26)
        height: Style.space(26)
        radius: Style.space(3)
        color: root.current
        border.width: 1
        border.color: Color.popups.border
      }

      TextField {
        id: hexField
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width - Style.space(34)
        text: Vis.toHex(Vis.hsvToRgb(root.hue, root.sat, root.val))
        foreground: Color.foreground

        // Committed on Enter rather than on every keystroke: "#ff" is a valid
        // prefix of a colour someone is still typing, and repainting from it
        // would fight them.
        onAccepted: {
          var parsed = Vis.parseHex(text)
          if (!parsed) { text = Vis.toHex(Vis.hsvToRgb(root.hue, root.sat, root.val)); return }
          root.picked(Vis.toHex(parsed))
        }
      }
    }
  }
}
