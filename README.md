# Quinn Audio Collector

A powerful **Tampermonkey userscript** for **tryquinn.com** that automatically captures Cloudinary audio URLs, tracks metadata, and can crawl every creator profile to generate downloadable playlists.

---

## Features

### 🎵 Audio URL Capture

* Automatically intercepts audio requests from:

  * `fetch()`
  * `XMLHttpRequest`
  * `<audio>`, `<video>`, and `<source>` elements
  * DOM mutations
* Detects Cloudinary audio URLs (`mp3`, `mp4`, `aac`, `webm`, `m3u8`)
* Prevents duplicate captures

---

### 📋 Floating Control Panel

Provides a draggable floating UI with:

* 💾 Save captured links
* 🔄 Load all tracks
* 🗑 Clear captured items
* ⚡ Auto Capture Missed
* 🎯 Click & Capture Queue
* 📋 Edit Creator List
* 🕷 Crawl All Creators

Also displays:

* Number of captured tracks
* Current status
* Missed tracks that haven't been captured yet

---

## Auto Capture

Automatically:

1. Loads every track on the page.
2. Starts playback.
3. Opens the player panel.
4. Plays through the playlist.
5. Captures every audio URL.
6. Matches each URL with:

   * Track title
   * Creator name

---

## Queue Capture

Instead of using autoplay, this mode:

* Clicks every queue item
* Waits for playback
* Captures the audio
* Tags it with title and creator
* Continues until the queue is complete

Perfect for pages that don't support continuous autoplay.

---

## Crawl Every Creator

One-click crawler that can process an entire creator directory.

Workflow:

1. Scan the `/creators` page
2. Build a creator list
3. Visit each creator
4. Load every track
5. Capture every audio URL
6. Save a text file for that creator
7. Continue to the next creator automatically

The crawl survives page navigation using `localStorage`.

---

## Creator List Editor

Before crawling you can:

* Scan creators
* Enable/disable specific creators
* Select All
* Select None
* Rescan the page

Only enabled creators are included in the crawl.

---

## Missed Track Detection

The script compares:

* All tracks found on the page
* All successfully captured audio URLs

Anything missing is shown inside the floating panel so it can be captured later.

---

## Export Format

Downloads are saved as plain text.

Example:

```text
https://example.cloudinary.com/audio.mp4 -n morning meditation by quinn.mp3
https://example.cloudinary.com/audio2.mp4 -n deep sleep by quinn.mp3
```

Each creator is saved as:

```text
creator-name.txt
```

---

## Installation

1. Install **Tampermonkey**
2. Create a new userscript
3. Paste the script
4. Save
5. Visit:

```
https://www.tryquinn.com
```

---

## Supported Pages

* Home
* Creator pages
* Audio pages
* `/creators`

---

## Menu Commands

Tampermonkey menu includes:

* Show collected links
* Save as `.txt`
* Clear log
* Count captured audio
* Load all & scan page titles
* Edit creator list
* Clear creator list
* Stop crawl

---

## How Crawling Works

```
Open /creators
        │
        ▼
Scan creator list
        │
        ▼
Choose creators
        │
        ▼
Start Crawl
        │
        ▼
Visit creator
        │
        ▼
Load all tracks
        │
        ▼
Capture queue
        │
        ▼
Save creator.txt
        │
        ▼
Next creator
        │
        ▼
Repeat until finished
```

---

## Requirements

* Chrome/Edge/Firefox
* Tampermonkey
* Logged into tryquinn.com

---

## Notes

* Duplicate URLs are ignored automatically.
* Crawls can be stopped and resumed safely.
* Downloads use browser blob downloads to preserve filenames.
* Creator selection is stored locally between sessions.
* No external services or APIs are required.
