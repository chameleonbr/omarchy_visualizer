// The big view: one ordinary window.
//
// It used to be a layer-shell surface, which is why it hovered over everything
// and could never be anything but a card floating in the middle of an output.
// A `FloatingWindow` is a normal toplevel: the compositor tiles it, floats it,
// moves it between workspaces and applies whatever window rules the user
// already wrote. None of that is this plugin's business, so `f` is left to do
// the one thing the compositor cannot guess — fullscreen, and back.

import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Visualizer.js" as Vis

Item {
  id: root

  property var widget: null
  readonly property var service: widget ? widget.service : null

  // `visible` on an Item hides its children, so the open state is its own
  // property and the window reads it.
  property bool shown: false
  property bool settingsOpen: false

  readonly property var stageScreen: widget && widget.QsWindow && widget.QsWindow.window
    ? widget.QsWindow.window.screen : null

  function open() { shown = true }

  function close() {
    settingsOpen = false
    shown = false
  }

  function toggleFullscreen() {
    if (loader.item) loader.item.fullscreen = !loader.item.fullscreen
  }

  LazyLoader {
    id: loader
    active: root.shown

    FloatingWindow {
      id: toplevel

      visible: true
      title: "Visualizer"
      color: Color.background
      screen: root.stageScreen

      // Only a hint: a tiled window is sized by the compositor, and a floating
      // one by whatever rule the user wrote for it.
      implicitWidth: Style.space(900)
      implicitHeight: Style.space(400)
      minimumSize: Qt.size(Style.space(320), Style.space(160))

      onClosed: root.close()

      StageBody {
        anchors.fill: parent
        widget: root.widget
        fullscreen: toplevel.fullscreen
        settingsOpen: root.settingsOpen
        onSettingsToggleRequested: root.settingsOpen = !root.settingsOpen
        onCloseRequested: root.close()
        onFullscreenToggleRequested: root.toggleFullscreen()
      }
    }
  }
}
