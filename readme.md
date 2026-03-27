# TTRPG Tools: Player Screen

Player Screen is an Obsidian plugin for sending content to a separate popout window that can be shown on a second screen, TV, or projector.

It is designed for tabletop RPG and GM use cases: handouts, images, maps, PDFs, notes, scene text, and videos can be pushed to a player-facing display while the GM keeps control inside Obsidian.

## Features

### Player-screen popout
- Opens a dedicated Obsidian popout window for player-facing content
- Can be moved to a second monitor, TV, or projector
- Window position and size are remembered automatically
- Can be opened manually or auto-opened when content is sent

### Player screen controller
- Opens a dedicated controller view inside the main Obsidian window
- Keeps a tab list of sent items
- Lets you switch between previously sent content
- Lets you close individual controller tabs
- Includes a button to close the player-screen popout window

### Send notes
- Send the active note to the player screen
- Send a note from the file menu
- Send internal note links from reading view
- Clicking internal links on the player screen can also send linked notes directly to the screen

### Send markdown snippets
- Send selected text
- Send the current paragraph
- Send the current heading section
- Send arbitrary markdown programmatically via plugin API

### Send images
- Send image files from:
  - file menu
  - reading-view context menu
  - embedded images
  - internal links
  - command palette media picker
- Supports common vault image formats:
  - png
  - jpg / jpeg
  - gif
  - svg
  - webp
  - bmp

### Send videos
- Send video files from:
  - file menu
  - reading-view context menu
  - embedded videos
  - internal links
  - command palette media picker
- Supports common vault video formats:
  - mp4
  - webm
  - ogv
  - mov
  - m4v
- Video playback can be controlled from the Player Screen Controller:
  - play / pause
  - restart
  - seek
  - loop toggle
  - mute toggle
  - volume control

### Send PDFs
- Send PDF files from:
  - file menu
  - embedded PDF context menu
  - internal links
  - command palette media picker
- PDFs are rendered directly in the player screen
- PDF navigation can be controlled from the Player Screen Controller:
  - previous / next page
  - jump to page
  - zoom control

### Media picker commands
- Open a searchable picker for:
  - all supported media
  - images only
  - videos only
  - PDFs only
- Pick a file and send it directly to the player screen

### Reading-view integration
Adds context menu actions in rendered markdown for:
- images
- videos
- internal links
- PDF embeds
- headings
- paragraphs
- list items
- blockquotes

### Live refresh
If the currently displayed item changes in the vault, the player screen refreshes automatically for:
- notes
- images
- videos
- PDFs

### Map-friendly rendering
- Detects markdown that only contains a `zoommap` code block
- Adds a special CSS class so map views can be centered and made non-interactive on the player screen
- Works with TTRPG Tools: Maps formerly known as Zoom Map

### Fog of War
- Fog of War can be applied to supported content such as images and maps
- Reveal and cover areas from the controller view
- Adjustable brush size
- Full fog reset
- Reveal all
- Credit goes to TomtheHoff for allowing me to use parts of his code: https://github.com/TomtheHoff/Obsidian_fog-of-war

## Commands

- **Open screen window**
- **Close screen window**
- **Open player screen controller**
- **Send active note to screen**
- **Send selected text to screen**
- **Send current paragraph/section to screen**
- **Open player screen media picker**
- **Open player screen image picker**
- **Open player screen video picker**
- **Open player screen PDF picker**

## Settings

### Auto-open on send
Automatically opens the player-screen window when content is sent.

### Remember window placement
The plugin automatically stores the last popout window position and size.  
You can reset the saved placement in settings.

## Plugin API

Other plugins can send content directly to Player Screen.

### Send a note
```ts
await plugin.sendNoteByPath(path);
Send markdown
await plugin.sendMarkdown(markdown, sourcePath);
Send markdown with fog
await plugin.sendMarkdownWithFog(markdown, sourcePath, fogKey);
Send an image
await plugin.sendImageByPath(pathOrSource);
Send an image with fog
await plugin.sendImageByPathWithFog(pathOrSource);
Send a PDF
await plugin.sendPdfByPath(pathOrSource);
Send a video
await plugin.sendVideoByPath(pathOrSource);
Open or close the player screen
await plugin.openScreenWindow();
plugin.closeScreenWindow();
```

## Intended use
This plugin is useful for:

player-facing handouts
second-screen maps
scene text
chapter intros
portraits and clues
monster or NPC art
cinematic images
PDFs and letters
ambient or scene videos

### Notes
The player screen is display-focused, not editor-focused
The controller stays in the main Obsidian window and is intended for GM control
Some platform limitations may affect exact popout window positioning
For advanced map presentation, pair this plugin with TTRPG Tools: Maps (ZoomMap)

# License
MIT