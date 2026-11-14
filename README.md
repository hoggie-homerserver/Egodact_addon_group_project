# Egodact Addon: Group Project

Shared task checklists (with subtasks, assignees, roles, deadlines and progress) for Egodact challenges that have at least two members.

## Features
- Only challenges with **2+ members** are shown.
- Any member can create/edit/delete tasks, assign members, add subtasks.
- Status (Te doen / Bezig / Klaar / Geblokkeerd), priority, deadline.
- Per-challenge roles (Leider, Schrijver, ...) and a project goal.
- "Mijn taken" tab: all tasks assigned to you across projects, sorted by deadline.
- Live sync via Firebase Firestore (reuses the Egodact Chat project).
- Local demo mode (localStorage + BroadcastChannel) when Firebase is not configured.
- Entry via hamburger menu ("Groepsprojecten") and shortcut `F10`.

## Install
1. Load the Egodact host extension first.
2. Load this folder as an unpacked extension in Chrome/Edge (developer mode).
3. Open app.egodact.com and use the hamburger menu.

## Firebase
Uses the same Firebase project as the Egodact Chat addon. Enable Anonymous auth and publish `firestore.rules`.

## Files
manifest.json, sdk.js, lib.js, config.js, background.js, content.js, js/transport.js, js/store.js, vendor/*, firestore.rules.