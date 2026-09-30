# Nila V1 Implementation Plan

## Phase 1 — Bootstrap
Tauri + React + Rust, IPC, SQLite, project structure.

Exit: app launches, IPC works, DB opens.

## Phase 2 — Character Renderer
Original visual system, vector character, sizing, theme adaptation.

Exit: character works at supported sizes and DPI.

## Phase 3 — Character Engine
State machine, animation controller, expressions, interruptions.

Exit: required states work without stuck transitions.

## Phase 4 — Interaction
Hover, click, double click, dismiss, snooze, pause reactions.

## Phase 5 — Desktop Presence
Floating window, position, drag behavior, persistence, tray/menu.

## Phase 6 — Persistence
Schema, migrations, settings, reminders, history, snoozes.

## Phase 7 — Scheduler
Event-driven scheduling, recurrence, quiet hours, cooldown, limits, restart and sleep/wake recovery.

## Phase 8 — Reminder Experience
Reminder bubble, character animation, actions, reactions, test reminder.

## Phase 9 — Reminder Management
Built-in templates, custom reminder create/edit/delete/enable.

## Phase 10 — Settings
General, character, appearance, schedule, reminders, about.

## Phase 11 — macOS + Windows
Startup, menu/tray, notifications, multi-monitor, DPI, sleep/wake.

## Phase 12 — Data Operations
JSON export/import and validation.

## Phase 13 — Accessibility
Keyboard, screen readers, focus, reduced motion, scaling.

## Phase 14 — QA
Unit, integration, E2E, manual platform testing.

## Phase 15 — Release
Packaging, documentation, licensing, release checklist.
