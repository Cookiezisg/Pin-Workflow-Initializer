# Pin Workflow Initializer

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/aphlkmbopbcnliomahcjeiiigoepponh?utm_source=item-share-cb)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-0F9D58)
![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-222222)
![License](https://img.shields.io/badge/License-MIT-2EA44F)

Pin Workflow Initializer is a Chrome extension that instantly organizes your workspace by managing pinned tabs and tab groups across windows with one click or a keyboard shortcut.

![Screenshot](screenshot.png)
  
## Purpose

Built for professionals who:

- Need quick access to multiple essential websites daily
- Want to maintain a clean and organized browser workspace
- Prefer a consistent tab layout across browser sessions
- Work with multiple Chrome windows but want centralized tab management
- Use Chrome's tab groups feature for better organization

## Key Features

- **One-Click Initialization**: Instantly set up your workspace via icon click or keyboard shortcut
- **Smart Window Management**: Automatically consolidates all tabs into your active window
- **Tab Groups Preservation**: Maintains your existing tab groups while cleaning up ungrouped tabs
- **Customizable Workflow**: Fully configurable list of pinned websites
- **Cross-Device Sync**: Settings sync across all your Chrome instances
- **Performance Optimized**:
  - Efficient caching system for frequently accessed settings
  - Parallel processing of tab operations
  - Smart tab classification and management
  - Minimal API calls for better performance
- **Keyboard First**: Quick access via Alt+Shift+C (customizable)

## Installation

1. Open Chrome Extensions page (`chrome://extensions/`)
2. Enable "Developer mode" in the top right
3. Click "Load unpacked" and select the `pin_workflow_initializer` directory

## Usage

### Quick Start

- **Click Method**: Click the extension icon in your toolbar
- **Keyboard Method**: Press `Alt+Shift+C`

Either method will:

1. Preserve and collapse all tab groups in your active window
2. Close all other Chrome windows
3. Remove ungrouped tabs in your active window
4. Reset pinned tabs according to your configuration
5. Open a fresh new tab

### Customize Your Workflow

1. Right-click the extension icon
2. Select "Options"
3. In the configuration page, you can:
   - Add/remove websites
   - Reorder websites using arrows
   - Save your configuration

### Customize Keyboard Shortcut

1. Visit `chrome://extensions/shortcuts`
2. Find "Pin Workflow Initializer"
3. Click the input box next to "Initialize Workflow"
4. Press your desired key combination
5. The change saves automatically

## Default Configuration

The extension comes pre-configured with essential productivity tools:

- Gmail - Email communication
- Google Calendar - Schedule management
- Google Drive - Document access

## Technical Details

- Built with Chrome Extension Manifest V3
- Uses Chrome Storage Sync API for settings persistence
- Implements Chrome Commands API for keyboard shortcuts
- Utilizes Chrome Windows, Tabs, and Tab Groups APIs for window management
- Zero external dependencies
- Performance optimizations:
  - URL caching with automatic invalidation
  - Parallel tab operations
  - Efficient tab classification
  - Minimal storage access
  - Smart state management

## Best Practices

- **Window Management**: Always operates from your currently active window
- **Tab Groups**: Preserves and collapses existing tab groups
- **Tab Order**: Maintains consistent order of pinned tabs as configured
- **Clean Workspace**: Automatically removes ungrouped tabs to prevent clutter
- **Quick Access**: New tab always opens after pinned tabs for easy navigation
- **Performance**: Optimized for speed with parallel operations and caching

## Supported

- Chrome 114+ (Manifest V3)
- Chrome tab groups enabled

## Contributing

Feel free to submit issues and enhancement requests!

## License

[MIT License](LICENSE)

---

Sun, Weilin
