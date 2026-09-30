# Nila — Agent Instructions

Nila is an original open-source desktop companion focused on gentle reminders and a mandatory animated visual character.

## Non-negotiable V1 constraints
- Malayalam-only application UI.
- Character/visual companion is the core product and is mandatory.
- No localization framework in V1.
- No privacy center in V1.
- No analytics/telemetry in V1.
- No accounts, authentication, cloud backend, or mandatory internet.
- No AI/LLM dependency.
- macOS and Windows first.
- Original visual identity only; do not copy proprietary artwork, character design, animations, logos, sounds, or source code.

## Priorities
1. Character quality and animation system.
2. Desktop presence and reminder interaction.
3. Reliable local reminder scheduler.
4. Small polished settings UI.
5. Reliability, accessibility, and performance.

## Working rules
- Inspect the repository before changing architecture or files.
- Implement real functionality; do not leave fake/demo APIs.
- Work incrementally and verify every phase.
- Run relevant tests/builds after changes.
- Preserve working code.
- Keep native functionality behind platform abstractions where practical.
- Never use continuous high-frequency polling for scheduling.
- Never spam reminders.
- Respect reduced-motion settings.
- Validate imported data and IPC inputs.
- Keep essential data local.

See docs/MASTER_AGENT_PROMPT.md for the full specification.
