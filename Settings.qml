// The settings, over the stage.
//
// Every row cycles rather than opening a list: at this size a dropdown costs
// more than it gives, and the whole point is to try things quickly and see the
// result behind the panel while you do it.
//
// Changes are written to the plugin's own file and take effect immediately —
// there is no apply button, because the visualiser behind the panel is the
// preview.

import QtQuick
import qs.Commons
import qs.Ui
import "Visualizer.js" as Vis

Item {
  id: root

  property var widget: null
  readonly property var service: widget ? widget.service : null

  signal closeRequested()

  MouseArea {
    anchors.fill: parent
    onClicked: root.closeRequested()
  }

  Rectangle {
    anchors.centerIn: parent
    width: Math.min(parent.width - Style.space(40), Style.space(560))
    height: Math.min(parent.height - Style.space(40), column.implicitHeight + Style.space(40))
    color: Color.background
    radius: Style.cornerRadius
    border.width: 1
    border.color: Color.popups.border

    MouseArea { anchors.fill: parent }

    Column {
      id: column
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      anchors.margins: Style.space(20)
      spacing: Style.space(6)

      Text {
        text: "Ajustes"
        color: Color.foreground
        font.family: Style.font.family
        font.pixelSize: Style.font.subtitle
        font.bold: true
      }

      Text {
        text: "clique num valor para trocar · esc volta"
        color: Qt.darker(Color.foreground, 1.8)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        bottomPadding: Style.space(8)
      }

      Repeater {
        model: [
          { key: "base", label: "base", values: Vis.BASES },
          { key: "cap", label: "ponta", values: Vis.CAPS },
          { key: "fill", label: "preenchimento", values: Vis.FILLS },
          { key: "palette", label: "paleta", values: Vis.PALETTES },
          { key: "input", label: "entrada", values: Vis.INPUTS },
          { key: "showPeaks", label: "marcador de pico", values: [false, true] },
          { key: "showWave", label: "onda por baixo", values: [false, true] },
          { key: "barCount", label: "barras", values: [8, 12, 14, 16, 20, 24] },
          { key: "smoothing", label: "queda", values: [0, 30, 60, 80, 95] },
          { key: "framerate", label: "quadros por segundo", values: [15, 30, 45, 60] }
        ]

        Rectangle {
          required property var modelData

          readonly property var current: root.service
            ? root.service.value(modelData.key) : modelData.values[0]

          width: column.width
          height: row.implicitHeight + Style.space(10)
          radius: Style.space(4)
          color: hover.hovered
            ? Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.06)
            : "transparent"

          HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }

          // Left cycles forward, right cycles back: the same control both ways
          // beats two arrows per row.
          TapHandler {
            acceptedButtons: Qt.LeftButton | Qt.RightButton
            onTapped: function(point, button) {
              if (!root.service) return
              var patch = {}
              patch[modelData.key] = Vis.cycle(modelData.values, current,
                button === Qt.RightButton ? -1 : 1)
              root.service.save(patch)
            }
          }

          Row {
            id: row
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            anchors.leftMargin: Style.space(8)
            anchors.rightMargin: Style.space(8)

            Text {
              text: modelData.label
              color: Qt.darker(Color.foreground, 1.4)
              font.family: Style.font.family
              font.pixelSize: Style.font.body
              width: parent.width - Style.space(180)
              elide: Text.ElideRight
            }

            Text {
              text: String(parent.parent.current)
              color: Color.accent
              font.family: Style.font.family
              font.pixelSize: Style.font.body
              font.bold: true
              horizontalAlignment: Text.AlignRight
              width: Style.space(172)
            }
          }
        }
      }

      Text {
        topPadding: Style.space(10)
        width: column.width
        wrapMode: Text.WordWrap
        // Said plainly, because "both" briefly rearranges the audio graph and
        // that is not something to discover afterwards.
        text: "entrada: sistema ouve o que a máquina toca · microfone ouve o microfone · "
          + "ambos cria um dispositivo virtual enquanto estiver ligado e o remove ao sair"
        color: Qt.darker(Color.foreground, 1.9)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }
  }
}
