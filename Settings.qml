// The settings, beside the spectrum rather than over it.
//
// Every row cycles on click — left forward, right back — because at this width
// a dropdown costs more than it gives, and there is no apply button: the
// visualiser next to the panel is the preview for every control in here.
//
// The colour rows only appear for the palettes that read a colour. Offering a
// picker that changes nothing is how a settings screen teaches people that its
// controls are decoration.

import QtQuick
import qs.Commons
import qs.Ui
import "Visualizer.js" as Vis

Item {
  id: root

  property var widget: null
  readonly property var service: widget ? widget.service : null
  readonly property string palette: service ? service.value("palette") : "accent"
  readonly property var colorKeys: Vis.colorKeysFor(palette)

  property string editing: ""

  signal closeRequested()

  function set(key, value) {
    if (!service) return
    var patch = {}
    patch[key] = value
    service.save(patch)
  }

  Rectangle {
    anchors.fill: parent
    color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.04)
    radius: Style.space(6)
  }

  Flickable {
    id: flick
    anchors.fill: parent
    anchors.margins: Style.space(10)
    contentWidth: width
    contentHeight: column.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: column
      width: flick.width
      spacing: Style.space(2)

      Text {
        text: "Ajustes"
        color: Color.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        font.bold: true
        bottomPadding: Style.space(4)
      }

      Repeater {
        model: [
          { key: "base", label: "base", values: Vis.BASES },
          { key: "cap", label: "ponta", values: Vis.CAPS },
          { key: "fill", label: "preenchimento", values: Vis.FILLS },
          { key: "palette", label: "paleta", values: Vis.PALETTES },
          { key: "input", label: "entrada", values: Vis.INPUTS },
          { key: "showPeaks", label: "pico", values: [false, true] },
          { key: "showWave", label: "onda", values: [false, true] },
          { key: "barCount", label: "barras", values: [8, 12, 14, 16, 20, 24] },
          { key: "smoothing", label: "queda", values: [0, 30, 60, 80, 95] },
          { key: "framerate", label: "fps", values: [15, 30, 45, 60] }
        ]

        Rectangle {
          required property var modelData

          readonly property var current: root.service
            ? root.service.value(modelData.key) : modelData.values[0]

          width: column.width
          height: cycleRow.implicitHeight + Style.space(8)
          radius: Style.space(3)
          color: hover.hovered
            ? Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.07)
            : "transparent"

          HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }

          TapHandler {
            acceptedButtons: Qt.LeftButton | Qt.RightButton
            onTapped: function(point, button) {
              root.set(modelData.key,
                Vis.cycle(modelData.values, current, button === Qt.RightButton ? -1 : 1))
            }
          }

          Row {
            id: cycleRow
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            anchors.leftMargin: Style.space(6)
            anchors.rightMargin: Style.space(6)

            Text {
              text: modelData.label
              color: Qt.darker(Color.foreground, 1.4)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              width: parent.width - Style.space(110)
              elide: Text.ElideRight
            }

            Text {
              text: String(parent.parent.current)
              color: Color.accent
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignRight
              width: Style.space(104)
              elide: Text.ElideLeft
            }
          }
        }
      }

      // ------------------------------------------------------- colours

      Repeater {
        // Only what the current palette actually reads. A picker that changes
        // nothing teaches people the controls are decoration.
        model: root.colorKeys

        Column {
          required property string modelData

          readonly property string label:
            modelData === "solidColor" ? "cor"
            : (modelData === "gradientFrom" ? "gradiente de" : "gradiente até")
          readonly property string value:
            root.service ? String(root.service.value(modelData) || "") : ""
          readonly property bool open: root.editing === modelData

          width: column.width
          spacing: Style.space(4)

          Rectangle {
            width: parent.width
            height: swatchRow.implicitHeight + Style.space(8)
            radius: Style.space(3)
            color: parent.open || swatchHover.hovered
              ? Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.07)
              : "transparent"

            HoverHandler { id: swatchHover; cursorShape: Qt.PointingHandCursor }
            TapHandler {
              onTapped: root.editing = parent.parent.open ? "" : parent.parent.modelData
            }

            Row {
              id: swatchRow
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(6)
              anchors.rightMargin: Style.space(6)
              spacing: Style.space(6)

              Text {
                anchors.verticalCenter: parent.verticalCenter
                text: parent.parent.parent.label
                color: Qt.darker(Color.foreground, 1.4)
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                width: parent.width - Style.space(90)
                elide: Text.ElideRight
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                // An empty setting says so rather than showing a swatch of the
                // colour it would fall back to, which would read as a choice
                // someone made.
                text: parent.parent.parent.value || "tema"
                color: Qt.darker(Color.foreground, 1.6)
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(18)
                height: Style.space(18)
                radius: Style.space(3)
                color: {
                  var parsed = Vis.parseHex(parent.parent.parent.value)
                  return parsed ? Qt.rgba(parsed.r, parsed.g, parsed.b, 1) : Color.accent
                }
                border.width: 1
                border.color: Color.popups.border
              }
            }
          }

          ColorPicker {
            width: parent.width
            visible: parent.open
            value: parent.value
            fallback: Color.accent
            onPicked: function(hex) { root.set(parent.modelData, hex) }
          }
        }
      }

      Text {
        topPadding: Style.space(8)
        width: column.width
        wrapMode: Text.WordWrap
        text: "clique num valor para trocar · botão direito volta"
        color: Qt.darker(Color.foreground, 1.9)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }
  }
}
