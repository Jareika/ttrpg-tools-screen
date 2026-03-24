# TTRPG Tools: Player Screen

Player Screen is an Obsidian plugin for sending content to a separate popout window that can be shown on a second screen, TV, or projector.

It is designed for tabletop and GM use cases and works especially well together with custom plugins such as interactive maps.

## Features

### Player-screen popout
- Opens a dedicated popout window inside Obsidian
- Can be kept on a separate monitor
- Window position and size are remembered automatically

### Send notes
- Send the active note to the player screen
- Send a note from the file menu

### Send markdown snippets
- Send the current paragraph
- Send a heading section
- Send arbitrary markdown programmatically via plugin API

### Send images
- Send image files from:
  - file menu
  - context menu in reading view
  - embedded images
- Supports common vault image formats:
  - png
  - jpg / jpeg
  - gif
  - svg
  - webp
  - bmp

### Send PDFs
- Send PDF files from:
  - file menu
  - embedded PDF context menu
  - internal links

### Reading-view integration
- Adds context menu actions in rendered markdown for:
  - images
  - internal links
  - PDF embeds
  - headings
  - paragraphs / list items / blockquotes

### Live refresh
- If the currently displayed note, image, or PDF changes in the vault, the second screen refreshes automatically.

### Map-friendly rendering
- Detects markdown that only contains a `zoommap` code block
- Adds a special CSS class so map views can be centered and made non-interactive on the player screen

### Fog of War (New Feature)
- A dedicated Fog of War controller lets you mask and unmask parts of images or maps to reveal or hide information from the players.
- Credit goes to TomtheHoff for allowing me to use parts of his code: https://github.com/TomtheHoff/Obsidian_fog-of-war

## Commands

- **Open screen window**
- **Send active note to screen**
- **Send current paragraph/section to screen**
- **Close screen window**

## Settings

- **Auto-open on send**
  - Automatically opens the player-screen window when content is sent

- **Remember window placement**
  - The plugin automatically stores the last popout window position and size
  - You can reset the saved placement in settings

## Plugin API

Other plugins can send content directly to Player Screen:

### Send a note
```ts
await plugin.sendNoteByPath(path);
```

### Send markdown
```ts
await plugin.sendMarkdown(markdown, sourcePath);
```

### Send an image
```ts
await plugin.sendImageByPath(pathOrSource);
```

### Send a PDF
```ts
await plugin.sendPdfByPath(pathOrSource);
```

## 

## Intended use

This plugin is useful for:
- player-facing handouts
- second-screen maps
- scene text
- chapter intros
- images, portraits, and clues
- monster or NPC art

## Notes

- The popout is display-focused, not editor-focused
- Some platform limitations may affect exact popout window positioning
- For advanced map presentation, pair this plugin with your map plugin and send a prepared note or generated markdown block

## License
MIT