# Nila Scheduler

The scheduler is deterministic and local. It must not depend on a network service or LLM.

## Principles
- event-driven
- persistent
- restart-safe
- sleep/wake aware
- timezone aware
- quiet-hours aware
- cooldown aware
- daily-limit aware
- non-spamming

## Event loop

Do not poll once per second.

1. query enabled reminders
2. calculate next eligible occurrence
3. wait until deadline
4. wake
5. re-read relevant state
6. validate eligibility
7. trigger
8. persist result
9. calculate next deadline

## Eligibility

Check:
1. enabled
2. global pause
3. quiet hours
4. daily limit
5. cooldown
6. schedule validity
7. snooze state
8. duplicate prevention

## Sleep/wake

On wake:
- determine elapsed time
- recalculate schedules
- do not replay every missed reminder
- choose next valid occurrence

## Clock changes

Recalculate after forward/backward jumps and timezone changes.

## History

Minimal local history:
- reminder id
- occurrence time
- action

Actions:
shown, dismissed, snoozed, completed, skipped

## Snooze

Must survive restart.

## Testing invariants

- disabled reminders never trigger
- quiet-hours reminders do not trigger in quiet hours
- cooldown is not violated
- daily limit is not exceeded
- restart does not duplicate
- sleep/wake does not create a notification burst
