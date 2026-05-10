# Penta — Workflow Rules

## How Tom and Claude Code Work Together

### Strategic vs Tactical Separation

**Strategic conversations happen in Claude.ai (separate project, not here):**
- What to build and why
- Pricing, positioning, market strategy
- Customer conversations, meeting prep
- Roadmap decisions
- Documents and rollups

**Tactical execution happens in Claude Code (here):**
- Writing code
- Bug investigation and fixing
- Testing implementation
- Refactoring
- Running tests
- Git commits
- Anything involving actual files

When Tom arrives with a feature spec from Claude.ai, Claude Code's job is to build it correctly and confirm it works. Tom doesn't return to Claude.ai for build work until the feature is shipped.

## Claude Code Permission and Operating Style

### What You Are Authorized to Do Without Asking

- Read any file in the codebase to understand context
- Search for code patterns across files
- Run code to reproduce issues
- Run tests
- Check logs, console output, terminal errors
- Make changes to files
- Write tests for features
- Iterate until work is correct
- Make small judgment calls on implementation details (file naming, code organization, similar patterns)

### What to Ask Tom About

- Behavior decisions ("should this feature do X or Y when the user...")
- Architectural changes that affect multiple parts of the system
- New dependencies or technology choices
- UI/UX design decisions that aren't obviously following the design system
- Anything that would affect the strategic direction

### How to Communicate Progress

When you complete work:
- Tell Tom what was done in plain language
- Mention which files were changed
- Confirm tests pass (don't declare done if tests fail)
- Flag anything Tom should be aware of (unexpected discoveries, related issues spotted)
- Ask for verification at the behavior level, not the implementation level

When you hit a problem:
- Investigate first (read files, check logs, search code)
- Try reasonable solutions
- Only escalate to Tom when you genuinely need a decision he should make
- When you do escalate, give him the specific question and the context, not the whole investigation

## Bug-Fixing Protocol

This is the workflow that should compress bug-fixing time dramatically.

### When Tom Reports a Bug

1. **Read related files yourself.** Don't ask Tom which files are involved. Find them.

2. **Reproduce the issue.** Run the code, check what happens, see the actual behavior versus expected.

3. **Investigate thoroughly.** Check logs, trace execution, look at related code that might be affected.

4. **Identify root cause.** Don't just fix the symptom — understand why it happened.

5. **Make the fix.** Edit the relevant files.

6. **Write or update tests.** Verify the fix works and prevents regression.

7. **Run all related tests.** Confirm nothing else broke.

8. **Report back.** Tell Tom what was wrong, what you changed, and that tests pass.

### What Not to Do

- Don't ask Tom for console output you can produce yourself by running the code
- Don't ask Tom which file the bug is in if you can find it by searching
- Don't make a fix without verifying it actually fixes the bug
- Don't declare done without running tests
- Don't make multiple small fixes when the root cause is upstream — fix at the right level

## Feature Building Protocol

### When Tom Provides a Feature Spec

1. **Read the spec carefully.** Understand what's being built and why.

2. **Read related existing code.** Understand how this feature integrates with what exists.

3. **Plan the implementation.** Identify files that need to change, new files to create, dependencies between changes.

4. **Build incrementally if the feature is large.** Get the core working first, then add edge cases.

5. **Write tests as you go.** Each piece of functionality should have tests verifying it works.

6. **Test thoroughly before declaring done.** Run all tests, manually verify the happy path works.

7. **Report what was built.** Tell Tom what the feature does, where the code lives, how to test it.

### Definition of Done

A feature is done when:
- All acceptance criteria from the spec are met
- Tests are written for the feature
- All tests pass
- The feature works when manually exercised
- No existing functionality is broken (regression tests pass)
- The code follows existing patterns in the codebase

## Testing Standards

### Required for Every Feature

- End-to-end tests for primary user workflows (Playwright)
- Unit tests for non-trivial functions (Jest or Vitest)
- Tests are run before declaring done

### Test Naming and Organization

- Tests live alongside the code they test, in `__tests__` folders or `.test.ts` files
- Test names describe the behavior being verified
- Tests are independent (no test depends on another test's state)

### What Tests Should Cover

- Happy path (the feature works as designed when used correctly)
- Common error cases (invalid input, missing data, network errors)
- Edge cases (empty states, maximum values, concurrent operations)

### What Tests Don't Need to Cover

- Visual styling (that's manual review)
- Subjective UX decisions (that's Tom's call)
- Third-party services (mock those)

## Code Quality Standards

- Follow existing patterns in the codebase
- Readable code over clever code
- Comments only when the why isn't obvious from the code
- TypeScript types where they exist, don't introduce `any` casually
- Component files stay focused — split when they get large
- Name things clearly

## Git Workflow

- Each feature gets its own branch off main
- Commit messages describe what changed
- Push when feature is complete and tested
- Tom handles merging to main

## Communication Style with Tom

- Direct and concise
- Avoid asking "should I..." for things you have permission to decide
- When asking for decisions, present the question with context, not the whole investigation
- Confirm completion with what was done, not just "done"
- Flag unexpected discoveries that affect strategy

## What to Update in the Docs Folder

When changes happen that affect future sessions, update the docs folder:

- **02-current-roadmap.md** — when priorities shift, features ship, or new priorities emerge
- **05-handoff-current.md** — major strategic decisions, customer milestones, architectural changes
- Don't update **01-project-overview.md** unless something foundational changes
- Don't update **03-design-system.md** unless design system itself evolves
- Don't update **04-workflow-rules.md** unless workflow itself changes

Update these files yourself when you make changes that warrant documentation. Future sessions need to know what changed.
