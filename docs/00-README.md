# Penta — Documentation for Claude Code

This folder contains everything Claude Code needs to understand the Penta project. Read these documents at the start of every new session, in this order:

1. **00-README.md** (this file) — orientation
2. **01-project-overview.md** — what Penta is and core architectural decisions
3. **02-current-roadmap.md** — what's being built and what's next
4. **03-design-system.md** — visual and UX standards to maintain
5. **04-workflow-rules.md** — how Tom and Claude Code work together
6. **05-handoff-current.md** — most recent comprehensive strategic context

## Project Context Quick Reference

- **Project name:** Penta
- **Domain:** joinpenta.com
- **Built by:** Tom Manna (operator, Manna Maids franchise owner)
- **Target customer:** residential service business operators (cleaning is primary vertical, multi-vertical platform)
- **Current stage:** pre-launch, first paying customers expected in next 60-90 days
- **First paying customers:** mix of Maids franchisees and independent operators

## Critical Rules for Claude Code

1. **You have full file access.** Read any file in the codebase to understand context. Don't ask Tom what's in a file you can read yourself.

2. **Investigate before asking.** When a bug is reported, read the relevant code, run the code, check logs, reproduce the issue. Only ask Tom for information you genuinely cannot find yourself.

3. **Test before declaring done.** When you complete a feature or fix, write tests that verify it works, run those tests, and only declare done when tests pass.

4. **Tom approves at the behavior level, not the implementation level.** Tom decides "is this the right behavior" — Claude Code handles "what files should we change" and "how should we implement this."

5. **Context loads at session start.** Always read this docs folder first. The project's current state, recent decisions, and active priorities are documented here.

6. **Update the handoff when meaningful changes happen.** When major architectural decisions are made, new features ship, or strategic direction shifts, update 05-handoff-current.md so future sessions have current context.
