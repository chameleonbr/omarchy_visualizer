// The big view, in whichever kind of window the mode asks for.
//
// `float` is a layer-shell card: it hovers over everything, sized to its own
// content, and the desktop underneath stays clickable. Good for a glance.
//
// `tile` is a real toplevel window. The compositor tiles it like any other
// window, which is the only way to get the two things a layer surface cannot
// give: it fills the whole tile it was given, and it stacks with its
// neighbours instead of sitting permanently in front of them.
//
// Both draw the same StageBody. Nothing here is a resize of the other — the
// window type itself has to change, which is why there are two of them and one
// is always destroyed.

import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "Visualizer.js" as Vis

Item {
  id: root

  property var widget: null
  readonly property var service: widget ? widget.service : null

  // `visible` on an Item hides its children, so the open state is its own
  // property and the windows read it.
  property bool shown: false
  property bool settingsOpen: false

  readonly property string mode: service ? service.value("mode") : "float"
  readonly property bool tiled: mode === "tile"

  readonly property var stageScreen: widget && widget.QsWindow && widget.QsWindow.window
    ? widget.QsWindow.window.screen : null

  function open() {
    shown = true
    focusPrime.restart()
  }

  function close() {
    settingsOpen = false
    shown = false
  }

  function toggleMode() {
    if (service) service.save({ mode: tiled ? "float" : "tile" })
  }

  Timer {
    id: focusPrime
    interval: 120
  }

  // ------------------------------------------------------- floating card

  LazyLoader {
    active: root.shown && !root.tiled

    PanelWindow {
      id: card

      visible: true
      color: "transparent"
      screen: root.stageScreen

      // Anchored to the bottom only, so the compositor centres it horizontally
      // and the window is exactly as big as what it draws.
      anchors.bottom: true
      margins.bottom: Style.space(40)

      implicitWidth: {
        var base = Math.min(root.stageScreen ? root.stageScreen.width - Style.space(80) : 900,
          Style.space(760))
        return root.settingsOpen ? base + Style.space(300) : base
      }

      implicitHeight: root.settingsOpen ? Style.space(460) : Style.space(280)

      WlrLayershell.layer: WlrLayer.Overlay
      WlrLayershell.namespace: "omarchy-visualizer-stage"

      // Primed Exclusive so the keys work the moment it opens, then settled on
      // OnDemand so it stops swallowing everything else. Exclusive alone makes
      // the compositor route every key here for as long as the window lives,
      // which is what "it locks the screen" means.
      WlrLayershell.keyboardFocus: focusPrime.running ? WlrKeyboardFocus.Exclusive
        : WlrKeyboardFocus.OnDemand

      StageBody {
        anchors.fill: parent
        widget: root.widget
        tiled: false
        settingsOpen: root.settingsOpen
        onSettingsToggleRequested: root.settingsOpen = !root.settingsOpen
        onCloseRequested: root.close()
        onModeToggleRequested: root.toggleMode()
      }
    }
  }

  // --------------------------------------------------------- tiled window

  LazyLoader {
    active: root.shown && root.tiled

    FloatingWindow {
      id: toplevel

      visible: true
      title: "Visualizer"
      color: Color.background
      screen: root.stageScreen

      // Only a hint: the compositor sizes a tiled window itself, and the whole
      // point of this mode is letting it.
      implicitWidth: Style.space(900)
      implicitHeight: Style.space(400)
      minimumSize: Qt.size(Style.space(320), Style.space(160))

      onClosed: root.close()

      StageBody {
        anchors.fill: parent
        widget: root.widget
        tiled: true
        settingsOpen: root.settingsOpen
        onSettingsToggleRequested: root.settingsOpen = !root.settingsOpen
        onCloseRequested: root.close()
        onModeToggleRequested: root.toggleMode()
      }
    }
  }
}
