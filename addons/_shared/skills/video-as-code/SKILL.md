---
name: video-as-code
description: Make a short video as source code: a VHS tape for a terminal demo or a Remotion composition for anything visual.
---
Source: ~/.claude/skills/remotion-video-creation/SKILL.md (2026-10-18), rated 4/5 (the highest-rated Remotion source; the 5/5 video skills target a different framework).
License: not stated in the source definition; no redistribution grant inferred.
What changed: kept composition-first structure and frame-based timing; added the terminal-demo path (VHS); rendering only with tools already installed, never installing them.

A CLI or TUI is best shown as a terminal demo: a .tape file that types real commands at a readable pace with sleeps after output. Anything visual is a Remotion composition: fixed width, height and fps, every animation driven by the frame number, assets local. Keep it short (under 60 seconds) with one message. Put everything under out/video/. Render only if vhs or the project's Remotion is installed; otherwise say exactly what to install and the command that renders it.
