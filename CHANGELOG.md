# Changelog

All notable public changes to Navigation Dropdown Menus are documented here.

## 1.0.2 - 2026-10-04

### Improved

- Makes Docker, VM, and Unassigned Devices dropdowns reopen faster by reusing session data while stale information refreshes in the background.
- Keeps Docker and VM state changes synchronized between Navigation Dropdown Menus, Unraid's native Docker/VM pages, and other open browser tabs.
- Keeps Docker and VM transition feedback stable until the requested lifecycle change reaches its expected state.

### Fixed

- Prevents older Docker or VM observations from overwriting newer state after start/stop actions.
- Prevents VM start transitions from briefly showing the paused icon while the VM is still transitioning.
- Eliminates visible wobble from Docker and VM transition spinners while retaining Unraid's native Font Awesome refresh/spin appearance.
- Corrects the plugin version shown by the install-completion banner.

## 1.0.1

- Makes every top-level dropdown size to its content or the available viewport height, whichever is smaller.
- Keeps approximately 1rem of clearance between a viewport-constrained dropdown and the bottom of the browser window.
- Shows a vertical scrollbar only when additional top-level dropdown content exceeds the available viewport height.
- Removes the Plugins-only 72vh/700px scroll-height exception so all dropdowns use the same viewport rule.
- Keeps nested menus reachable when a top-level dropdown becomes viewport-constrained by rendering those nested menus inside the scrollable region.
- Removes the redundant Navigation Dropdown Menus heading from the plugin settings page.
- Adds the dedicated Unraid forum support thread to the plugin and Community Applications metadata while retaining GitHub Issues for bug reports and feature requests.

## 1.0.0

Initial public release.

- Adds individually configurable dropdown menus to the Unraid WebGUI main navigation for Main, Shares, Users, Settings, Plugins, Docker, VMs, and Tools while preserving the normal function of each parent navigation link.
- Provides configurable hover-open timings and sorting options for Shares, Users, Docker containers, and VMs.
- Displays native-style icons for all dropdown menus.
- Displays currently mounted Unassigned Devices remote shares under Main when enabled and the Unassigned Devices plugin is installed.
- Provides configurable Docker status indicators, native log buttons, WebUI buttons for running containers with valid WebUI URLs, and optional quick start/stop controls with configurable stop confirmations.
- Provides configurable VM status indicators, native log buttons, VNC Console buttons for supported running VMs, and optional quick start/stop controls with configurable stop confirmations.
- Provides configurable Docker WebUI new-tab behavior.
- Follows the active Dynamix color theme automatically.
- Does not replace or modify stock Unraid WebGUI files.
